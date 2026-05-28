#!/usr/bin/env node
// MemoryThreads — interactive TUI thread launcher
// Reads saved_threads, lets you arrow-key-pick one, then `claude --resume <session_id>` in the right cwd

const Database = require("better-sqlite3");
const { spawn } = require("child_process");
const { join } = require("path");
const { homedir } = require("os");

const DB_PATH = join(homedir(), ".claude", "memory-server", "data", "memory.db");

function loadThreads() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT s.name, s.thread_id, s.session_id, s.project_path, s.note, s.saved_at, s.last_resumed_at,
           t.source_kind, t.source_session_id, t.canonical_thread_id, t.turn_count
    FROM saved_threads s
    LEFT JOIN threads t ON t.id = s.thread_id
    ORDER BY COALESCE(s.last_resumed_at, s.saved_at) DESC
  `).all();
  db.close();
  return rows;
}

function deleteThread(name) {
  const db = new Database(DB_PATH);
  db.prepare("DELETE FROM saved_threads WHERE name = ?").run(name);
  db.close();
}

function markResumed(name) {
  const db = new Database(DB_PATH);
  db.prepare("UPDATE saved_threads SET last_resumed_at = datetime('now') WHERE name = ?").run(name);
  db.close();
}

function activateCodex(sel) {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS active_memory_threads (
      app TEXT NOT NULL,
      cwd TEXT NOT NULL,
      canonical_thread_id TEXT NOT NULL,
      saved_name TEXT,
      source_session_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (app, cwd)
    );
  `);
  db.prepare(`
    INSERT INTO active_memory_threads
      (app, cwd, canonical_thread_id, saved_name, source_session_id, updated_at)
    VALUES ('codex', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(app, cwd) DO UPDATE SET
      canonical_thread_id = excluded.canonical_thread_id,
      saved_name = excluded.saved_name,
      source_session_id = excluded.source_session_id,
      updated_at = datetime('now')
  `).run(
    sel.project_path || process.cwd(),
    sel.canonical_thread_id || sel.thread_id,
    sel.name,
    sel.source_session_id || sel.session_id
  );
  db.close();
}

function fmtDate(s) {
  if (!s) return "";
  return s.split("T")[0] || s.split(" ")[0] || s;
}

function render(threads, idx) {
  const out = [];
  out.push("\x1b[2J\x1b[H"); // clear screen + home cursor
  out.push("\x1b[1mMemoryThreads — pick a session to resume\x1b[0m\n");
  out.push("\x1b[2m↑↓ navigate  ⏎ resume  d delete  q quit\x1b[0m\n\n");
  if (threads.length === 0) {
    out.push("  No saved threads. Use `/mt-save <name>` in Claude to bookmark this session.\n");
  } else {
    const maxNameLen = Math.max(...threads.map(t => t.name.length));
    threads.forEach((t, i) => {
      const cursor = i === idx ? "\x1b[36m❯\x1b[0m " : "  ";
      const nameStr = i === idx ? `\x1b[1;36m${t.name.padEnd(maxNameLen)}\x1b[0m` : t.name.padEnd(maxNameLen);
      const date = fmtDate(t.last_resumed_at || t.saved_at);
      const project = t.project_path ? ` \x1b[2m${t.project_path.replace(homedir(), "~")}\x1b[0m` : "";
      const kind = t.source_kind || "unknown";
      const turns = String(t.turn_count || 0).padStart(4);
      out.push(`${cursor}${nameStr}  \x1b[2m${date} ${kind} ${turns} turns\x1b[0m${project}\n`);
    });
  }
  process.stdout.write(out.join(""));
}

let threads = loadThreads();
let idx = 0;

if (threads.length === 0) {
  render(threads, 0);
  console.log("\nExiting.");
  process.exit(0);
}

if (!process.stdin.isTTY) {
  console.error("mt launch requires an interactive terminal.");
  process.exit(1);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

render(threads, idx);

process.stdin.on("data", (key) => {
  // Ctrl+C
  if (key === "" || key === "q") {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdin.setRawMode(false);
    process.exit(0);
  }
  // Up arrow (\x1b[A) or k
  if (key === "\x1b[A" || key === "k") {
    idx = (idx - 1 + threads.length) % threads.length;
    render(threads, idx);
    return;
  }
  // Down arrow (\x1b[B) or j
  if (key === "\x1b[B" || key === "j") {
    idx = (idx + 1) % threads.length;
    render(threads, idx);
    return;
  }
  // Enter — resume selected thread
  if (key === "\r" || key === "\n") {
    const sel = threads[idx];
    if (!sel) return;
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdin.setRawMode(false);
    process.stdin.pause();
    markResumed(sel.name);
    if ((sel.source_kind || "") === "codex") {
      activateCodex(sel);
      console.log(`\x1b[36mActivated "${sel.name}" for Codex Desktop memory in ${sel.project_path || process.cwd()}\x1b[0m\n`);
      process.exit(0);
    }
    console.log(`\x1b[36m▶ Resuming "${sel.name}" (${sel.session_id}) in ${sel.project_path}\x1b[0m\n`);
    const child = spawn("claude", ["--resume", sel.session_id], {
      cwd: sel.project_path || process.cwd(),
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code || 0));
    child.on("error", (err) => { console.error(`Failed to launch claude: ${err.message}`); process.exit(1); });
    return;
  }
  // d — delete selected
  if (key === "d") {
    const sel = threads[idx];
    if (!sel) return;
    deleteThread(sel.name);
    threads = loadThreads();
    if (idx >= threads.length) idx = Math.max(0, threads.length - 1);
    render(threads, idx);
    return;
  }
});

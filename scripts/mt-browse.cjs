#!/usr/bin/env node
// MemoryThreads — `mt browse`: TUI to browse ALL threads (not just saved bookmarks)
// Sortable by recency, filterable by project, resumable via Enter

const Database = require("better-sqlite3");
const { spawn } = require("child_process");
const { join } = require("path");
const { homedir } = require("os");
const { readFileSync, existsSync } = require("fs");
const { createInterface } = require("readline");

const DB_PATH = join(homedir(), ".claude", "memory-server", "data", "memory.db");
const PAGE_SIZE = 20;

let projectFilter = null; // null = all projects
let sortMode = "recent"; // "recent" | "size"
let cursor = 0;
let pageStart = 0;
let threads = [];
let projects = [];

function loadData() {
  const db = new Database(DB_PATH, { readonly: true });
  let sql = `
    SELECT t.id, t.project, t.project_name, t.turn_count, t.timestamp_end, t.source_file,
           t.source_kind, t.source_session_id, t.canonical_thread_id,
           (SELECT name FROM saved_threads WHERE thread_id = t.id LIMIT 1) AS bookmark
    FROM threads t
  `;
  const params = [];
  if (projectFilter) {
    sql += " WHERE t.project_name = ?";
    params.push(projectFilter);
  }
  if (sortMode === "recent") {
    sql += " ORDER BY t.timestamp_end DESC NULLS LAST";
  } else {
    sql += " ORDER BY t.turn_count DESC";
  }
  threads = db.prepare(sql).all(...params);
  projects = db.prepare("SELECT project_name, COUNT(*) AS n FROM threads WHERE project_name IS NOT NULL GROUP BY project_name ORDER BY 2 DESC").all();
  db.close();
}

// Extract session_id from source_file path
//   project file: <dir>/<sessionid>.jsonl              → returns sessionid
//   snapshot:     <dir>/<timestamp>-<sessionid>.jsonl  → returns sessionid (strips numeric prefix)
function deriveSessionId(sourceFile) {
  if (!sourceFile) return null;
  const base = sourceFile.split("/").pop().replace(/\.jsonl$/, "");
  // Snapshot pattern: 1234567890-<uuid>
  const snapMatch = base.match(/^\d+-(.+)$/);
  return snapMatch ? snapMatch[1] : base;
}

function activateCodexThread(sel, cwd) {
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
    cwd || process.cwd(),
    sel.canonical_thread_id || sel.id,
    sel.bookmark || null,
    sel.source_session_id || deriveSessionId(sel.source_file)
  );
  db.close();
}

// Read the first cwd from a JSONL — needed because project_name in the threads
// table is URL-encoded with dashes that lose the original path structure
function deriveCwd(sourceFile, projectName) {
  if (sourceFile && existsSync(sourceFile)) {
    try {
      const text = readFileSync(sourceFile, "utf-8");
      for (const line of text.split("\n").slice(0, 50)) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r.cwd) return r.cwd;
        } catch {}
      }
    } catch {}
  }
  // Fallback: best-effort decode of project_name (replace - with /)
  if (projectName && projectName.startsWith("-")) {
    return "/" + projectName.slice(1).replace(/-/g, "/");
  }
  return null;
}

function fmtDate(s) {
  if (!s) return "?";
  return s.split("T")[0] || s.split(" ")[0] || s;
}

function shortProject(name) {
  if (!name) return "(unknown)";
  return name.replace(/^-Users-[^-]+-/, "~/").slice(-40);
}

function render() {
  const out = [];
  out.push("\x1b[2J\x1b[H");
  out.push(`\x1b[1mMemoryThreads — browse all threads\x1b[0m  \x1b[2m(${threads.length} threads`);
  if (projectFilter) out.push(` · filtered: ${shortProject(projectFilter)}`);
  out.push(` · sort: ${sortMode})\x1b[0m\n`);
  out.push("\x1b[2m↑↓ jk navigate · ⏎ resume · p cycle project · s sort · / clear filter · q quit\x1b[0m\n\n");

  if (threads.length === 0) {
    out.push("  No threads.\n");
    process.stdout.write(out.join(""));
    return;
  }

  pageStart = Math.max(0, Math.min(pageStart, threads.length - PAGE_SIZE));
  if (cursor < pageStart) pageStart = cursor;
  if (cursor >= pageStart + PAGE_SIZE) pageStart = cursor - PAGE_SIZE + 1;

  const visible = threads.slice(pageStart, pageStart + PAGE_SIZE);
  visible.forEach((t, i) => {
    const realIdx = pageStart + i;
    const isCursor = realIdx === cursor;
    const cur = isCursor ? "\x1b[36m❯\x1b[0m " : "  ";
    const date = fmtDate(t.timestamp_end);
    const turnsStr = String(t.turn_count || 0).padStart(5);
    const proj = shortProject(t.project_name).padEnd(42);
    const kind = String(t.source_kind || "unknown").padEnd(7);
    const bm = t.bookmark ? `\x1b[1;33m📌 ${t.bookmark}\x1b[0m ` : "";
    const main = `${date}  ${turnsStr} turns  ${kind}  ${proj}  ${bm}`;
    if (isCursor) {
      out.push(`${cur}\x1b[1;36m${main}\x1b[0m\n`);
    } else {
      out.push(`${cur}${main}\n`);
    }
  });

  out.push(`\n\x1b[2m  Showing ${pageStart + 1}-${Math.min(pageStart + PAGE_SIZE, threads.length)} of ${threads.length}\x1b[0m\n`);
  process.stdout.write(out.join(""));
}

async function pickProject() {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\x1b[2J\x1b[H\x1b[1mPick project filter:\x1b[0m\n\n");
  console.log(`  0) (clear filter — show all)`);
  projects.slice(0, 30).forEach((p, i) => {
    console.log(`  ${i + 1}) ${shortProject(p.project_name).padEnd(42)} ${String(p.n).padStart(4)} threads`);
  });
  process.stdout.write("\nEnter number: ");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const choice = await new Promise(res => rl.question("", a => { rl.close(); res(a); }));
  const n = parseInt(choice, 10);
  if (!isNaN(n)) {
    if (n === 0) projectFilter = null;
    else if (n >= 1 && n <= projects.length) projectFilter = projects[n - 1].project_name;
  }
  cursor = 0;
  pageStart = 0;
  loadData();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  render();
}

loadData();

if (!process.stdin.isTTY) {
  console.error("mt browse requires an interactive terminal.");
  process.exit(1);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
render();

process.stdin.on("data", async (key) => {
  if (key === "" || key === "q") {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdin.setRawMode(false);
    process.exit(0);
  }
  if (key === "\x1b[A" || key === "k") { cursor = Math.max(0, cursor - 1); render(); return; }
  if (key === "\x1b[B" || key === "j") { cursor = Math.min(threads.length - 1, cursor + 1); render(); return; }
  if (key === "\x1b[5~") { cursor = Math.max(0, cursor - PAGE_SIZE); render(); return; } // PgUp
  if (key === "\x1b[6~") { cursor = Math.min(threads.length - 1, cursor + PAGE_SIZE); render(); return; } // PgDn
  if (key === "g") { cursor = 0; render(); return; }
  if (key === "G") { cursor = threads.length - 1; render(); return; }
  if (key === "p") { await pickProject(); return; }
  if (key === "/") { projectFilter = null; cursor = 0; loadData(); render(); return; }
  if (key === "s") { sortMode = sortMode === "recent" ? "size" : "recent"; cursor = 0; loadData(); render(); return; }
  if (key === "\r" || key === "\n") {
    const sel = threads[cursor];
    if (!sel) return;
    const sessionId = deriveSessionId(sel.source_file);
    const cwd = deriveCwd(sel.source_file, sel.project_name);
    if ((sel.source_kind || "") === "codex") {
      activateCodexThread(sel, cwd);
      process.stdout.write("\x1b[2J\x1b[H");
      process.stdin.setRawMode(false);
      process.stdin.pause();
      console.log(`\x1b[36mActivated Codex memory thread ${sel.canonical_thread_id || sel.id}${cwd ? ` in ${cwd}` : ""}\x1b[0m\n`);
      process.exit(0);
    }
    if (!sessionId) {
      process.stdout.write("\n\x1b[31mCould not derive session_id from source_file.\x1b[0m\n");
      return;
    }
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdin.setRawMode(false);
    process.stdin.pause();
    console.log(`\x1b[36m▶ Resuming thread ${sel.id} (session ${sessionId})${cwd ? ` in ${cwd}` : ""}\x1b[0m\n`);
    const child = spawn("claude", ["--resume", sessionId], {
      cwd: cwd || process.cwd(),
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code || 0));
    child.on("error", (err) => { console.error(`Failed to launch claude: ${err.message}`); process.exit(1); });
    return;
  }
});

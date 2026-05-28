#!/usr/bin/env node
// MemoryThreads — interactive TUI thread launcher (TMUX mode)
// Same picker as mt-launch.cjs, but on select it opens the thread INSIDE a tmux
// session (named after the thread) so it is live and joinable from any device.
//   - if a tmux session for that thread already exists -> attach/switch to it
//   - otherwise -> create it running `claude --resume <session_id>` then attach

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

function fmtDate(s) {
  if (!s) return "";
  return s.split("T")[0] || s.split(" ")[0] || s;
}

// tmux session names cannot contain dots, colons or spaces
function tmuxSafe(name) {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

function render(threads, idx) {
  const out = [];
  out.push("\x1b[2J\x1b[H"); // clear screen + home cursor
  out.push("\x1b[1mMemoryThreads — pick a thread to open in tmux (live + joinable)\x1b[0m\n");
  out.push("\x1b[2m↑↓ navigate  ⏎ open in tmux  d delete  q quit\x1b[0m\n\n");
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
  console.error("mt launch tmux requires an interactive terminal.");
  process.exit(1);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

render(threads, idx);

process.stdin.on("data", (key) => {
  // Ctrl+C or q
  if (key === "" || key === "q") {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdin.setRawMode(false);
    process.exit(0);
  }
  // Up arrow or k
  if (key === "\x1b[A" || key === "k") {
    idx = (idx - 1 + threads.length) % threads.length;
    render(threads, idx);
    return;
  }
  // Down arrow or j
  if (key === "\x1b[B" || key === "j") {
    idx = (idx + 1) % threads.length;
    render(threads, idx);
    return;
  }
  // Enter — open selected thread in tmux
  if (key === "\r" || key === "\n") {
    const sel = threads[idx];
    if (!sel) return;
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdin.setRawMode(false);
    process.stdin.pause();
    markResumed(sel.name);

    if ((sel.source_kind || "") === "codex") {
      console.log(`\x1b[33m"${sel.name}" is a Codex thread - tmux live-attach only works for Claude Code threads. Use \`mt launch\` for this one.\x1b[0m\n`);
      process.exit(0);
    }

    const name = tmuxSafe(sel.name);
    const dir = sel.project_path || process.cwd();
    const sid = sel.session_id;

    console.log(`\x1b[36m▶ Opening "${sel.name}" in tmux session "${name}" (live, joinable from any device)…\x1b[0m\n`);

    // create-if-missing then attach (or switch-client if we're already inside tmux)
    const script = [
      'set -e',
      'CLAUDE_BIN="$(command -v claude || echo "$HOME/.local/bin/claude")"',
      '# If a tmux session for this thread already exists but is resuming a DIFFERENT claude',
      '# session than the bookmark now points to (e.g. the bookmark was repointed), kill it',
      '# and recreate against the correct session - otherwise we reattach to a stale resume.',
      'if tmux has-session -t "$MT_NAME" 2>/dev/null; then',
      '  EXIST_SID="$(tmux show-options -t "$MT_NAME" -v @mt_sid 2>/dev/null || true)"',
      '  if [ "$EXIST_SID" != "$MT_SID" ]; then',
      '    tmux kill-session -t "$MT_NAME" 2>/dev/null || true',
      '  fi',
      'fi',
      'if ! tmux has-session -t "$MT_NAME" 2>/dev/null; then',
      '  tmux new-session -d -s "$MT_NAME" -c "$MT_DIR" "caffeinate -dims \\"$CLAUDE_BIN\\" --resume $MT_SID; exec $SHELL -l"',
      '  tmux set-option -t "$MT_NAME" @mt_sid "$MT_SID"',
      'fi',
      'if [ -n "$TMUX" ]; then',
      '  tmux switch-client -t "$MT_NAME"',
      'else',
      '  tmux attach -t "$MT_NAME"',
      'fi',
    ].join("\n");

    const child = spawn("bash", ["-c", script], {
      stdio: "inherit",
      env: { ...process.env, MT_NAME: name, MT_DIR: dir, MT_SID: sid },
    });
    child.on("exit", (code) => process.exit(code || 0));
    child.on("error", (err) => { console.error(`Failed to open tmux: ${err.message}`); process.exit(1); });
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

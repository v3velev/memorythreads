#!/usr/bin/env node
// MemoryThreads health check. Surfaces the class of silent failures that can
// otherwise pile up unnoticed (worker down, job backlog, failed jobs, embeddings
// behind, broken wiring). Exits non-zero if any check FAILs.
//
// Run: node scripts/doctor.cjs   (or: mt doctor)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const HOME = os.homedir();
const DIR = path.join(HOME, ".claude", "memory-server");
const DB_PATH = process.env.MEMORY_DB_PATH || path.join(DIR, "data", "memory.db");

let worst = 0; // 0 ok, 1 warn, 2 fail
const C = { ok: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m", dim: "\x1b[2m", off: "\x1b[0m" };
function line(level, name, msg, hint) {
  worst = Math.max(worst, level === "fail" ? 2 : level === "warn" ? 1 : 0);
  const mark = level === "ok" ? "✓" : level === "warn" ? "!" : "✗";
  console.log(`${C[level]}${mark}${C.off} ${name.padEnd(22)} ${msg}${hint ? `\n  ${C.dim}↳ ${hint}${C.off}` : ""}`);
}
function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }
function cmd(c) { return execSync(c, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }

console.log("MemoryThreads doctor\n");

// 1. Node
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
line(nodeMajor >= 18 ? "ok" : "fail", "node", `v${process.versions.node}`, nodeMajor >= 18 ? "" : "need Node 18.18+");

// 2. .env / mode
const envPath = path.join(DIR, ".env");
const env = safe(() => fs.readFileSync(envPath, "utf8"), "");
const sqliteOnly = /^SQLITE_ONLY\s*=\s*true/im.test(env) || (process.env.SQLITE_ONLY || "").toLowerCase() === "true";
if (sqliteOnly) line("ok", "mode", "SQLITE_ONLY (BM25 only, no embedding API)");
else if (/^OPENAI_API_KEY=.+/m.test(env)) line("ok", "openai key", ".env has OPENAI_API_KEY");
else line("fail", "openai key", "missing", `add it: echo 'OPENAI_API_KEY=sk-...' >> ${envPath}  (or set SQLITE_ONLY=true)`);

// 3. DB + integrity
let db = null;
if (!fs.existsSync(DB_PATH)) {
  line("fail", "database", "not found", "start the worker/server once to create it");
} else {
  try {
    const Database = require("better-sqlite3");
    db = new Database(DB_PATH, { readonly: true, timeout: 4000 });
    const qc = db.prepare("PRAGMA quick_check").get();
    const okc = Object.values(qc)[0];
    line(okc === "ok" ? "ok" : "fail", "db integrity", `quick_check=${okc}`);
  } catch (e) {
    line("fail", "database", `open failed: ${e.message}`);
  }
}

if (db) {
  // 4. Core tables
  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  const need = ["threads", "turns", "turns_fts", "docs", "saved_threads", "active_memory_threads", "jobs"];
  const missing = need.filter(t => !have.has(t));
  const hasVec = have.has("turn_embeddings");
  line(missing.length ? "fail" : "ok", "core tables", missing.length ? `missing: ${missing.join(",")}` : `all present${hasVec ? " (+turn_embeddings)" : ""}`,
    missing.length ? "restart the server/worker to run ensureCanonicalSchema" : "");

  // 5. Job backlog + failures
  const jobs = safe(() => Object.fromEntries(db.prepare("SELECT status, COUNT(*) c FROM jobs GROUP BY status").all().map(r => [r.status, r.c])), {});
  const pending = jobs.pending || 0;
  const stuck = safe(() => db.prepare("SELECT COUNT(*) c FROM jobs WHERE status='pending' AND attempts>=3").get().c, 0);
  const failed = jobs.failed || 0;
  if (stuck > 0) line("fail", "job backlog", `${pending} pending, ${stuck} stuck (attempts>=3)`, "a bug is failing jobs - check logs/worker.log; reset with: UPDATE jobs SET attempts=0 WHERE status='pending'");
  else if (pending > 200) line("warn", "job backlog", `${pending} pending`, "worker may be behind or stopped");
  else line("ok", "job backlog", `${pending} pending${failed ? `, ${failed} failed` : ""}`);

  // 6. Embedding lag (skip meaning in SQLITE_ONLY)
  const embPending = safe(() => db.prepare("SELECT COUNT(*) c FROM turns WHERE embed_status IN ('pending','failed')").get().c, 0);
  if (sqliteOnly) line("ok", "embeddings", "N/A (SQLITE_ONLY)");
  else if (embPending > 500) line("warn", "embeddings", `${embPending} turns unembedded`, "vector recall degraded for these; worker retries periodically");
  else line("ok", "embeddings", `${embPending} turns pending`);

  // 8. recall smoke (BM25 over turns - no network)
  const ftsOk = safe(() => { db.prepare("SELECT rowid FROM turns_fts WHERE turns_fts MATCH 'the' LIMIT 1").get(); return true; }, false);
  line(ftsOk ? "ok" : "warn", "recall (BM25)", ftsOk ? "turns_fts queryable" : "turns_fts query failed");

  db.close();
}

// 7. Worker process. The worker runs as `node worker.js` (relative), so match on
// "worker.js" in the command - not the absolute path, which never matches.
const pidFile = path.join(DIR, "worker.pid");
const pid = safe(() => parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10), null);
let workerUp = false;
if (pid) workerUp = /worker\.js/.test(safe(() => cmd(`ps -p ${pid} -o command=`), ""));
if (!workerUp) workerUp = safe(() => !!cmd(`pgrep -f "node worker.js"`), false);
if (fs.existsSync(path.join(DIR, ".worker-disabled")))
  line("fail", "worker", "DISABLED flag set", "clear it: rm ~/.claude/memory-server/.worker-disabled .watchdog-failures ; then: bash ~/.claude/memory-server/watchdog.sh");
else if (workerUp) line("ok", "worker", `running${pid ? ` (pid ${pid})` : ""}`);
else line("fail", "worker", "not running", "start it: bash ~/.claude/memory-server/watchdog.sh");

// 9. Hooks wired
function hooksWired(file, label) {
  if (!fs.existsSync(file)) return line("warn", label, "config not found");
  const cfg = safe(() => JSON.parse(fs.readFileSync(file, "utf8")), null);
  const s = JSON.stringify(cfg?.hooks || {});
  const wired = s.includes("memory-server/hooks/");
  line(wired ? "ok" : "warn", label, wired ? "memory hooks wired" : "memory hooks NOT wired", wired ? "" : "re-run ./install.sh");
}
hooksWired(path.join(HOME, ".claude", "settings.json"), "hooks (claude)");
if (fs.existsSync(path.join(HOME, ".codex"))) hooksWired(path.join(HOME, ".codex", "hooks.json"), "hooks (codex)");

// 10. MCP registered
const claudeJson = safe(() => fs.readFileSync(path.join(HOME, ".claude.json"), "utf8"), "");
line(/"memory"\s*:/.test(claudeJson) && /memory-server\/server\.js/.test(claudeJson) ? "ok" : "warn",
  "mcp (claude)", /memory-server\/server\.js/.test(claudeJson) ? "memory server registered" : "not registered",
  /memory-server\/server\.js/.test(claudeJson) ? "" : "claude mcp add --scope user memory node ~/.claude/memory-server/server.js");
const codexCfg = safe(() => fs.readFileSync(path.join(HOME, ".codex", "config.toml"), "utf8"), null);
if (codexCfg !== null) line(/\[mcp_servers\.memory\]/.test(codexCfg) ? "ok" : "warn", "mcp (codex)",
  /\[mcp_servers\.memory\]/.test(codexCfg) ? "registered in config.toml" : "not registered", /\[mcp_servers\.memory\]/.test(codexCfg) ? "" : "re-run ./install.sh");

// 11. launchd (macOS)
if (os.platform() === "darwin") {
  const ll = safe(() => cmd("launchctl list"), "");
  const sync = ll.includes("com.claude.memory-sync");
  const wd = ll.includes("com.claude.memory-watchdog");
  line(wd ? "ok" : "warn", "launchd watchdog", wd ? "loaded" : "not loaded", wd ? "" : "re-run ./install.sh");
  line(sync ? "ok" : "warn", "launchd sync", sync ? "loaded (watches ~/.claude/projects)" : "not loaded", sync ? "" : "re-run ./install.sh");
}

// 12. mt on PATH
line(safe(() => { cmd("command -v mt"); return true; }, false) ? "ok" : "warn", "mt cli", safe(() => cmd("command -v mt"), "not on PATH"),
  safe(() => { cmd("command -v mt"); return ""; }, "add ~/.local/bin to PATH, or re-run ./install.sh"));

const label = worst === 2 ? `${C.fail}PROBLEMS FOUND${C.off}` : worst === 1 ? `${C.warn}OK with warnings${C.off}` : `${C.ok}ALL HEALTHY${C.off}`;
console.log(`\n${label}`);
process.exit(worst === 2 ? 1 : 0);

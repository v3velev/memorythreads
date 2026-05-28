const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const Database = require("better-sqlite3");

const SERVER_DIR = path.join(os.homedir(), ".claude", "memory-server");
const DB_PATH = path.join(SERVER_DIR, "data", "memory.db");
const LOG_FILE = path.join(SERVER_DIR, "logs", "hooks.log");

function log(message) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function appFromPath(filePath) {
  const value = String(filePath || "");
  if (value.includes("/.codex/sessions/")) return "codex";
  if (value.includes("/.claude/projects/") || value.includes("/snapshots/")) return "claude";
  return "unknown";
}

function stem(filePath) {
  const base = path.basename(filePath || "");
  return base.endsWith(".jsonl") ? base.slice(0, base.length - ".jsonl".length) : base;
}

function stripSnapshotPrefix(value) {
  const firstDash = value.indexOf("-");
  if (firstDash <= 0) return value;
  const prefix = value.slice(0, firstDash);
  for (const ch of prefix) {
    if (ch < "0" || ch > "9") return value;
  }
  return value.slice(firstDash + 1);
}

function sourceSessionFromTranscript(filePath, fallback) {
  if (fallback) return fallback;
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(128 * 1024);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const lines = buffer.toString("utf8", 0, read).split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.type === "session_meta" && row.payload?.id) {
        return row.payload.id;
      }
      break;
    }
  } catch {}
  return stripSnapshotPrefix(stem(filePath));
}

function projectHash(cwd) {
  return crypto.createHash("sha256").update(cwd || "unknown").digest("hex").slice(0, 16);
}

function gitContext(cwd) {
  if (!cwd || !fs.existsSync(path.join(cwd, ".git"))) {
    return { hash: "", dir: "" };
  }
  try {
    const hash = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    return { hash, dir: cwd };
  } catch {
    return { hash: "", dir: "" };
  }
}

function queueStopJob(db, input) {
  const transcriptPath = input.transcript_path || input.transcriptPath || input.rollout_path || "";
  const cwd = input.cwd || input.project_path || "";
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;

  const sourceKind = appFromPath(transcriptPath);
  const sourceSessionId = sourceSessionFromTranscript(transcriptPath, input.session_id || input.thread_id || "");
  const git = gitContext(cwd);
  const existing = db.prepare(`
    SELECT COUNT(*) AS count
    FROM jobs
    WHERE type = 'ingest_thread'
      AND json_extract(payload, '$.transcript_path') = ?
      AND status IN ('pending', 'processing', 'done')
  `).get(transcriptPath)?.count || 0;

  const payload = {
    transcript_path: transcriptPath,
    project: projectHash(cwd),
    project_name: path.basename(cwd || "unknown"),
    git_commit_hash: git.hash,
    git_project_dir: git.dir,
    source_kind: sourceKind,
    source_session_id: sourceSessionId,
  };
  if (existing > 0) payload.is_full_session = true;

  db.prepare(`
    INSERT INTO jobs (type, payload, priority, created_at)
    VALUES ('ingest_thread', ?, 5, datetime('now'))
  `).run(JSON.stringify(payload));
  return true;
}

function readStdin() {
  return new Promise(resolve => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

async function main() {
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    const db = new Database(DB_PATH, { timeout: 3000 });
    queueStopJob(db, input);
    db.close();
  } catch (err) {
    log(`stop hook failed open: ${err.message}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { queueStopJob, appFromPath, sourceSessionFromTranscript };

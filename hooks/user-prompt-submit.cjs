const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const SERVER_DIR = path.join(os.homedir(), ".claude", "memory-server");
const DB_PATH = path.join(SERVER_DIR, "data", "memory.db");
const SEEN_DIR = path.join(SERVER_DIR, "seen");
const LOG_FILE = path.join(SERVER_DIR, "logs", "hooks.log");

function log(message) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map(row => row.name));
}

function addColumn(db, tableName, columnName, ddl) {
  const columns = tableColumns(db, tableName);
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
  }
}

function ensureCanonicalSchema(db) {
  addColumn(db, "threads", "source_kind", "source_kind TEXT NOT NULL DEFAULT 'unknown'");
  addColumn(db, "threads", "source_session_id", "source_session_id TEXT");
  addColumn(db, "threads", "canonical_thread_id", "canonical_thread_id TEXT");
  db.exec(`
    UPDATE threads
    SET canonical_thread_id = id
    WHERE canonical_thread_id IS NULL OR canonical_thread_id = '';

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
}

function appFromTranscriptPath(transcriptPath) {
  const value = String(transcriptPath || "");
  if (value.includes("/.codex/sessions/")) return "codex";
  if (value.includes("/.claude/projects/") || value.includes("/snapshots/")) return "claude";
  return "unknown";
}

function projectHash(cwd) {
  return crypto.createHash("sha256").update(cwd || "unknown").digest("hex").slice(0, 16);
}

function promptFromInput(input) {
  for (const key of ["prompt", "user_prompt", "message", "input"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function snippet(value, limit) {
  const text = String(value || "").replaceAll("\n", " ").trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit - 3) + "...";
}

function getActive(db, app, cwd) {
  if (!app || !cwd) return null;
  return db.prepare(`
    SELECT *
    FROM active_memory_threads
    WHERE app = ? AND cwd = ?
  `).get(app, cwd) || null;
}

function sessionIdFromInput(input) {
  const direct = input.session_id || input.thread_id;
  if (direct) return direct;
  const transcriptPath = input.transcript_path || input.transcriptPath || input.rollout_path || "";
  if (transcriptPath) return path.basename(transcriptPath, ".jsonl");
  return null;
}

// Resolve the active thread from the CURRENT session, not the folder. Each terminal/session
// is its own thread; injecting by folder caused different clients that share one project
// folder (e.g. Ninefold and the roofing campaign both under "GTM Revenue work") to bleed
// each other's turns into the resumed session. Session-scoping kills that cross-bleed.
function getActiveForSession(db, sessionId) {
  if (!sessionId) return null;
  const row = db.prepare(`
    SELECT canonical_thread_id
    FROM threads
    WHERE source_session_id = ?
    ORDER BY turn_count DESC, id
    LIMIT 1
  `).get(sessionId);
  if (!row || !row.canonical_thread_id) return null;
  let savedName = null;
  try {
    const saved = db.prepare(`
      SELECT s.name
      FROM saved_threads s
      LEFT JOIN threads t ON t.id = s.thread_id
      WHERE s.session_id = ? OR s.thread_id = ? OR t.canonical_thread_id = ?
      LIMIT 1
    `).get(sessionId, row.canonical_thread_id, row.canonical_thread_id);
    if (saved && saved.name) savedName = saved.name;
  } catch {}
  return {
    canonical_thread_id: row.canonical_thread_id,
    saved_name: savedName,
    source_session_id: sessionId,
  };
}

function loadRecentTurns(db, canonicalThreadId, project, limit) {
  if (canonicalThreadId) {
    return db.prepare(`
      SELECT t.turn_number, t.user_content, t.assistant_content, t.timestamp, th.id AS thread_id
      FROM turns t
      JOIN threads th ON th.id = t.thread_id
      WHERE COALESCE(th.canonical_thread_id, th.id) = ?
        AND (t.user_content IS NOT NULL OR t.assistant_content IS NOT NULL)
      ORDER BY COALESCE(t.timestamp, th.timestamp_end, th.created_at) DESC, t.turn_number DESC
      LIMIT ?
    `).all(canonicalThreadId, limit).reverse();
  }

  if (!project) return [];
  return db.prepare(`
    SELECT t.turn_number, t.user_content, t.assistant_content, t.timestamp, th.id AS thread_id
    FROM turns t
    JOIN threads th ON th.id = t.thread_id
    WHERE th.project = ?
      AND (t.user_content IS NOT NULL OR t.assistant_content IS NOT NULL)
    ORDER BY COALESCE(t.timestamp, th.timestamp_end, th.created_at) DESC, t.turn_number DESC
    LIMIT ?
  `).all(project, limit).reverse();
}

function tokenizeQuery(text) {
  const tokens = [];
  let current = "";
  for (const ch of String(text || "").toLowerCase()) {
    const isLetter = ch >= "a" && ch <= "z";
    const isDigit = ch >= "0" && ch <= "9";
    const isUnderscore = ch === "_";
    if (isLetter || isDigit || isUnderscore) {
      current += ch;
    } else if (current) {
      if (current.length >= 3) tokens.push(current);
      current = "";
    }
  }
  if (current.length >= 3) tokens.push(current);
  return [...new Set(tokens)].slice(0, 10);
}

function searchRelevantTurns(db, prompt, active, project, limit) {
  const tokens = tokenizeQuery(prompt);
  if (tokens.length === 0) return [];
  const query = tokens.join(" OR ");

  try {
    let sql = `
      SELECT t.turn_number, t.user_content, t.assistant_content, t.timestamp, th.id AS thread_id, rank
      FROM turns_fts
      JOIN turns t ON turns_fts.rowid = t.id
      JOIN threads th ON th.id = t.thread_id
      WHERE turns_fts MATCH ?
    `;
    const params = [query];
    if (active?.canonical_thread_id) {
      sql += " AND COALESCE(th.canonical_thread_id, th.id) = ?";
      params.push(active.canonical_thread_id);
    } else if (project) {
      sql += " AND th.project = ?";
      params.push(project);
    }
    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);
    return db.prepare(sql).all(...params);
  } catch (err) {
    log(`memory search skipped: ${err.message}`);
    return [];
  }
}

function formatTurns(turns, label) {
  if (!turns.length) return "";
  const lines = [label];
  for (const turn of turns) {
    if (turn.user_content) lines.push(`  [user ${turn.turn_number}] ${snippet(turn.user_content, 220)}`);
    if (turn.assistant_content) lines.push(`  [assistant ${turn.turn_number}] ${snippet(turn.assistant_content, 220)}`);
  }
  return lines.join("\n");
}

function readTail(filePath, maxBytes) {
  try {
    const stat = fs.statSync(filePath);
    const size = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, stat.size - size);
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

function compactMarkerCountFromTail(transcriptPath, app) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;
  const text = readTail(transcriptPath, 1024 * 1024);
  if (!text) return 0;
  let count = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (app === "codex") {
      if (row.type === "compacted") count++;
      if (row.payload?.type === "context_compacted") count++;
      continue;
    }
    if (row.type === "summary" || row.type === "compact" || row.type === "compaction") count++;
    const content = row.message?.content;
    if (typeof content === "string" && content.includes("This session is being continued from a previous conversation")) {
      count++;
    }
  }
  return count;
}

function hasNewCompactMarker(input, app) {
  const transcriptPath = input.transcript_path || input.transcriptPath || input.rollout_path || "";
  const sessionId = input.session_id || input.thread_id || path.basename(transcriptPath || "unknown", ".jsonl");
  const count = compactMarkerCountFromTail(transcriptPath, app);
  if (count <= 0) return false;

  fs.mkdirSync(SEEN_DIR, { recursive: true });
  const marker = path.join(SEEN_DIR, `compaction-${sessionId}`);
  let seen = 0;
  try {
    const raw = fs.readFileSync(marker, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) seen = parsed;
  } catch {}

  if (count > seen) {
    try {
      fs.writeFileSync(marker, String(count));
    } catch {}
    return true;
  }
  return false;
}

function buildRecoveryContext(db, input, active, project) {
  const sessionId = input.session_id || input.thread_id || null;
  let buffer = null;
  if (sessionId) {
    buffer = db.prepare(`
      SELECT content
      FROM recovery_buffer
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sessionId)?.content || null;
  }

  const turns = loadRecentTurns(db, active?.canonical_thread_id || null, project, 20);
  if (!buffer && turns.length === 0) return "";

  const lines = [
    "<memorythreads-compaction-recovery>",
    "Compaction was detected. Use this recovered MemoryThreads context before continuing.",
  ];
  if (active?.canonical_thread_id) {
    lines.push(`Active thread: ${active.saved_name || active.canonical_thread_id}`);
  }
  if (buffer) {
    lines.push("Recovery buffer:");
    lines.push(buffer);
  }
  const formatted = formatTurns(turns, "Recent turns:");
  if (formatted) lines.push(formatted);
  lines.push("</memorythreads-compaction-recovery>");
  return lines.join("\n");
}

function buildNormalContext(db, input, active, project) {
  const prompt = promptFromInput(input);
  const relevant = searchRelevantTurns(db, prompt, active, project, 5);
  const recent = active?.canonical_thread_id ? loadRecentTurns(db, active.canonical_thread_id, project, 4) : [];

  if (!active && relevant.length === 0 && recent.length === 0) return "";

  const lines = [
    "<memorythreads-context>",
    "Autonomous MemoryThreads context for this prompt.",
  ];
  if (active?.canonical_thread_id) {
    lines.push(`Active thread: ${active.saved_name || active.canonical_thread_id}`);
  }
  const relevantBlock = formatTurns(relevant, "Relevant prior turns:");
  if (relevantBlock) lines.push(relevantBlock);
  const recentBlock = formatTurns(recent, "Recent active turns:");
  if (recentBlock) lines.push(recentBlock);
  lines.push("Search MemoryThreads with recall_context if more history is needed.");
  lines.push("</memorythreads-context>");
  return lines.join("\n");
}

function buildMemoryContext(db, input, options = {}) {
  ensureCanonicalSchema(db);
  const transcriptPath = input.transcript_path || input.transcriptPath || input.rollout_path || "";
  const app = input.app || appFromTranscriptPath(transcriptPath);
  const cwd = input.cwd || input.project_path || "";
  const project = cwd ? projectHash(cwd) : null;
  const sessionId = sessionIdFromInput(input);
  const active = getActiveForSession(db, sessionId) || getActive(db, app, cwd);
  const recoveryNeeded = options.forceRecovery || hasNewCompactMarker(input, app);

  if (recoveryNeeded) {
    return buildRecoveryContext(db, input, active, project);
  }
  return buildNormalContext(db, input, active, project);
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
    const db = new Database(DB_PATH, { readonly: false, timeout: 1000 });
    const output = buildMemoryContext(db, input);
    db.close();
    if (output) process.stdout.write(output + "\n");
  } catch (err) {
    log(`user prompt hook failed open: ${err.message}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildMemoryContext,
  tokenizeQuery,
  compactMarkerCountFromTail,
};

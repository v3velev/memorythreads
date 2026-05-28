import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import OpenAI from "openai";
import {
  readFileSync, writeFileSync, existsSync, unlinkSync, statSync,
  createReadStream, readdirSync
} from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";
import { createHash } from "crypto";
import { createInterface } from "readline";
import { execFile, execSync } from "child_process";
import { parseTranscript, generateSourceThreadId } from "./transcript-parser.js";
import {
  ensureCanonicalSchema,
  getActiveCanonicalThread,
  getCanonicalThreadForSource,
  getThreadBySourceFile,
  setActiveCanonicalThread,
  sourceKindFromPath,
} from "./memory-schema.js";

// ── Config ──────────────────────────────────────────────────────────────────

const HOME = homedir();
const SERVER_DIR = join(HOME, ".claude", "memory-server");
const DB_PATH = join(SERVER_DIR, "data", "memory.db");
const PID_FILE = join(SERVER_DIR, "worker.pid");
const LOG_FILE = join(SERVER_DIR, "logs", "worker.log");
const SNAPSHOTS_DIR = join(SERVER_DIR, "snapshots");
const ENV_PATH = join(SERVER_DIR, ".env");
const POLL_INTERVAL_MS = 10000;
const CONCURRENCY = 4;

// ── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    writeFileSync(LOG_FILE, line, { flag: "a" });
  } catch { /* ignore */ }
}

// ── Load .env ───────────────────────────────────────────────────────────────

function loadEnv() {
  if (!existsSync(ENV_PATH)) return;
  const lines = readFileSync(ENV_PATH, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// ── JSONL Parser (streaming) ────────────────────────────────────────────────

async function parseJSONL(filePath) {
  const messages = [];
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Skip malformed lines (truncated file, concurrent write)
      continue;
    }
  }
  return messages;
}

// ── Transcript Pre-Processing ───────────────────────────────────────────────

function extractTextContent(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter(b => b.type === "text").map(b => b.text).join("\n");
  }
  return "";
}

function countToolUseBlocks(message) {
  const c = message?.content;
  if (!Array.isArray(c)) return 0;
  return c.filter(b => b.type === "tool_use").length;
}

function extractToolUses(message) {
  const c = message?.content;
  if (!Array.isArray(c)) return [];
  return c
    .filter(b => b.type === "tool_use")
    .map(b => ({ name: b.name || "unknown", input: JSON.stringify(b.input || {}) }));
}

function hasErrorInToolResults(messages, startIdx) {
  // Look ahead for the next user message containing tool_result blocks
  for (let i = startIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.type === "assistant") break; // Next assistant turn - stop looking
    if (m.type === "user") {
      const content = m.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === "tool_result") {
          if (block.is_error) return true;
          const text = typeof block.content === "string" ? block.content : "";
          if (/error|Error|ERROR|fail|FAIL|exception|Exception|EXCEPTION/.test(text)) return true;
        }
      }
      break; // Only check the immediately following user message
    }
  }
  return false;
}

function pairIntoTurns(rawMessages) {
  // Filter to user and assistant messages, extract text only
  const textMessages = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i];
    if (m.type === "user") {
      textMessages.push({
        role: "user",
        uuid: m.uuid,
        content: extractTextContent(m.message),
        timestamp: m.timestamp,
      });
    } else if (m.type === "assistant") {
      const toolCalls = countToolUseBlocks(m.message);
      const hasError = hasErrorInToolResults(rawMessages, i);
      textMessages.push({
        role: "assistant",
        uuid: m.uuid,
        content: extractTextContent(m.message),
        timestamp: m.timestamp,
        toolCalls,
        hasError,
        toolUses: extractToolUses(m.message),
      });
    }
  }

  // Pair into turns
  const turns = [];
  let turnNum = 1;
  let i = 0;
  while (i < textMessages.length) {
    const turn = { turn_number: turnNum };

    if (textMessages[i].role === "user") {
      turn.user_content = textMessages[i].content;
      turn.user_uuid = textMessages[i].uuid;
      turn.timestamp = textMessages[i].timestamp;
      i++;
      // Collect assistant response(s) for this turn
      if (i < textMessages.length && textMessages[i].role === "assistant") {
        turn.assistant_content = textMessages[i].content;
        turn.assistant_uuid = textMessages[i].uuid;
        turn.tool_calls_count = textMessages[i].toolCalls || 0;
        turn.has_error = textMessages[i].hasError ? 1 : 0;
        turn.tool_uses = textMessages[i].toolUses || [];
        if (!turn.timestamp) turn.timestamp = textMessages[i].timestamp;
        i++;
      }
    } else if (textMessages[i].role === "assistant") {
      // Assistant without preceding user (rare)
      turn.assistant_content = textMessages[i].content;
      turn.assistant_uuid = textMessages[i].uuid;
      turn.tool_calls_count = textMessages[i].toolCalls || 0;
      turn.has_error = textMessages[i].hasError ? 1 : 0;
      turn.tool_uses = textMessages[i].toolUses || [];
      turn.timestamp = textMessages[i].timestamp;
      i++;
    }

    // Skip empty turns
    if ((turn.user_content || "").trim() || (turn.assistant_content || "").trim()) {
      turns.push(turn);
      turnNum++;
    }
  }
  return turns;
}

// ── Thread ID Generation ────────────────────────────────────────────────────

function generateThreadId(turns, filePath) {
  // Content hash of first 3 turns + file basename for entropy
  const content = turns.slice(0, 3).map(t =>
    (t.user_content || "") + (t.assistant_content || "")
  ).join("\n");
  const fileBase = basename(filePath);
  const firstTimestamp = turns[0]?.timestamp || "";
  const hashInput = content + "\n" + fileBase + "\n" + firstTimestamp;
  return createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
}

// ── OpenAI Embeddings ───────────────────────────────────────────────────────

// SQLITE_ONLY disables all OpenAI embedding calls. Turn embeddings and
// failed-embedding retries are skipped. Turn/thread storage and FTS continue to run.
// Evaluated lazily: loadEnv() runs inside main(), after this module is parsed.
function isSqliteOnly() {
  return (process.env.SQLITE_ONLY || "").toLowerCase() === "true";
}

let openai = null;

function getOpenAI() {
  if (isSqliteOnly()) return null;
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

async function generateEmbeddings(texts) {
  if (isSqliteOnly()) {
    throw new Error("SQLITE_ONLY mode: embeddings disabled");
  }
  const client = getOpenAI();
  // text-embedding-3-small has 8192 token limit; ~4 chars per token, cap at 30000 chars
  const truncated = texts.map(t => t.length > 30000 ? t.slice(0, 30000) : t);
  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: truncated,
    dimensions: 1536,
  });
  return response.data.map(d => d.embedding);
}

// ── Database Operations ─────────────────────────────────────────────────────

function openDatabase() {
  const db = new Database(DB_PATH, { timeout: 5000 });
  loadSqliteVec(db);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  ensureCanonicalSchema(db);
  return db;
}

// ── Embedding Helpers ───────────────────────────────────────────────────────

function serializeEmbedding(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

function storeTurnEmbeddings(db, turnRows, embeddings) {
  // vec0 virtual tables don't support OR IGNORE/OR REPLACE, so check existence first
  const exists = db.prepare("SELECT 1 FROM turn_embeddings WHERE turn_id = ?");
  const insert = db.prepare(`
    INSERT INTO turn_embeddings (turn_id, embedding)
    VALUES (CAST(? AS INTEGER), ?)
  `);
  for (let i = 0; i < turnRows.length; i++) {
    if (embeddings[i] && !exists.get(turnRows[i].id)) {
      insert.run(turnRows[i].id, serializeEmbedding(embeddings[i]));
    }
  }
}

// ── Ingest Thread Pipeline ──────────────────────────────────────────────────

async function ingestThread(db, filePath, project, projectName, isFullSession, gitCommitHash, gitProjectDir, forceExtract = false) {
  const parsed = await parseTranscript(filePath);
  const rawMessages = parsed.rawMessages || [];
  const sourceKind = parsed.sourceKind === "unknown" ? sourceKindFromPath(filePath) : parsed.sourceKind;
  const sourceSessionId = parsed.sourceSessionId || null;

  if (rawMessages.length === 0) {
    log("  Empty transcript, skipping.");
    return 0;
  }

  const turns = parsed.turns || [];
  if (sourceKind === "codex" && turns.length === 0) {
    throw new Error("Codex transcript recognized but no user or assistant turns were parsed");
  }
  if (turns.length === 0) {
    log("  No turns found, skipping.");
    return 0;
  }

  // Skip trivial sessions (1 turn with short content)
  if (turns.length === 1) {
    const totalContent = (turns[0].user_content || "").length + (turns[0].assistant_content || "").length;
    if (totalContent < 500) {
      log(`  Trivial session (1 turn, ${totalContent} chars), skipping extraction.`);
      return 0;
    }
  }

  const sourceThread = getCanonicalThreadForSource(db, sourceKind, sourceSessionId, filePath)
    || getThreadBySourceFile(db, filePath);
  const generatedThreadId = generateSourceThreadId(sourceKind, sourceSessionId, filePath, turns);
  const threadId = sourceThread?.id || generatedThreadId;
  const fileMtime = statSync(filePath).mtimeMs / 1000;
  const app = sourceKind === "codex" ? "codex" : "claude";
  const activeCwd = parsed.cwd || gitProjectDir || null;
  // Thread identity = the session/terminal, NOT the folder. Each session is its own
  // thread; resuming a session (same source_session_id) continues the same thread.
  // Previously the cwd-active pointer glued every session in a folder into one canonical
  // thread, conflating different clients that share a project folder.
  const canonicalThreadId = sourceThread?.canonical_thread_id || threadId;

  const existingThread = db.prepare("SELECT id, turn_count FROM threads WHERE id = ?").get(threadId);

  if (existingThread) {
    if (turns.length > existingThread.turn_count) {
      db.prepare(`
        UPDATE threads SET
          turn_count = ?,
          timestamp_end = ?,
          file_mtime = ?,
          source_file = ?,
          source_kind = ?,
          source_session_id = ?,
          canonical_thread_id = ?
        WHERE id = ?
      `).run(
        turns.length,
        turns[turns.length - 1].timestamp,
        fileMtime,
        filePath,
        sourceKind,
        sourceSessionId,
        canonicalThreadId,
        threadId
      );
      log(`  Updated thread ${threadId}: ${existingThread.turn_count} -> ${turns.length} turns`);
    } else if (forceExtract) {
      log(`  Force re-extraction for thread ${threadId} (${existingThread.turn_count} turns)`);
    } else {
      db.prepare(`
        UPDATE threads SET
          source_kind = ?,
          source_session_id = ?,
          canonical_thread_id = ?,
          source_file = ?,
          file_mtime = ?
        WHERE id = ?
      `).run(sourceKind, sourceSessionId, canonicalThreadId, filePath, fileMtime, threadId);
      log(`  Thread ${threadId} already exists with ${existingThread.turn_count} turns, checking turns.`);
    }
  } else {
    db.prepare(`
      INSERT OR IGNORE INTO threads
        (id, project, project_name, turn_count, timestamp_start, timestamp_end, source_file, file_mtime, source_kind, source_session_id, canonical_thread_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      threadId, project, projectName, turns.length,
      turns[0].timestamp, turns[turns.length - 1].timestamp,
      filePath, fileMtime, sourceKind, sourceSessionId, canonicalThreadId
    );
  }

  if (activeCwd) {
    setActiveCanonicalThread(db, {
      app,
      cwd: activeCwd,
      canonicalThreadId,
      savedName: active?.saved_name || null,
      sourceSessionId,
    });
  }

  const insertSummary = db.prepare(`
    INSERT OR IGNORE INTO summaries (thread_id, leaf_uuid, summary)
    VALUES (?, ?, ?)
  `);
  for (const summary of parsed.summaries || []) {
    try { insertSummary.run(threadId, summary.leafUuid || null, summary.summary); } catch {}
  }

  // Step 4: Store turns
  const insertTurn = db.prepare(`
    INSERT OR IGNORE INTO turns (thread_id, turn_number, user_content, assistant_content, timestamp, tool_calls_count, has_error, user_uuid, assistant_uuid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertToolUse = db.prepare(`
    INSERT OR IGNORE INTO tool_uses (message_uuid, thread_id, turn_id, tool_name, tool_input, timestamp, has_error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const storedTurns = [];
  for (const t of turns) {
    let turnRow;
    try {
      insertTurn.run(threadId, t.turn_number, t.user_content || null, t.assistant_content || null,
        t.timestamp || null, t.tool_calls_count || 0, t.has_error || 0,
        t.user_uuid || null, t.assistant_uuid || null);
      turnRow = db.prepare(
        "SELECT * FROM turns WHERE thread_id = ? AND turn_number = ?"
      ).get(threadId, t.turn_number);
      if (turnRow) storedTurns.push(turnRow);
    } catch (err) {
      turnRow = db.prepare(
        "SELECT * FROM turns WHERE thread_id = ? AND turn_number = ?"
      ).get(threadId, t.turn_number);
      if (turnRow) storedTurns.push(turnRow);
    }

    if (turnRow) {
      const nextUser = t.user_content || null;
      const nextAssistant = t.assistant_content || null;
      const nextToolCount = t.tool_calls_count || 0;
      const nextHasError = t.has_error || 0;
      const changed =
        (turnRow.user_content || null) !== nextUser ||
        (turnRow.assistant_content || null) !== nextAssistant ||
        (turnRow.tool_calls_count || 0) !== nextToolCount ||
        (turnRow.has_error || 0) !== nextHasError;

      if (changed) {
        db.prepare(`
          UPDATE turns SET
            user_content = ?,
            assistant_content = ?,
            timestamp = COALESCE(?, timestamp),
            tool_calls_count = ?,
            has_error = ?,
            user_uuid = COALESCE(?, user_uuid),
            assistant_uuid = COALESCE(?, assistant_uuid),
            embed_status = 'pending'
          WHERE id = ?
        `).run(
          nextUser,
          nextAssistant,
          t.timestamp || null,
          nextToolCount,
          nextHasError,
          t.user_uuid || null,
          t.assistant_uuid || null,
          turnRow.id
        );
        try { db.prepare("DELETE FROM turn_embeddings WHERE turn_id = ?").run(turnRow.id); } catch {}
      }
    }

    // MemoryThreads: capture tool_uses extracted from this turn
    if (t.tool_uses?.length && t.assistant_uuid && turnRow) {
      for (const tu of t.tool_uses) {
        try {
          insertToolUse.run(t.assistant_uuid, threadId, turnRow.id, tu.name, tu.input,
            t.timestamp || null, t.has_error || 0);
        } catch {}
      }
    }
  }
  log(`  Stored ${storedTurns.length} turns for thread ${threadId}`);

  // Step 5: Generate turn embeddings (batch)
  if (isSqliteOnly()) {
    // Mark all turns as done with no embedding so the retry loop doesn't pick them up.
    for (const t of storedTurns) {
      db.prepare("UPDATE turns SET embed_status = 'done' WHERE id = ?").run(t.id);
    }
    log(`  Ingestion complete (SQLITE_ONLY): ${storedTurns.length} turns stored for thread ${threadId}.`);
    return storedTurns.length;
  }

  try {
    // Only embed turns that aren't already done (avoids vec0 UNIQUE constraint on thread updates)
    const alreadyDone = new Set(
      storedTurns
        .filter(t => db.prepare("SELECT embed_status FROM turns WHERE id = ?").get(t.id)?.embed_status === 'done')
        .map(t => t.id)
    );

    const pairs = turns.map((t, idx) => ({
      text: ((t.user_content || "") + " " + (t.assistant_content || "")).trim(),
      turn: storedTurns[idx]
    })).filter(p => p.text.length > 0 && p.turn && !alreadyDone.has(p.turn.id));

    // Batch in groups of 20
    for (let i = 0; i < pairs.length; i += 20) {
      const batch = pairs.slice(i, i + 20);
      const embeddings = await generateEmbeddings(batch.map(p => p.text));
      storeTurnEmbeddings(db, batch.map(p => p.turn), embeddings);

      // Mark embedded turns
      for (const p of batch) {
        db.prepare("UPDATE turns SET embed_status = 'done' WHERE id = ?").run(p.turn.id);
      }
    }
    log(`  Generated embeddings for ${pairs.length} turns (${alreadyDone.size} already done)`);
  } catch (err) {
    log(`  Turn embedding failed (will retry later): ${err.message}`);
    // Only mark turns as failed if they weren't already done
    for (const t of storedTurns) {
      const current = db.prepare("SELECT embed_status FROM turns WHERE id = ?").get(t.id);
      if (current?.embed_status !== 'done') {
        db.prepare("UPDATE turns SET embed_status = 'failed' WHERE id = ?").run(t.id);
      }
    }
  }

  // Turn storage and embeddings still run for recall_context search.
  log(`  Ingestion complete: ${storedTurns.length} turns stored for thread ${threadId}.`);
  return storedTurns.length;
}

// ── Retry Failed Embeddings ──────────────────────────────────────────────────

async function retryFailedEmbeddings(db) {
  if (isSqliteOnly()) {
    // Clear out any lingering pending/failed turns so they stop being retried.
    const cleared = db.prepare(
      "UPDATE turns SET embed_status = 'done' WHERE embed_status IN ('failed', 'pending')"
    ).run().changes;
    if (cleared > 0) log(`  Marked ${cleared} pending/failed turn(s) as done (SQLITE_ONLY mode)`);
    return 0;
  }

  // Process up to 5 threads per cycle, handle each turn individually on failure
  const failedThreads = db.prepare(
    "SELECT DISTINCT thread_id FROM turns WHERE embed_status IN ('failed', 'pending') LIMIT 5"
  ).all();

  if (failedThreads.length === 0) return 0;

  const exists = db.prepare("SELECT 1 FROM turn_embeddings WHERE turn_id = ?");
  let fixed = 0;
  for (const { thread_id } of failedThreads) {
    const turns = db.prepare(
      "SELECT id, user_content, assistant_content FROM turns WHERE thread_id = ? AND embed_status IN ('failed', 'pending')"
    ).all(thread_id);

    // Filter out turns that already have embeddings (from partial previous runs)
    const needsEmbed = turns.filter(t => !exists.get(t.id));
    // Mark already-embedded turns as done
    for (const t of turns) {
      if (exists.get(t.id)) {
        db.prepare("UPDATE turns SET embed_status = 'done' WHERE id = ?").run(t.id);
        fixed++;
      }
    }

    const pairs = needsEmbed
      .map(t => ({ id: t.id, text: ((t.user_content || "") + " " + (t.assistant_content || "")).trim() }))
      .filter(p => p.text.length > 0);

    if (pairs.length === 0) continue;

    try {
      for (let i = 0; i < pairs.length; i += 20) {
        const batch = pairs.slice(i, i + 20);
        const embeddings = await generateEmbeddings(batch.map(p => p.text));
        storeTurnEmbeddings(db, batch.map(p => ({ id: p.id })), embeddings);
        for (const p of batch) {
          db.prepare("UPDATE turns SET embed_status = 'done' WHERE id = ?").run(p.id);
        }
        fixed += batch.length;
      }
    } catch (err) {
      // Batch failed - likely one oversized turn. Try individually.
      for (const p of pairs) {
        try {
          const [emb] = await generateEmbeddings([p.text]);
          storeTurnEmbeddings(db, [{ id: p.id }], [emb]);
          db.prepare("UPDATE turns SET embed_status = 'done' WHERE id = ?").run(p.id);
          fixed++;
        } catch (singleErr) {
          // Permanently too large or other error - mark done with no embedding
          db.prepare("UPDATE turns SET embed_status = 'done' WHERE id = ?").run(p.id);
          log(`  Skipped oversized turn ${p.id} (${p.text.length} chars): ${singleErr.message.slice(0, 80)}`);
          fixed++;
        }
      }
    }
  }

  if (fixed > 0) log(`  Retried ${fixed} failed embeddings`);
  return fixed;
}

// ── Daily Backup ────────────────────────────────────────────────────────────

function runDailyBackup(db) {
  const backupPath = join(SERVER_DIR, "data", "memory-backup.db");
  db.backup(backupPath);
  log("Daily backup complete");

  // Truncate worker.log if too large
  try {
    const logStat = statSync(LOG_FILE);
    if (logStat.size > 1024 * 1024) { // > 1MB
      const lines = readFileSync(LOG_FILE, "utf8").split("\n");
      writeFileSync(LOG_FILE, lines.slice(-500).join("\n"));
      log("Truncated worker.log");
    }
  } catch { /* ignore */ }

  // Clean old snapshots (>7 days, successfully ingested)
  if (existsSync(SNAPSHOTS_DIR)) {
    try {
      const now = Date.now();
      const files = readdirSync(SNAPSHOTS_DIR);
      for (const f of files) {
        const fp = join(SNAPSHOTS_DIR, f);
        const age = now - statSync(fp).mtimeMs;
        if (age > 7 * 24 * 60 * 60 * 1000) {
          unlinkSync(fp);
          log(`  Deleted old snapshot: ${f}`);
        }
      }
    } catch { /* ignore */ }
  }

  // Clean old recovery buffer
  db.prepare("DELETE FROM recovery_buffer WHERE created_at < datetime('now', '-1 hour')").run();
}

// ── Stats Snapshot ──────────────────────────────────────────────────────────

function runStatsSnapshot(db) {
  const threads = db.prepare("SELECT COUNT(*) as c FROM threads").get().c;
  const turns = db.prepare("SELECT COUNT(*) as c FROM turns").get().c;

  try {
    const ins = db.prepare("INSERT OR REPLACE INTO stats_daily (date, metric, value) VALUES (date('now'), ?, ?)");
    ins.run("total_threads", threads);
    ins.run("total_turns", turns);
  } catch (err) {
    log(`Stats snapshot skipped: ${err.message}`);
  }
}

// ── Scheduled Job Checks ────────────────────────────────────────────────────

function shouldRunDailyBackup(db) {
  // Check backup file age
  const backupPath = join(SERVER_DIR, "data", "memory-backup.db");
  if (!existsSync(backupPath)) return true;
  const age = Date.now() - statSync(backupPath).mtimeMs;
  return age > 24 * 60 * 60 * 1000;
}

// ── Job Processing ──────────────────────────────────────────────────────────

async function processJob(db, job) {
  const payload = JSON.parse(job.payload || "{}");

  switch (job.type) {
    case "ingest_thread": {
      const filePath = payload.transcript_path || payload.session_file;
      const project = payload.project || "unknown";
      const projectName = payload.project_name || basename(project);
      const isFullSession = !!payload.is_full_session;

      if (!filePath || !existsSync(filePath)) {
        log(`Transcript not found: ${filePath}`);
        return 0;
      }

      const gitCommitHash = payload.git_commit_hash || null;
      const gitProjectDir = payload.git_project_dir || null;
      const forceExtract = !!payload.force_extract;

      log(`Ingesting: ${basename(filePath)} (project: ${projectName})${forceExtract ? ' [force re-extract]' : ''}`);
      return await ingestThread(db, filePath, project, projectName, isFullSession, gitCommitHash, gitProjectDir, forceExtract);
    }

    default:
      log(`Unknown job type: ${job.type}`);
      return 0;
  }
}

// ── Claim Job (atomic) ──────────────────────────────────────────────────────

function claimNextJob(db) {
  return db.prepare(`
    UPDATE jobs SET status = 'processing', started_at = datetime('now')
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'pending' AND attempts < 3
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    )
    RETURNING *
  `).get();
}

function markDone(db, jobId) {
  db.prepare("UPDATE jobs SET status = 'done', completed_at = datetime('now') WHERE id = ?").run(jobId);
}

function markFailed(db, jobId, error) {
  db.prepare(`
    UPDATE jobs SET status = 'failed', error = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(error, jobId);
}

function markPending(db, jobId) {
  db.prepare(`
    UPDATE jobs SET status = 'pending', attempts = attempts + 1
    WHERE id = ?
  `).run(jobId);
}

// ── Main Loop ───────────────────────────────────────────────────────────────

async function startup() {
  loadEnv();

  if (isSqliteOnly()) {
    log("SQLITE_ONLY mode: OpenAI embeddings are disabled.");
  } else {
    // Validate API keys
    if (!process.env.OPENAI_API_KEY) {
      log("FATAL: OPENAI_API_KEY not set. Check .env file.");
      process.exit(1);
    }

    // Test OpenAI connectivity
    try {
      await generateEmbeddings(["test"]);
      log("OpenAI API: OK");
    } catch (err) {
      log(`FATAL: OpenAI API test failed: ${err.message}`);
      process.exit(1);
    }
  }

  // Test Claude CLI
  try {
    const claudePath = process.env.CLAUDE_CLI_PATH || join(HOME, ".local", "bin", "claude");
    if (!existsSync(claudePath)) {
      log(`FATAL: Claude CLI not found at ${claudePath}`);
      process.exit(1);
    }
    log("Claude CLI: found");
  } catch (err) {
    log(`FATAL: Claude CLI check failed: ${err.message}`);
    process.exit(1);
  }

  // Open database
  const db = openDatabase();

  // Recovery sweep: reset stuck jobs
  const stuck = db.prepare(`
    UPDATE jobs SET status = 'pending', attempts = attempts + 1
    WHERE status = 'processing'
    AND started_at < datetime('now', '-5 minutes')
  `).run();
  if (stuck.changes > 0) {
    log(`Recovered ${stuck.changes} stuck jobs from previous crash`);
  }

  // Acquire worker lock - prevent duplicate workers from race conditions
  if (existsSync(PID_FILE)) {
    const existingPid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    if (existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0); // throws if dead
        const cmd = `ps -p ${existingPid} -o command=`;
        const out = execSync(cmd, { encoding: "utf-8", timeout: 2000 }).trim();
        if (out.includes("worker.js")) {
          log(`Another worker already running (PID ${existingPid}), exiting.`);
          process.exit(0);
        }
      } catch {
        // PID dead or not our worker - take over
      }
    }
  }

  // Write PID file
  writeFileSync(PID_FILE, process.pid.toString());
  log(`Worker started (PID: ${process.pid})`);

  return db;
}

async function handleJob(db, job) {
  try {
    const result = await processJob(db, job);
    markDone(db, job.id);
  } catch (err) {
    const isAuthError = err.status === 401 || err.status === 403
      || (err.message && err.message.includes("invalid_api_key"));
    if (isAuthError) {
      log(`FATAL: API authentication failed: ${err.message}`);
      markFailed(db, job.id, "auth_error: " + err.message);
      throw err; // Propagate to stop the worker
    } else if (job.attempts < 3) {
      log(`Job ${job.id} failed (will retry): ${err.message}`);
      markPending(db, job.id);
    } else {
      log(`Job ${job.id} permanently failed: ${err.message}`);
      markFailed(db, job.id, err.message);
    }
  }
}

async function pollLoop(db) {
  const inFlight = new Set();
  let authError = null;

  while (true) {
    // Check for auth errors from previous cycle
    if (authError) {
      log(`Fatal auth error (${authError.status}), stopping worker.`);
      process.exit(1);
    }

    try {
      // Claim jobs up to CONCURRENCY limit
      while (inFlight.size < CONCURRENCY) {
        const job = claimNextJob(db);
        if (!job) break;

        const promise = handleJob(db, job).then(() => {
          inFlight.delete(promise);
        }).catch((err) => {
          inFlight.delete(promise);
          if (err.status === 401 || err.status === 403) {
            authError = err;
          }
        });
        inFlight.add(promise);
      }

      // If we have in-flight jobs, wait for at least one to finish
      if (inFlight.size > 0) {
        await Promise.race(inFlight);
        continue; // Try to fill slots immediately
      }

      // Retry failed embeddings periodically
      try {
        await retryFailedEmbeddings(db);
      } catch { /* non-critical */ }
      if (shouldRunDailyBackup(db)) {
        runDailyBackup(db);
        runStatsSnapshot(db);
      }
    } catch (err) {
      log(`Poll error: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ── Signal Handlers ─────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  log("Worker shutting down (SIGTERM)");
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  process.exit(0);
});

process.on("SIGINT", () => {
  log("Worker shutting down (SIGINT)");
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  process.exit(0);
});

// ── Entry Point ─────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startup().then(db => pollLoop(db)).catch(err => {
    log(`Fatal error: ${err.message}`);
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    process.exit(1);
  });
}

export { ingestThread, openDatabase };

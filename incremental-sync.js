#!/usr/bin/env node
// Incremental sync: watches for changed JSONL transcripts and inserts new turns
// Triggered by launchd WatchPaths on ~/.claude/projects/
// Turns are inserted with embed_status='pending' - worker.js handles embedding

import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import {
  readFileSync, writeFileSync, existsSync, statSync,
  createReadStream, readdirSync
} from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { createInterface } from "readline";
import { parseTranscript, generateSourceThreadId } from "./transcript-parser.js";
import { ensureCanonicalSchema, getThreadBySourceFile } from "./memory-schema.js";

const HOME = homedir();
const SERVER_DIR = join(HOME, ".claude", "memory-server");
const DB_PATH = join(SERVER_DIR, "data", "memory.db");
const SYNC_STATE_PATH = join(SERVER_DIR, "data", "sync-state.json");
const PROJECTS_DIR = join(HOME, ".claude", "projects");
const LOG_FILE = join(SERVER_DIR, "logs", "sync.log");

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [sync] ${msg}\n`;
  try {
    writeFileSync(LOG_FILE, line, { flag: "a" });
  } catch { /* ignore */ }
}

// ── JSONL Parser ──────────────────────────────────────────────────────────

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
      continue;
    }
  }
  return messages;
}

// ── Text extraction ──────────────────────────────────────────────────────

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

function hasErrorInToolResults(messages, startIdx) {
  for (let i = startIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.type === "assistant") break;
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
      break;
    }
  }
  return false;
}

function pairIntoTurns(rawMessages) {
  const textMessages = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i];
    if (m.type === "user") {
      textMessages.push({
        role: "user",
        content: extractTextContent(m.message),
        timestamp: m.timestamp,
      });
    } else if (m.type === "assistant") {
      const toolCalls = countToolUseBlocks(m.message);
      const hasError = hasErrorInToolResults(rawMessages, i);
      textMessages.push({
        role: "assistant",
        content: extractTextContent(m.message),
        timestamp: m.timestamp,
        toolCalls,
        hasError,
      });
    }
  }

  const turns = [];
  let turnNum = 1;
  let i = 0;
  while (i < textMessages.length) {
    const turn = { turn_number: turnNum };

    if (textMessages[i].role === "user") {
      turn.user_content = textMessages[i].content;
      turn.timestamp = textMessages[i].timestamp;
      i++;
      if (i < textMessages.length && textMessages[i].role === "assistant") {
        turn.assistant_content = textMessages[i].content;
        turn.tool_calls_count = textMessages[i].toolCalls || 0;
        turn.has_error = textMessages[i].hasError ? 1 : 0;
        if (!turn.timestamp) turn.timestamp = textMessages[i].timestamp;
        i++;
      }
    } else if (textMessages[i].role === "assistant") {
      turn.assistant_content = textMessages[i].content;
      turn.tool_calls_count = textMessages[i].toolCalls || 0;
      turn.has_error = textMessages[i].hasError ? 1 : 0;
      turn.timestamp = textMessages[i].timestamp;
      i++;
    }

    if ((turn.user_content || "").trim() || (turn.assistant_content || "").trim()) {
      turns.push(turn);
      turnNum++;
    }
  }
  return turns;
}

function generateThreadId(turns, filePath) {
  const content = turns.slice(0, 3).map(t =>
    (t.user_content || "") + (t.assistant_content || "")
  ).join("\n");
  const fileBase = basename(filePath);
  const firstTimestamp = turns[0]?.timestamp || "";
  const hashInput = content + "\n" + fileBase + "\n" + firstTimestamp;
  return createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
}

// ── Sync State ──────────────────────────────────────────────────────────

function loadSyncState() {
  try {
    if (existsSync(SYNC_STATE_PATH)) {
      return JSON.parse(readFileSync(SYNC_STATE_PATH, "utf8"));
    }
  } catch { /* corrupt state file - start fresh */ }
  return {};
}

function saveSyncState(state) {
  writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2));
}

// ── Find all JSONL transcripts ────────────────────────────────────────────

function findTranscripts() {
  const transcripts = [];
  if (!existsSync(PROJECTS_DIR)) return transcripts;

  for (const projectDir of readdirSync(PROJECTS_DIR)) {
    const projectPath = join(PROJECTS_DIR, projectDir);
    try {
      const stat = statSync(projectPath);
      if (!stat.isDirectory()) continue;
    } catch { continue; }

    // Direct JSONL files in project dir
    try {
      for (const file of readdirSync(projectPath)) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = join(projectPath, file);
        try {
          const stat = statSync(filePath);
          transcripts.push({
            path: filePath,
            mtime: stat.mtimeMs,
            projectDirName: projectDir,
          });
        } catch { continue; }
      }
    } catch { continue; }

    // Also check subdirectories (subagents)
    try {
      for (const subdir of readdirSync(projectPath)) {
        const subdirPath = join(projectPath, subdir);
        try {
          if (!statSync(subdirPath).isDirectory()) continue;
        } catch { continue; }
        for (const file of readdirSync(subdirPath)) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = join(subdirPath, file);
          try {
            const stat = statSync(filePath);
            transcripts.push({
              path: filePath,
              mtime: stat.mtimeMs,
              projectDirName: projectDir,
            });
          } catch { continue; }
        }
      }
    } catch { continue; }
  }

  return transcripts;
}

// ── Main sync ─────────────────────────────────────────────────────────────

async function main() {
  const db = new Database(DB_PATH, { timeout: 5000 });
  try {
    loadSqliteVec(db);
  } catch { /* vec extension may not be needed for sync */ }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  ensureCanonicalSchema(db);

  const syncState = loadSyncState();
  const transcripts = findTranscripts();
  let totalNewTurns = 0;

  for (const transcript of transcripts) {
    const lastMtime = syncState[transcript.path]?.mtime || 0;
    const lastTurnCount = syncState[transcript.path]?.turnCount || 0;

    // Skip unchanged files
    if (transcript.mtime <= lastMtime) continue;

    try {
      const parsed = await parseTranscript(transcript.path);
      if ((parsed.rawMessages || []).length === 0) continue;

      const turns = parsed.turns || [];
      if (turns.length === 0) continue;

      // Skip if no new turns
      if (turns.length <= lastTurnCount) {
        syncState[transcript.path] = { mtime: transcript.mtime, turnCount: turns.length };
        continue;
      }

      const sourceKind = parsed.sourceKind || "claude";
      const sourceSessionId = parsed.sourceSessionId || null;
      const sourceThread = getThreadBySourceFile(db, transcript.path);
      const threadId = sourceThread?.id || generateSourceThreadId(sourceKind, sourceSessionId, transcript.path, turns);
      const projectHash = createHash("sha256").update(transcript.projectDirName).digest("hex").slice(0, 16);

      // Derive project name from dir name
      const actualPath = transcript.projectDirName.replace(/^-/, "/").replace(/-/g, "/");
      const projectName = basename(actualPath);

      // Ensure thread exists
      const existingThread = db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
      if (!existingThread) {
        db.prepare(`
          INSERT INTO threads
            (id, project, project_name, turn_count, timestamp_start, timestamp_end, source_file, file_mtime, source_kind, source_session_id, canonical_thread_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          threadId,
          projectHash,
          projectName,
          turns.length,
          turns[0]?.timestamp || null,
          turns[turns.length - 1]?.timestamp || null,
          transcript.path,
          transcript.mtime,
          sourceKind,
          sourceSessionId,
          threadId
        );
      }

      // Insert only new turns (skip already-synced ones)
      const insertTurn = db.prepare(`
        INSERT OR IGNORE INTO turns (thread_id, turn_number, user_content, assistant_content, timestamp, tool_calls_count, has_error, embed_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      `);

      let newTurns = 0;
      const insertMany = db.transaction(() => {
        for (const turn of turns) {
          if (turn.turn_number <= lastTurnCount) continue; // Skip already-synced

          const result = insertTurn.run(
            threadId,
            turn.turn_number,
            turn.user_content || null,
            turn.assistant_content || null,
            turn.timestamp || null,
            turn.tool_calls_count || 0,
            turn.has_error || 0
          );

          // FTS auto-populated by turns_fts_ai trigger on INSERT
          if (result.changes > 0) {
            newTurns++;
          }
        }

        // Update thread metadata
        if (newTurns > 0) {
          db.prepare(`
            UPDATE threads SET
              turn_count = ?,
              timestamp_end = ?,
              file_mtime = ?
              ,
              source_kind = ?,
              source_session_id = ?,
              canonical_thread_id = COALESCE(canonical_thread_id, ?)
            WHERE id = ?
          `).run(
            turns.length,
            turns[turns.length - 1]?.timestamp || null,
            transcript.mtime,
            sourceKind,
            sourceSessionId,
            threadId,
            threadId
          );
        }
      });

      insertMany();
      totalNewTurns += newTurns;

      if (newTurns > 0) {
        log(`Synced ${newTurns} new turns from ${basename(transcript.path)} (thread:${threadId})`);
      }

      syncState[transcript.path] = { mtime: transcript.mtime, turnCount: turns.length };
    } catch (err) {
      log(`Error syncing ${transcript.path}: ${err.message}`);
      continue;
    }
  }

  saveSyncState(syncState);
  db.close();

  if (totalNewTurns > 0) {
    log(`Sync complete: ${totalNewTurns} new turns across ${transcripts.length} files`);
  }
}

main().catch(err => {
  log(`Fatal sync error: ${err.message}`);
  process.exit(1);
});

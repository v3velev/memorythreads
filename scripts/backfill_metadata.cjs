#!/usr/bin/env node
// MemoryThreads one-shot backfill: populate user_uuid, assistant_uuid, tool_uses, summaries
// from the original JSONL transcripts. Idempotent — safe to re-run.

const Database = require("better-sqlite3");
const { readFileSync, readdirSync, statSync, existsSync } = require("fs");
const { join } = require("path");
const { homedir } = require("os");
const { createHash } = require("crypto");

const DB_PATH = join(homedir(), ".claude", "memory-server", "data", "memory.db");
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

// Mirror worker.js generateThreadId() exactly
function deriveThreadId(turns, filePath) {
  const content = turns.slice(0, 3).map(t =>
    (t.user_content || "") + (t.assistant_content || "")
  ).join("\n");
  const fileBase = filePath.split("/").pop();
  const firstTimestamp = turns[0]?.timestamp || "";
  const hashInput = content + "\n" + fileBase + "\n" + firstTimestamp;
  return createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
}

function findJsonlFiles(dir) {
  const out = [];
  try {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      try {
        const s = statSync(p);
        if (s.isDirectory()) out.push(...findJsonlFiles(p));
        else if (entry.endsWith(".jsonl")) out.push(p);
      } catch {}
    }
  } catch {}
  return out;
}

function extractTextContent(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter(b => b.type === "text").map(b => b.text).join("\n");
  return "";
}

function extractToolUses(message) {
  const c = message?.content;
  if (!Array.isArray(c)) return [];
  return c
    .filter(b => b.type === "tool_use")
    .map(b => ({ name: b.name || "unknown", input: JSON.stringify(b.input || {}) }));
}

function pairIntoTurns(rawMessages) {
  const textMessages = [];
  for (const m of rawMessages) {
    if (m.type === "user") {
      textMessages.push({ role: "user", uuid: m.uuid, content: extractTextContent(m.message), timestamp: m.timestamp });
    } else if (m.type === "assistant") {
      textMessages.push({
        role: "assistant",
        uuid: m.uuid,
        content: extractTextContent(m.message),
        timestamp: m.timestamp,
        toolUses: extractToolUses(m.message),
      });
    }
  }
  const turns = [];
  let n = 1, i = 0;
  while (i < textMessages.length) {
    const turn = { turn_number: n };
    if (textMessages[i].role === "user") {
      turn.user_uuid = textMessages[i].uuid;
      turn.user_content = textMessages[i].content;
      turn.timestamp = textMessages[i].timestamp;
      i++;
      if (i < textMessages.length && textMessages[i].role === "assistant") {
        turn.assistant_uuid = textMessages[i].uuid;
        turn.assistant_content = textMessages[i].content;
        turn.tool_uses = textMessages[i].toolUses || [];
        if (!turn.timestamp) turn.timestamp = textMessages[i].timestamp;
        i++;
      }
    } else if (textMessages[i].role === "assistant") {
      turn.assistant_uuid = textMessages[i].uuid;
      turn.assistant_content = textMessages[i].content;
      turn.tool_uses = textMessages[i].toolUses || [];
      turn.timestamp = textMessages[i].timestamp;
      i++;
    }
    if ((turn.user_content || "").trim() || (turn.assistant_content || "").trim()) {
      turns.push(turn);
      n++;
    } else {
      // Move forward even on empty turns to avoid infinite loop
      if (turns.length === n - 1) i++;
    }
  }
  return turns;
}

function parseJsonl(filePath) {
  const records = [];
  const summaries = [];
  try {
    const text = readFileSync(filePath, "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.type === "summary" && r.summary) {
          summaries.push({ leafUuid: r.leafUuid || null, summary: r.summary });
        }
        records.push(r);
      } catch {}
    }
  } catch {}
  return { records, summaries };
}

const db = new Database(DB_PATH, { timeout: 30000 });
db.pragma("busy_timeout = 30000");

// Content-based match (more robust than turn_number alignment when worker
// has mutated rows over time). Matches by exact content equality.
const updateTurnByContent = db.prepare(`
  UPDATE turns SET user_uuid = COALESCE(user_uuid, ?), assistant_uuid = COALESCE(assistant_uuid, ?)
  WHERE thread_id = ?
    AND COALESCE(user_content,'') = COALESCE(?,'')
    AND COALESCE(assistant_content,'') = COALESCE(?,'')
    AND (user_uuid IS NULL OR assistant_uuid IS NULL)
`);
const lookupTurnByContent = db.prepare(`
  SELECT id FROM turns
  WHERE thread_id = ?
    AND COALESCE(user_content,'') = COALESCE(?,'')
    AND COALESCE(assistant_content,'') = COALESCE(?,'')
  LIMIT 1
`);
const insertToolUse = db.prepare(`
  INSERT OR IGNORE INTO tool_uses (message_uuid, thread_id, turn_id, tool_name, tool_input, timestamp, has_error)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertSummary = db.prepare(`
  INSERT OR IGNORE INTO summaries (thread_id, leaf_uuid, summary) VALUES (?, ?, ?)
`);
const lookupTurn = db.prepare(`SELECT id FROM turns WHERE thread_id = ? AND turn_number = ?`);

// Iterate over THREADS in DB (guarantees full coverage of what we have)
const allThreads = db.prepare("SELECT id, source_file FROM threads WHERE source_file IS NOT NULL").all();
console.log(`Iterating ${allThreads.length} threads from DB`);

let totalTurnUpdates = 0;
let totalToolUseInserts = 0;
let totalSummaryInserts = 0;
let processed = 0;
let skipped = 0;
let missingFile = 0;

for (const thread of allThreads) {
  const threadId = thread.id;
  const filePath = thread.source_file;

  if (!existsSync(filePath)) {
    // Try to fall back to ~/.claude/projects with same basename (snapshots may be cleaned)
    const sessionId = filePath.split("/").pop().replace(/^\d+-/, "").replace(".jsonl", "");
    const projectFiles = findJsonlFiles(PROJECTS_DIR).filter(f => f.endsWith(`/${sessionId}.jsonl`));
    if (projectFiles.length === 0) {
      missingFile++;
      continue;
    }
    // Use the first project file match
    const { records, summaries } = parseJsonl(projectFiles[0]);
    if (records.length === 0) { skipped++; continue; }
    var turns = pairIntoTurns(records);
    var summariesArr = summaries;
  } else {
    const { records, summaries } = parseJsonl(filePath);
    if (records.length === 0) { skipped++; continue; }
    var turns = pairIntoTurns(records);
    var summariesArr = summaries;
  }
  if (turns.length === 0) { skipped++; continue; }

  const tx = db.transaction(() => {
    for (const t of turns) {
      const result = updateTurnByContent.run(
        t.user_uuid || null, t.assistant_uuid || null,
        threadId, t.user_content || null, t.assistant_content || null
      );
      if (result.changes > 0) totalTurnUpdates += result.changes;

      if (t.tool_uses?.length && t.assistant_uuid) {
        const turnRow = lookupTurnByContent.get(threadId, t.user_content || null, t.assistant_content || null);
        if (turnRow) {
          for (const tu of t.tool_uses) {
            const r = insertToolUse.run(t.assistant_uuid, threadId, turnRow.id, tu.name, tu.input, t.timestamp || null, 0);
            if (r.changes > 0) totalToolUseInserts++;
          }
        }
      }
    }

    for (const s of summariesArr) {
      const r = insertSummary.run(threadId, s.leafUuid, s.summary);
      if (r.changes > 0) totalSummaryInserts++;
    }
  });
  tx();

  processed++;
  if (processed % 100 === 0) {
    console.log(`  Processed ${processed}/${allThreads.length} (turns updated: ${totalTurnUpdates}, tools: ${totalToolUseInserts}, summaries: ${totalSummaryInserts})`);
  }
}

console.log(`\nDone.`);
console.log(`  Threads processed: ${processed}`);
console.log(`  Threads skipped (no records or no turns): ${skipped}`);
console.log(`  Threads with missing source file: ${missingFile}`);
console.log(`  Turn UUID updates: ${totalTurnUpdates}`);
console.log(`  Tool use inserts: ${totalToolUseInserts}`);
console.log(`  Summary inserts: ${totalSummaryInserts}`);

db.close();

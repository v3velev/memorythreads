import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCanonicalSchema } from "../memory-schema.js";

const require = createRequire(import.meta.url);
const { buildMemoryContext } = require("../hooks/user-prompt-submit.cjs");

const dbPath = join(mkdtempSync(join(tmpdir(), "mt-hook-")), "memory.db");
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    project TEXT,
    project_name TEXT,
    turn_count INTEGER DEFAULT 0,
    timestamp_start TEXT,
    timestamp_end TEXT,
    source_file TEXT,
    file_mtime TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    turn_number INTEGER NOT NULL,
    user_content TEXT,
    assistant_content TEXT,
    timestamp TEXT,
    tool_calls_count INTEGER DEFAULT 0,
    has_error INTEGER DEFAULT 0,
    embed_status TEXT DEFAULT 'done'
  );

  CREATE TABLE recovery_buffer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    project TEXT,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE saved_threads (
    name TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    session_id TEXT NOT NULL,
    project_path TEXT,
    note TEXT,
    saved_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_resumed_at TEXT
  );
`);

ensureCanonicalSchema(db);

db.prepare(`
  INSERT INTO threads
    (id, project, project_name, turn_count, timestamp_start, timestamp_end, source_file, file_mtime, source_kind, source_session_id, canonical_thread_id)
  VALUES ('thread-a', 'project-a', 'Project A', 2, '2026-05-05T10:00:00Z', '2026-05-05T10:01:00Z', '/tmp/a.jsonl', 0, 'codex', 'codex-a', 'thread-a')
`).run();

db.prepare(`
  INSERT INTO active_memory_threads (app, cwd, canonical_thread_id, saved_name, source_session_id)
  VALUES ('codex', '/tmp/project', 'thread-a', 'Client Test', 'codex-a')
`).run();

// Session-scoped active-thread resolution (getActiveForSession) reads the saved
// name from saved_threads, so the bookmark must exist there for it to surface.
db.prepare(`
  INSERT INTO saved_threads (name, thread_id, session_id, project_path)
  VALUES ('Client Test', 'thread-a', 'codex-a', '/tmp/project')
`).run();

db.prepare(`
  INSERT INTO turns (thread_id, turn_number, user_content, assistant_content, timestamp)
  VALUES ('thread-a', 1, 'User asked about autonomous memory.', 'Assistant proposed canonical threads.', '2026-05-05T10:00:00Z')
`).run();
db.prepare(`
  INSERT INTO turns (thread_id, turn_number, user_content, assistant_content, timestamp)
  VALUES ('thread-a', 2, 'User asked about compaction.', 'Assistant found the reverse step was unsafe.', '2026-05-05T10:01:00Z')
`).run();

const recovery = buildMemoryContext(db, {
  cwd: "/tmp/project",
  session_id: "codex-a",
  transcript_path: "/tmp/.codex/sessions/a.jsonl",
  prompt: "continue after compaction",
}, { forceRecovery: true });

assert.ok(recovery.includes("<memorythreads-compaction-recovery>"));
assert.ok(recovery.includes("User asked about autonomous memory."));
assert.ok(recovery.includes("Assistant found the reverse step was unsafe."));
assert.equal(recovery.includes("| tac"), false);

const normal = buildMemoryContext(db, {
  cwd: "/tmp/project",
  session_id: "codex-a",
  transcript_path: "/tmp/.codex/sessions/a.jsonl",
  prompt: "what did we decide about canonical threads",
});

assert.ok(normal.includes("<memorythreads-context>"));
assert.ok(normal.includes("Client Test"));

console.log("hook context tests passed");

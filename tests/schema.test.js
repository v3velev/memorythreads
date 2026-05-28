import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureCanonicalSchema,
  getActiveCanonicalThread,
  setActiveCanonicalThread,
} from "../memory-schema.js";

const dbPath = join(mkdtempSync(join(tmpdir(), "mt-schema-")), "memory.db");
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

  CREATE TABLE saved_threads (
    name TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    session_id TEXT NOT NULL,
    project_path TEXT,
    note TEXT,
    saved_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_resumed_at TEXT
  );

  INSERT INTO threads (id, project, project_name, source_file)
  VALUES ('thread-a', 'project-a', 'Project A', '/tmp/a.jsonl');
`);

ensureCanonicalSchema(db);
ensureCanonicalSchema(db);

const columns = db.prepare("PRAGMA table_info(threads)").all().map(row => row.name);
assert.ok(columns.includes("source_kind"));
assert.ok(columns.includes("source_session_id"));
assert.ok(columns.includes("canonical_thread_id"));

const migrated = db.prepare("SELECT source_kind, canonical_thread_id FROM threads WHERE id = ?").get("thread-a");
assert.equal(migrated.source_kind, "unknown");
assert.equal(migrated.canonical_thread_id, "thread-a");

setActiveCanonicalThread(db, {
  app: "codex",
  cwd: "/tmp/project",
  canonicalThreadId: "thread-a",
  savedName: "Client Test",
  sourceSessionId: "codex-1",
});

const active = getActiveCanonicalThread(db, "codex", "/tmp/project");
assert.equal(active.canonical_thread_id, "thread-a");
assert.equal(active.saved_name, "Client Test");
assert.equal(active.source_session_id, "codex-1");

console.log("schema tests passed");

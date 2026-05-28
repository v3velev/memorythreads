#!/usr/bin/env node

const Database = require("better-sqlite3");
const path = require("path");
const os = require("os");

const DB_PATH = path.join(os.homedir(), ".claude", "memory-server", "data", "memory.db");

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map(row => row.name));
}

function addColumn(db, tableName, columnName, ddl) {
  const columns = tableColumns(db, tableName);
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
  }
}

const db = new Database(DB_PATH, { timeout: 5000 });
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

addColumn(db, "threads", "source_kind", "source_kind TEXT NOT NULL DEFAULT 'unknown'");
addColumn(db, "threads", "source_session_id", "source_session_id TEXT");
addColumn(db, "threads", "canonical_thread_id", "canonical_thread_id TEXT");

db.exec(`
  UPDATE threads
  SET canonical_thread_id = id
  WHERE canonical_thread_id IS NULL OR canonical_thread_id = '';

  CREATE INDEX IF NOT EXISTS idx_threads_source_identity
  ON threads(source_kind, source_session_id, source_file);

  CREATE INDEX IF NOT EXISTS idx_threads_canonical
  ON threads(canonical_thread_id);

  CREATE TABLE IF NOT EXISTS active_memory_threads (
    app TEXT NOT NULL,
    cwd TEXT NOT NULL,
    canonical_thread_id TEXT NOT NULL,
    saved_name TEXT,
    source_session_id TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (app, cwd)
  );

  CREATE INDEX IF NOT EXISTS idx_active_memory_threads_canonical
  ON active_memory_threads(canonical_thread_id);
`);

db.close();
console.log("canonical MemoryThreads migration applied");

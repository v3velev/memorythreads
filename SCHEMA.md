# Memory Server - Canonical Schema Reference

MemoryThreads stores conversation turns and threads from both Claude Code and Codex in one SQLite DB, searchable via FTS5 (BM25) and sqlite-vec (cosine). Recall operates directly over conversation turns and threads; there is no separate extracted-knowledge layer.

## Core tables

### threads

```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  project TEXT, project_name TEXT, turn_count INTEGER DEFAULT 0,
  timestamp_start TEXT, timestamp_end TEXT,
  priority TEXT DEFAULT 'routine',
  has_corrections INTEGER DEFAULT 0, has_decisions INTEGER DEFAULT 0, has_debugging INTEGER DEFAULT 0,
  source_file TEXT, file_mtime TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  source_kind TEXT NOT NULL DEFAULT 'unknown',   -- 'claude' | 'codex' | 'snapshot' | 'unknown'
  source_session_id TEXT,                         -- native session id for that source
  canonical_thread_id TEXT                        -- connects native streams to one MemoryThread
);
```

### turns

```sql
CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  turn_number INTEGER NOT NULL,
  user_content TEXT, assistant_content TEXT, timestamp TEXT,
  is_key_exchange INTEGER DEFAULT 0, key_exchange_type TEXT,
  tool_calls_count INTEGER DEFAULT 0, has_error INTEGER DEFAULT 0,
  embed_status TEXT DEFAULT 'pending',            -- 'pending' until worker embeds it
  user_uuid TEXT, assistant_uuid TEXT
);
```

### turns_fts (FTS5, stemmed BM25 over turns)

```sql
CREATE VIRTUAL TABLE turns_fts USING fts5(
  user_content, assistant_content,
  content='turns', content_rowid='id',
  tokenize='porter'
);
```

Synced by the `turns_fts_ai/ad/au` triggers on the `turns` table.

### turn_embeddings (sqlite-vec, cosine KNN over turns)

```sql
CREATE VIRTUAL TABLE turn_embeddings USING vec0(
  turn_id INTEGER PRIMARY KEY,
  embedding float[1536] distance_metric=cosine
);
```

Populated by `worker.js` (OpenAI text-embedding-3-small, 1536 dims) for turns with `embed_status='pending'`. Requires the sqlite-vec extension to be loaded before any query/DDL against it.

## Canonical MemoryThreads (cross-platform continuity)

`active_memory_threads` stores the currently selected canonical thread per app and cwd. Codex Desktop and Claude Code stay as separate native source streams; continuity comes from `canonical_thread_id`, not from sharing native session files.

```sql
CREATE TABLE active_memory_threads (
  app TEXT NOT NULL,
  cwd TEXT NOT NULL,
  canonical_thread_id TEXT NOT NULL,
  saved_name TEXT,
  source_session_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (app, cwd)
);
```

## Supporting tables

```sql
CREATE TABLE saved_threads (        -- /mt-save bookmarks
  name TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  session_id TEXT NOT NULL,
  project_path TEXT, note TEXT,
  saved_at TEXT DEFAULT CURRENT_TIMESTAMP, last_resumed_at TEXT
);

CREATE TABLE docs (                 -- ingest_doc / search_docs reference docs
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT,
  source TEXT UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT
);
-- docs_fts: FTS5 over docs (title, content)

CREATE TABLE tool_uses (            -- per-turn tool-call records
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_uuid TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  turn_id INTEGER REFERENCES turns(id),
  tool_name TEXT NOT NULL, tool_input TEXT, timestamp TEXT,
  has_error INTEGER DEFAULT 0
);

CREATE TABLE summaries (            -- thread summaries
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  leaf_uuid TEXT, summary TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE recovery_buffer (      -- pre-compact snapshots, surfaced by user-prompt-submit hook
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT, project TEXT, content TEXT NOT NULL,
  created_at DATETIME DEFAULT (datetime('now'))
);

CREATE TABLE jobs (                 -- worker ingestion queue
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'ingest_thread',
  session_file TEXT, payload TEXT, project TEXT, project_name TEXT,
  status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
  attempts INTEGER DEFAULT 0, error TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  started_at DATETIME, completed_at DATETIME
);
```

## Migration Notes

- Migrations are manual one-shot `.cjs` scripts in `migrations/`; nothing runs them automatically on boot. The live schema is ensured by `ensureCanonicalSchema()` in `memory-schema.js`.
- SQLite cannot ALTER CHECK constraints - rebuild the table (rename old, create new, copy data, drop old).
- Always `PRAGMA foreign_keys = OFF` before a table rebuild, re-enable after.
- After FTS virtual-table changes: `INSERT INTO <fts_table>(<fts_table>) VALUES('rebuild')` to reindex.
- The sqlite-vec virtual table (`turn_embeddings`) can only be created/dropped from a process that has loaded the sqlite-vec extension (the plain `sqlite3` CLI cannot).

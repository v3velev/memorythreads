# Memory Server - Canonical Schema Reference

Schema version: **1** (as of 2026-03-08)

## Canonical MemoryThreads columns

The `threads` table now also stores native source tracking:

```sql
source_kind TEXT NOT NULL DEFAULT 'unknown',
source_session_id TEXT,
canonical_thread_id TEXT
```

`active_memory_threads` stores the currently selected canonical thread per app and cwd:

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

Codex Desktop and Claude Code stay as separate native source streams. MemoryThreads continuity comes from `canonical_thread_id`, not from sharing native session files.

## knowledge table

```sql
CREATE TABLE knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN (
    'preference', 'decision', 'fact', 'pattern',
    'architecture', 'tool_config', 'debugging',
    'correction', 'reasoning_chain', 'workaround', 'anti_pattern',
    'insight'
  )),
  scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN (
    'project', 'global', 'cross_project'
  )),
  project TEXT,
  scope_path TEXT,
  tags TEXT,
  concepts TEXT,
  source_type TEXT CHECK(source_type IN (
    'user_explicit', 'model_initiated', 'heuristic', 'llm_extracted'
  )),
  source_session TEXT,
  source_thread_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.60,
  reinforcement_count INTEGER NOT NULL DEFAULT 1,
  decay_rate REAL NOT NULL DEFAULT 0.30,
  last_accessed_at DATETIME,
  injection_success_rate REAL,
  metadata TEXT,                              -- JSON blob
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (
    'active', 'superseded', 'archived'
  )),
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
  git_commit_hash TEXT,                       -- commit hash when atom was created
  git_project_dir TEXT,                       -- repo path for git-aware staleness
  access_count INTEGER NOT NULL DEFAULT 0,
  impasse_severity REAL DEFAULT 0.0,          -- 0-1 severity for debugging impasses
  last_reinforced_at DATETIME,
  last_injected_at DATETIME,
  contradiction_note TEXT,                    -- appended notes on conflicting info
  superseded_by INTEGER REFERENCES knowledge(id),  -- points to replacement atom on merge/correction
  git_staleness TEXT                          -- human-readable staleness description
);
```

### Non-obvious columns

- **superseded_by** - When atoms are merged or corrected, the old atom gets `status='superseded'` and `superseded_by` points to the replacement atom's id. Used in `worker.js` consolidation merges.
- **git_staleness** - Set by `checkGitStaleness()` in worker.js when referenced files have changed significantly since atom creation. Human-readable string like `"utils.js changed 120 lines since abc12345"`.
- **impasse_severity** - Float 0-1 set during extraction when a debugging impasse is detected. Higher values indicate more severe/costly impasses.
- **contradiction_note** - Appended (not overwritten) with notes about conflicts, including git staleness annotations.

### Indexes

```sql
CREATE INDEX idx_knowledge_scope_project ON knowledge(scope, project);
CREATE INDEX idx_knowledge_type ON knowledge(type);
CREATE INDEX idx_knowledge_status ON knowledge(status);
CREATE INDEX idx_knowledge_confidence ON knowledge(confidence DESC) WHERE status = 'active';
CREATE INDEX idx_knowledge_source_thread ON knowledge(source_thread_id);
```

## FTS Virtual Tables

### knowledge_fts (stemmed - for recall/search)

```sql
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  content, tags,
  content='knowledge',
  content_rowid='id',
  tokenize='porter unicode61'
);
```

### knowledge_fts_exact (unstemmed - for exact identifier matching)

```sql
CREATE VIRTUAL TABLE knowledge_fts_exact USING fts5(
  content, tags,
  content='knowledge',
  content_rowid='id',
  tokenize='unicode61'
);
```

## FTS Triggers

All three triggers sync both `knowledge_fts` and `knowledge_fts_exact`, including the `tags` column.

```sql
CREATE TRIGGER knowledge_fts_ai AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts(rowid, content, tags)
  VALUES (new.id, new.content, COALESCE(new.tags,''));
  INSERT INTO knowledge_fts_exact(rowid, content, tags)
  VALUES (new.id, new.content, COALESCE(new.tags,''));
END;

CREATE TRIGGER knowledge_fts_ad AFTER DELETE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags)
  VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
  INSERT INTO knowledge_fts_exact(knowledge_fts_exact, rowid, content, tags)
  VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
END;

CREATE TRIGGER knowledge_fts_au AFTER UPDATE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags)
  VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
  INSERT INTO knowledge_fts(rowid, content, tags)
  VALUES (new.id, new.content, COALESCE(new.tags,''));
  INSERT INTO knowledge_fts_exact(knowledge_fts_exact, rowid, content, tags)
  VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
  INSERT INTO knowledge_fts_exact(rowid, content, tags)
  VALUES (new.id, new.content, COALESCE(new.tags,''));
END;
```

## Migration Notes

- SQLite cannot ALTER CHECK constraints - must rebuild table (rename old, create new, copy data, drop old)
- Always `PRAGMA foreign_keys = OFF` before table rebuild, re-enable after
- After rebuild: recreate all indexes and FTS triggers
- After FTS virtual table changes: run `INSERT INTO <fts_table>(<fts_table>) VALUES('rebuild')` to reindex

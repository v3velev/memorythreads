function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map(row => row.name));
}

function addColumn(db, tableName, columnName, ddl) {
  const columns = tableColumns(db, tableName);
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
  }
}

// Create the full core schema on a fresh database (idempotent). This is the
// single source of truth for the live schema - there is no migration runner.
// sqlite-vec must be loaded before calling (server.js/worker.js do this).
export function ensureBaseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project TEXT, project_name TEXT, turn_count INTEGER DEFAULT 0,
      timestamp_start TEXT, timestamp_end TEXT,
      priority TEXT DEFAULT 'routine',
      has_corrections INTEGER DEFAULT 0, has_decisions INTEGER DEFAULT 0, has_debugging INTEGER DEFAULT 0,
      source_file TEXT, file_mtime TEXT,
      created_at DATETIME DEFAULT (datetime('now')),
      source_kind TEXT NOT NULL DEFAULT 'unknown', source_session_id TEXT, canonical_thread_id TEXT
    );

    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL REFERENCES threads(id),
      turn_number INTEGER NOT NULL,
      user_content TEXT, assistant_content TEXT, timestamp TEXT,
      is_key_exchange INTEGER DEFAULT 0, key_exchange_type TEXT,
      tool_calls_count INTEGER DEFAULT 0, has_error INTEGER DEFAULT 0,
      embed_status TEXT DEFAULT 'pending',
      user_uuid TEXT, assistant_uuid TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_thread_turn ON turns(thread_id, turn_number);
    CREATE INDEX IF NOT EXISTS idx_turns_user_uuid ON turns(user_uuid) WHERE user_uuid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_turns_assistant_uuid ON turns(assistant_uuid) WHERE assistant_uuid IS NOT NULL;

    CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
      user_content, assistant_content,
      content='turns', content_rowid='id', tokenize='porter'
    );
    CREATE TRIGGER IF NOT EXISTS turns_fts_ai AFTER INSERT ON turns BEGIN
      INSERT INTO turns_fts(rowid, user_content, assistant_content) VALUES (new.id, new.user_content, new.assistant_content);
    END;
    CREATE TRIGGER IF NOT EXISTS turns_fts_ad AFTER DELETE ON turns BEGIN
      INSERT INTO turns_fts(turns_fts, rowid, user_content, assistant_content) VALUES('delete', old.id, old.user_content, old.assistant_content);
    END;
    CREATE TRIGGER IF NOT EXISTS turns_fts_au AFTER UPDATE ON turns BEGIN
      INSERT INTO turns_fts(turns_fts, rowid, user_content, assistant_content) VALUES('delete', old.id, old.user_content, old.assistant_content);
      INSERT INTO turns_fts(rowid, user_content, assistant_content) VALUES (new.id, new.user_content, new.assistant_content);
    END;

    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT,
      source TEXT UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      title, content, tags, content=docs, content_rowid=id
    );
    CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
      INSERT INTO docs_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, title, content, tags) VALUES('delete', old.id, old.title, old.content, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, title, content, tags) VALUES('delete', old.id, old.title, old.content, old.tags);
      INSERT INTO docs_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
    END;

    CREATE TABLE IF NOT EXISTS saved_threads (
      name TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id),
      session_id TEXT NOT NULL,
      project_path TEXT, note TEXT,
      saved_at TEXT DEFAULT CURRENT_TIMESTAMP, last_resumed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tool_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_uuid TEXT NOT NULL,
      thread_id TEXT NOT NULL REFERENCES threads(id),
      turn_id INTEGER REFERENCES turns(id),
      tool_name TEXT NOT NULL, tool_input TEXT, timestamp TEXT,
      has_error INTEGER DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_uses_dedup ON tool_uses(message_uuid, tool_name, tool_input);
    CREATE INDEX IF NOT EXISTS idx_tool_uses_thread ON tool_uses(thread_id);
    CREATE INDEX IF NOT EXISTS idx_tool_uses_tool ON tool_uses(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_uses_uuid ON tool_uses(message_uuid);

    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL REFERENCES threads(id),
      leaf_uuid TEXT, summary TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_summaries_thread ON summaries(thread_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_leaf ON summaries(leaf_uuid) WHERE leaf_uuid IS NOT NULL;

    CREATE TABLE IF NOT EXISTS recovery_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT, project TEXT, content TEXT NOT NULL,
      created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'ingest_thread',
      session_file TEXT, payload TEXT, project TEXT, project_name TEXT,
      status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0, error TEXT,
      created_at DATETIME DEFAULT (datetime('now')),
      started_at DATETIME, completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS stats_daily (
      date TEXT NOT NULL, metric TEXT NOT NULL, value REAL,
      PRIMARY KEY (date, metric)
    );
  `);

  // turn_embeddings is a vec0 virtual table needing the sqlite-vec extension.
  // server.js/worker.js load it before calling; skip gracefully if absent (e.g.
  // unit tests) so the rest of the schema still builds.
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS turn_embeddings USING vec0(turn_id INTEGER PRIMARY KEY, embedding float[1536] distance_metric=cosine);`);
  } catch { /* sqlite-vec not loaded */ }
}

export function ensureCanonicalSchema(db) {
  ensureBaseSchema(db);
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
}

export function getActiveCanonicalThread(db, app, cwd) {
  if (!app || !cwd) return null;
  return db.prepare(`
    SELECT *
    FROM active_memory_threads
    WHERE app = ? AND cwd = ?
  `).get(app, cwd) || null;
}

export function setActiveCanonicalThread(db, {
  app,
  cwd,
  canonicalThreadId,
  savedName = null,
  sourceSessionId = null,
}) {
  if (!app || !cwd || !canonicalThreadId) return;
  db.prepare(`
    INSERT INTO active_memory_threads
      (app, cwd, canonical_thread_id, saved_name, source_session_id, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(app, cwd) DO UPDATE SET
      canonical_thread_id = excluded.canonical_thread_id,
      saved_name = COALESCE(excluded.saved_name, active_memory_threads.saved_name),
      source_session_id = COALESCE(excluded.source_session_id, active_memory_threads.source_session_id),
      updated_at = datetime('now')
  `).run(app, cwd, canonicalThreadId, savedName, sourceSessionId);
}

export function getCanonicalThreadForSource(db, sourceKind, sourceSessionId, sourceFile) {
  if (!sourceKind || !sourceSessionId) return null;
  return db.prepare(`
    SELECT id, canonical_thread_id, turn_count
    FROM threads
    WHERE source_kind = ?
      AND source_session_id = ?
      AND source_file = ?
    LIMIT 1
  `).get(sourceKind, sourceSessionId, sourceFile) || null;
}

export function getThreadBySourceFile(db, sourceFile) {
  if (!sourceFile) return null;
  return db.prepare(`
    SELECT id, canonical_thread_id, turn_count
    FROM threads
    WHERE source_file = ?
    LIMIT 1
  `).get(sourceFile) || null;
}

export function sourceKindFromPath(filePath) {
  const path = String(filePath || "");
  if (path.includes("/.codex/sessions/")) return "codex";
  if (path.includes("/.claude/projects/") || path.includes("/snapshots/")) return "claude";
  return "unknown";
}

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map(row => row.name));
}

function addColumn(db, tableName, columnName, ddl) {
  const columns = tableColumns(db, tableName);
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
  }
}

export function ensureCanonicalSchema(db) {
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

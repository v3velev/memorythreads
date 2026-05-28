# Memory Server - Development Rules

## Schema
- Schema changes MUST update `SCHEMA.md` and increment `schema_version`
- SQLite CHECK constraint changes require table rebuild (see `migrate-check-constraints.cjs` pattern)
- After any migration: verify with `PRAGMA table_info`, test INSERTs for each status value, test FTS queries

## Migration Scripts
- Use `.cjs` extension (package.json has `"type": "module"`)
- Always back up DB before destructive migrations
- Follow pattern: backup -> count -> rebuild -> verify count -> drop old -> reindex
- FTS content-sync rebuild must happen OUTSIDE the table-rebuild transaction

## FTS
- Triggers must include ALL columns of the FTS virtual table (content AND tags)
- After virtual table schema changes: `INSERT INTO <fts>(<fts>) VALUES('rebuild')`

## Project vs ProjectName
- `project` is always a hash - used as DB key
- `projectName` is human-readable - used for semantic search/embeddings
- Never embed the project hash for semantic search (garbage similarity scores)

## Atom Creation
- Auto-extraction is DISABLED (Phase 6, 2026-03-16). `SKIP_AUTO_EXTRACTION = true` in worker.js.
- Atoms are only created via explicit `save_knowledge` MCP tool calls, approved by the user.
- To re-enable auto-extraction: set `SKIP_AUTO_EXTRACTION = false` in worker.js line ~848, and change `if (false && job.type === "ingest_thread")` back to `if (job.type === "ingest_thread")` in handleJob line ~1974.

## Incremental Sync
- `incremental-sync.js` runs via launchd WatchPaths (30s throttle) on `~/.claude/projects/`
- Sync state persisted in `data/sync-state.json`
- Turns inserted with `embed_status='pending'` - worker handles embedding
- FTS auto-populated by existing `turns_fts_ai` trigger on INSERT
- Dedup via `INSERT OR IGNORE` with `UNIQUE(thread_id, turn_number)`
- When modifying turn parsing logic, keep `transcript-parser.js`, `incremental-sync.js`, and `worker.js` in sync

## Canonical MemoryThreads
- `threads.source_kind` identifies `claude`, `codex`, `snapshot`, or `unknown`
- `threads.source_session_id` stores the native session id for that source
- `threads.canonical_thread_id` connects multiple native source streams to one MemoryThread
- `active_memory_threads` stores the selected canonical MemoryThread per app and cwd
- Codex Desktop continuation is memory based. It activates a canonical thread, then hooks inject context on each prompt
- Do not make Codex and Claude Code share native session files
- User prompt and compaction hooks must never emit recovery headers without actual recovered content

## recall_context Resolution Levels
- `resolution=0`: Raw individual turns (not grouped), ranked by BM25+vector
- `resolution=3` (default): Knowledge atoms, hybrid search
- `resolution=2`: Thread-level key exchanges
- `resolution=1`: Full thread content with intelligent truncation

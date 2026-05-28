# Claude Code Memory System - Complete Specification

The definitive blueprint for the memory system rebuild. Every detail needed to implement, every decision made and why, and how everything works in practice from start to finish.

---

## IMPLEMENTATION MANAGEMENT PROTOCOL

### How to Use This Document During Development

1. **Read order:** Start with the Execution Plan below. Each step references specific sections. Read only the referenced sections for each step - do not read the entire file at once.

2. **After implementing any step**, update the Implementation Status table below:
   - Set status to `COMPLETED` with date
   - If implemented as specified: add `As specified.`
   - If implemented differently: document WHAT changed, WHY, and the final approach. Example:
     ```
     COMPLETED 2026-03-08 - Modified: Changed recovery buffer from 5 to 8 turns
     because 5 was insufficient for long debugging sessions. Tested with 3 real
     compaction events. Final: 8 turns with 1000-token budget.
     ```

3. **Before making changes NOT specified in this document:** STOP. Ask user for verification. Do not auto-update the spec without explicit approval. Only exception: trivial typo/syntax fixes.

4. **If implementation reveals a contradiction between sections:** Flag it to the user. Do not silently pick one interpretation.

5. **Source of truth hierarchy:** This document > existing code. If code needs to differ, update this document FIRST (with user approval), then implement.

### Implementation Status

| Step | Status | Date | Notes |
|------|--------|------|-------|
| 1. Preparation | COMPLETED | 2026-03-07 | See deviations below. |
| 2. Database Migration | COMPLETED | 2026-03-07 | Verified: 37/37 checks pass. See deviations below. |
| 3. DB Write Helper | COMPLETED | 2026-03-07 | Verified: all special chars handled. See deviations below. |
| 4. Worker Rewrite | COMPLETED | 2026-03-07 | See Step 4 deviations below. |
| 5. Server Rewrite | COMPLETED | 2026-03-07 | 3 MCP tools (consolidated from 8, then 5->3 in Phase 4b), hybrid BM25+vector+RRF, ACT-R, multi-resolution. |
| 6. Hook Scripts | COMPLETED | 2026-03-07 | As specified. All 6 hooks with injection event tracking added. |
| 7. Watchdog Update | COMPLETED | 2026-03-07 | As specified. Node.js path resolution, PID recycling detection, failure counter. |
| 8. CLAUDE.md Updates | COMPLETED | 2026-03-07 | Added to global ~/.claude/CLAUDE.md only (sufficient, applies everywhere). |
| 9. Testing | COMPLETED | 2026-03-07 | 72 tests total: 32 worker + 13 search quality + 27 e2e. All passing. |
| 10. Phased Backfill | COMPLETED | 2026-03-07 | 766 sessions processed. ~660 active atoms. backfill.js script created. |
| Phase 3: ACT-R | COMPLETED | 2026-03-07 | See Phase 3 notes below. |
| Phase 4: Advanced | COMPLETED | 2026-03-07 | See Phase 4 notes below. |
| Phase 4b: Architectural | COMPLETED | 2026-03-08 | Transcript truncation, tool consolidation (5->3), injection cache. See Phase 4b notes below. |
| Phase 5: Atom Quality | COMPLETED | 2026-03-09 | Extraction rewrite (4 gates, prescriptive format), Haiku validator, intent-based injection. See Phase 5 notes below. |
| Phase 6: User-Approved Mode | COMPLETED | 2026-03-16 | Auto-extraction disabled, user-approved atoms only, file-system watcher, resolution 0, compaction improvements. See Phase 6 notes below. |

### Phase 6 Implementation Notes (2026-03-16)

Motivated by analysis of competing system (Claude Code Permanent Memory v2) and investigation of 18 unresolved repeat events that revealed auto-extraction was saving bad atoms (in-progress decisions, reversed architecture choices).

**35. Auto-extraction disabled** - `worker.js` `ingestThread()` now returns after Step 5 (turn storage + embeddings). Steps 5.5-7.1 (LLM extraction, validation, atom storage) are skipped via `SKIP_AUTO_EXTRACTION = true` flag at line ~848. Hindsight extraction also disabled (`if (false && ...)` at line ~1974). Turns and embeddings still fully functional for `recall_context` search.

**36. User-approved atom workflow** - `~/.claude/CLAUDE.md` updated. Claude proposes atoms at the end of responses with type and description. User approves with `y` before `save_knowledge` is called. Prevents bad atoms from being saved without human review.

**37. Resolution 0 (raw turn search)** - `server.js` new `hybridSearchRawTurns()` function and `formatResolution0()` formatter. Returns individual turns ranked by BM25+vector (not grouped by thread like resolution 2). Usage: `recall_context(query="...", resolution=0)`. Useful for "what did we discuss about X?" queries.

**38. Post-compaction raw turn injection** - `session-start-compact.sh` now injects last 20 raw turns (truncated to 150 chars each) from the project, in addition to recovery buffer and topic-aware atoms. Provides "what were we doing?" context after compaction. Added between Priority 1 (recovery buffer) and Priority 2 (atom injection).

**39. Static memory reminder** - `user-prompt-submit.sh` now outputs `Memory: recall_context available. Use /primeDB for full context load.` on every message where no signal-based injection triggers (short messages and no-signal messages). Keeps Claude aware the memory system exists after compaction.

**40. File-system watcher (incremental sync)** - New `incremental-sync.js` script + `com.claude.memory-sync.plist` launchd agent. Watches `~/.claude/projects/` via launchd `WatchPaths` with 30-second throttle. Parses JSONL transcripts, inserts new turns with `embed_status='pending'`. Worker handles embedding asynchronously. Sync state tracked in `data/sync-state.json`. Enables cross-session recall of open/unfinished sessions. Initial sync: 6,169 new turns from 485 files.

**41. Repeat events cleanup** - All 18 unresolved repeat events resolved. Atom #158 events (Chrome vs Electron) marked resolved (atom already archived, decision reversed). Atom #51 events (6 duplicate flags from single thread) marked resolved. Atoms #57, #62, #49, #55 reworded to be more prescriptive and confidence boosted to 0.90.

### Phase 3 Implementation Notes

16. **ACT-R scoring** - Implemented as specified. Formula: `0.75 * rrf + 0.25 * sigmoid(activation)`. Auto-activates at 150+ atoms. Per-type decay rates from TYPE_CONFIG.

17. **Impasse context detection** - Added query-time struggle signal scanning. Regex matches crash/error/stuck/broken/etc in query text. Sets `contextFlag = 1.0` when detected. Impasse boost formula: `finalScore *= (1.0 + 0.10 * impasse_severity * contextFlag)`. Only boosts impasse atoms when the user's query signals they're struggling.

18. **Weights** - Using 0.75/0.25 (spec said 0.7/0.3 in Decision 19, 0.75/0.25 in Phase 3 item 21). Went with 0.75/0.25 from the more specific Phase 3 spec. Can be tuned with real data.

### Phase 4 Implementation Notes (original)

19. **Injection feedback loop** - Fully implemented. Hooks write `injection_events` on every atom injection. Worker checks during ingestion: extracts key terms from atom content, checks if 30%+ appear in assistant responses after injection point. Referenced: +0.05 confidence. Unreferenced across 5+ events: -0.03 per event (floor 0.30). `injection_events` table FK was fixed (was referencing `knowledge_old` from migration, recreated to reference `knowledge`).

20. **Git-aware staleness** - Implemented in consolidation. Extracts file references from atom content (regex for .js/.ts/.py/etc). Resolves project directory from hash, runs `git log --stat` since atom creation date. If >50 lines changed in referenced file: -0.15 confidence + contradiction note. Also added 180-day fallback rule: flags very old unconfirmed atoms for consolidation review (not auto-archived).

21. **Connection discovery** - Implemented as `discover_connections` job type. After each ingestion, a low-priority job is queued. Computes normalized average of thread's turn embeddings, runs KNN against all turn embeddings, groups by thread. Stores connections with similarity >= 0.5 in the `connections` table (which already existed from migration).

22. **Worker concurrency** - Added CONCURRENCY=4. Poll loop claims up to 4 jobs in parallel using Promise.race pattern. Reduced backfill time from ~2.5 hours to ~40 minutes.

23. **Trivial session skip** - Sessions with 1 turn and < 500 chars total content are skipped during ingestion (no Haiku extraction call). Saves API cost on tiny sessions.

### Phase 4b: Architectural Improvements - COMPLETED 2026-03-08

24. **Transcript truncation** - `formatTranscriptForExtraction` now truncates long sessions to prevent exceeding Haiku's context window. If total formatted text exceeds 50K chars, keeps first 3 + last 5 turns and inserts `[... N turns omitted ...]` marker. Preserves session start (context/setup) and end (recent decisions/conclusions) while trimming repetitive middle turns.

25. **Tool consolidation (5 to 3)** - Merged `memory_feedback`, `memory_admin`, and `ingest_new_sessions` into a single `memory_manage` tool. Reduces MCP tool context overhead from 5 tool definitions to 3. The `memory_manage` tool uses an `action` enum to route: `feedback`, `batch_feedback`, `list`, `view`, `delete`, `edit`, `recent_extractions`, `reextract`, `archive_project`, `purge_archived`, `summary`, `stale`, `low_confidence`, `most_used`, `disk_usage`, `ingest_sessions`. All handler logic preserved, just reorganized under one tool. CLAUDE.md commands updated to use `memory_manage(action='...')`.

26. **Injection cache** - New `injection_cache` table pre-computes vector-quality atom matches per project so hooks can use semantic matching without live embedding calls (hooks have 500ms-1s timeouts, too short for API calls). Worker runs `refreshInjectionCache(project)` at the end of each ingestion. Process: loads all active atom embeddings for the project, generates embedding for project name (top 10 stored as `context_type='project_general'`), generates embeddings for file basenames extracted from recent atoms (top 5 per file stored as `context_type='file:<basename>'`). Hooks query cache first, fall back to FTS when cache is empty. `post-tool-use.sh` uses `file:<basename>` cache entries. `session-start-compact.sh` uses `project_general` cache entries. `user-prompt-submit.sh` unchanged (query-specific signals can't be pre-computed).

### Phase 5: Atom Quality - COMPLETED 2026-03-09

Problem: ~90% of extracted atoms were journal entries (task completions, resolved bugs, schema state) rather than actionable knowledge. The extraction prompt's "changes behavior" gate was interpreted too loosely.

27. **Extraction prompt rewrite** - Complete rewrite of `EXTRACTION_SYSTEM_PROMPT`. Added 4th gate: DURABLE ("Would this still prevent a mistake or save time 2 weeks from now?"). Enforced prescriptive format: all atom content must be "When X, do/don't Y because Z". Context capped at 200 chars (was unbounded "full war story"). Max atoms reduced from 3 to 2. Expanded DO NOT EXTRACT with concrete anti-examples: task completion reports, already-fixed bugs, code/schema state, meta-observations. New response fields: `justification` (which gates the atom passes), `obsolete_atom_ids` (existing atoms to auto-archive).

28. **Haiku validator** - New `validateAtoms()` function runs a second-pass validation via Haiku CLI. For each atom: KEEP or REJECT based on: descriptive vs prescriptive, stale in 2 weeks, discoverable from code, weak justification. Fail-open: if Haiku call errors, all atoms are kept. Applied to both main extraction and hindsight atoms.

29. **`callClaudeCLI` model parameter** - Added `model` parameter (default "sonnet"). Validator uses "haiku".

30. **`storeAtom` changes** - `justification` added to metadata skip set (stored in metadata JSON but not merged into atom content). Context truncated to 200 chars belt-and-suspenders (prompt also instructs 200 max).

31. **Obsolete atom auto-archiving** - After storage loop, iterates `extraction.obsolete_atom_ids`. For each: verifies atom exists and is active, sets `status = 'archived'`, deletes embedding. Follows existing consolidation archive pattern.

32. **Existing atoms context reframing** - Header changed from "EXISTING KNOWLEDGE (do NOT re-extract these)" to "EXISTING ATOMS (do NOT re-extract)" with instruction to add obsolete IDs to `obsolete_atom_ids`.

33. **Hindsight prompt rewrite** - Narrowed focus exclusively to repeat events (recurring problems with no existing atom coverage). Removed "EMERGING PATTERNS" and "MISSED EXTRACTIONS". Max atoms reduced from 2 to 1. Same prescriptive format + justification as main extraction.

34. **Intent-based injection (Signal 5)** - `user-prompt-submit.sh` previously required one of 4 specific signals (file path, error string, PascalCase, problem word) before FTS search would run. This meant most "about to make a mistake" prompts never reached FTS, even when matching atoms existed. Added Signal 5: any prompt >= 40 chars with 3+ significant non-stopword terms triggers OR-based FTS search with a higher confidence floor (0.80 vs 0.70 for signals 1-4). Signals 1-4 still take priority (checked first). Extensive stopword list prevents noise from common terms.

### Items NOT Implemented (with reasons)

| Item | Reason |
|------|--------|
| ~~Non-stemmed FTS5 index (item 29)~~ | **IMPLEMENTED** - `knowledge_fts_exact` with `unicode61` tokenizer. 3rd RRF signal in hybrid search. |
| Topic segmentation for long threads (item 30) | No threads with 50+ turns exist yet. Implement when needed. |
| Parameter tuning (items 22-23, 27-28) | Requires weeks of real usage data. Current values (RRF k=15, dedup 0.08, ACT-R 0.75/0.25) are reasonable defaults. |
| Per-project CLAUDE.md slash commands | Global CLAUDE.md applies everywhere. Per-project copies would be redundant and create maintenance burden. |

### Steps 1-3 Deviations From Spec

1. **`.cjs` extension required** - `package.json` has `"type": "module"`, so `require()` fails in `.js` files. `migrate.js` renamed to `migrate.cjs`. `db-write.js` created as symlink to `db-write.cjs` (hooks reference `.js`). Future scripts (worker.js, server.js) will use ESM imports natively.

2. **vec0 INSERT needs CAST** - `better-sqlite3` parameterized `?` values aren't recognized as integers by sqlite-vec. Fix: `INSERT INTO knowledge_embeddings (atom_id, embedding) VALUES (CAST(? AS INTEGER), ?)`. This applies to all vec0 table inserts.

3. **`injection_events.trigger` renamed to `trigger_type`** - `trigger` is a SQL reserved word. Column renamed to `trigger_type` with same CHECK constraint values.

4. **`datetime("now")` quoting** - In `better-sqlite3` prepared statements, double-quoted `"now"` is interpreted as an identifier, not a string. Fix: use `datetime('now')` inside double-quoted JS strings, or single-quoted SQL with escaped quotes.

5. **Skipped `@anthropic-ai/sdk`** - Not installed per plan (using Claude CLI for Haiku extraction in Step 4).

6. **Old `server.js` and `worker.js` patched** - Added `import sqliteVec from "sqlite-vec"` and `sqliteVec.load(db)` to both files. Without this, opening the migrated DB fails with "malformed database schema" because SQLite validates vec0 virtual table references on connection open. MCP server process must be restarted after migration to pick up the patch.

7. **`knowledge_fts` rebuilt** - Old FTS5 table had 3 columns (content, tags, concepts). New schema has 2 (content, tags). Dropped and recreated the virtual table with triggers, then backfilled FTS index from active atoms.

8. **`jobs` table recreated** - Old table had different CHECK types (extract_knowledge, consolidate, promote_global, decay). Dropped and recreated with new types (ingest_thread, consolidate, archive_stale, discover_connections). Old job history (145 rows, all completed) was discarded.

9. **knowledge table type/scope/source_type CHECK constraints not updated** - The existing CHECK constraints on the knowledge table (e.g., type only allows 7 types, not the 11 in new schema) were NOT changed in this migration. ALTER TABLE cannot modify CHECK constraints; this requires table recreation. Deferred to Step 4/5 when worker/server are rewritten and can handle the full table migration. **RESOLVED in Step 4** - see deviation 10.

### Step 4 Deviations From Spec

10. **CHECK constraints updated via table recreation** - Ran `migrate-check-constraints.cjs` before worker rewrite. Recreated knowledge table with expanded type CHECK (added correction, reasoning_chain, workaround, anti_pattern), expanded source_type CHECK (added llm_extracted), and new columns (source_thread_id TEXT, metadata TEXT). Also dropped stale knowledge_trigram triggers (table was already removed in Step 2). All 1494 rows preserved. Verified via better-sqlite3 insert/delete cycle.

11. **Claude CLI instead of @anthropic-ai/sdk** - Uses `claude -p --model haiku --output-format json --tools "" --no-session-persistence --system-prompt "..."` via `child_process.execFile`. Avoids separate API billing (uses Claude subscription). System prompt instructs raw JSON output. Code fence stripping handles occasional markdown wrapping. Retry once on parse failure. Tested with 3 transcript types (bug fix, routine, decision-heavy) - all produced valid extraction JSON. Per-session cost ~$0.05 via subscription credits.

12. **sqlite-vec ESM import changed** - Node v24 broke `import sqliteVec from "sqlite-vec"` (no default export). Changed to `import { load as loadSqliteVec } from "sqlite-vec"`. This also needs to be applied to server.js in Step 5.

13. **Consolidation and scheduled jobs use Claude CLI** - Same CLI approach as extraction. Consolidation prompt asks for merge/archive/contradiction recommendations. Daily backup, snapshot cleanup, and archive_stale run as scheduled checks in the poll loop (not as queued jobs for backup/stats).

14. **No Anthropic API key validation at startup** - Since we use CLI (subscription-based), no ANTHROPIC_API_KEY needed. Only OPENAI_API_KEY is validated at startup with a test embedding call.

15. **stats_daily table schema mismatch** - The stats snapshot INSERT failed because the existing stats_daily table schema doesn't match the new columns. Logged and skipped gracefully. Will be fixed in a future step if needed.

---

## EXECUTION PLAN

Each step references specific sections. Read ONLY those sections for each step.

### Step 1: Preparation
**Read:** Section 25 (Setup and Installation)
**Do:**
- `cd ~/.claude/memory-server`
- Backup: `cp -r . ../memory-server-backup-$(date +%Y%m%d)`
- `npm install sqlite-vec openai @anthropic-ai/sdk`
- Create `.env` with ANTHROPIC_API_KEY and OPENAI_API_KEY (`chmod 600`)
- `which node > .node-path`
- `brew install jq` (if not installed)
- Verify: `jq --version`, `node --version` (>= 18)

### Step 2: Database Migration (migrate.js)
**Read:** Section 16 (Database Schema), Section 24 (sqlite-vec Loading)
**Do:** Write `migrate.js` that:
1. Backs up memory.db (`sqlite3 data/memory.db ".backup data/memory-backup.db"`)
2. Creates all new tables per Section 16 schema
3. Adds new columns to knowledge: `decay_rate`, `impasse_severity`, `last_injected_at`, `contradiction_note`
4. NOTE: Does NOT create `topic_hash`, `valid_at`, or `invalid_at` (cut from v1 - see Changes Log)
5. Backfills `decay_rate` on existing atoms from TYPE_CONFIG
6. Drops `concept_synonyms` and `knowledge_trigram` tables
7. Cleans garbage/duplicate atoms
8. Generates embeddings for existing clean atoms via OpenAI
9. Inserts `schema_version` row with `embedding_model`
10. Enables `PRAGMA foreign_keys = ON`

### Step 3: DB Write Helper (db-write.js)
**Read:** Section 13 (Hooks Architecture) - the db-write.js code
**Do:** Create `db-write.js` for parameterized SQL writes from hooks. Test with sample input.

### Step 4: Worker Rewrite (worker.js)
**Read:** Sections 7 (Ingestion Pipeline), 9 (LLM Extraction), 17 (Worker Process)
**Key changes from original spec (integrated into those sections):**
- Streaming JSONL parser (readline, not readFileSync)
- `impasse_severity` as float (0.0-1.0), not binary
- No `topic_hash` generation
- Graceful degradation when OpenAI is down (store without embeddings, embed_status='pending')
- Atom content length enforcement (1200 chars max, metadata inlined into content)
- Thread metadata update on second ingestion
- Dedup score logging for threshold validation
- Contradiction storage in consolidation (knowledge.contradiction_note)
- Temporal awareness in consolidation prompt (7-day rule)
- `save_knowledge` sets `decay_rate` from TYPE_CONFIG
- Thread ID includes source file basename for entropy

### Step 5: Server Rewrite (server.js) - COMPLETED 2026-03-07
**Read:** Sections 8 (Retrieval Pipeline), 10 (Hybrid Search), 14 (MCP Tools)
**Implemented:**
- Hybrid BM25+vector+RRF (k=15) search with FTS5 query sanitization
- Multi-resolution (1/2/3) with expand, fallbacks, truncation (10k token soft cap)
- ACT-R re-ranking auto-activates at 150+ atoms with per-type decay rates
- Impasse context detection: scans query for struggle signals, contextFlag multiplier
- File enrichment as post-RRF 15% boost
- Priority tiebreaker at 5% threshold
- Thread grouping with Math.log2 coefficient (0.15)
- Embedding LRU cache (20 entries)
- All 5 MCP tools: recall_context, save_knowledge, memory_feedback, memory_admin, ingest_new_sessions
- Cosine dedup (distance < 0.20) on save_knowledge
- Source thread_id in atom results for expansion
- Worker health check + auto-spawn on startup

### Step 6: Hook Scripts - COMPLETED 2026-03-07
**Implemented:** All 6 hooks rewritten:
- `pre-compact.sh` - Recovery buffer via db-write.js, hard link snapshot, queue ingest job
- `stop.sh` - Duplicate ingestion prevention, seen file cleanup
- `post-tool-use.sh` - session_id rate limit, per-session cap of 3, confidence >= 0.70, injection_events tracking
- `user-prompt-submit.sh` - 4 signal types (file path, error, PascalCase 3+, problem language), FTS5 sanitization, injection_events tracking
- `session-start-cold.sh` - Worker-disabled check, one-line reminder
- `session-start-compact.sh` - Session-scoped recovery buffer, topic-aware atoms, injection_events tracking
- All registered in `~/.claude/settings.json`

### Step 7: Watchdog Update - COMPLETED 2026-03-07
**Implemented:** watchdog.sh with Node.js path resolution (.node-path file + fallback scan), PID recycling detection (verifies process is node, not just alive), failure counter with auto-disable after 5 consecutive failures (.worker-disabled flag), launchd plist for 5-minute intervals.

### Step 8: CLAUDE.md Updates - COMPLETED 2026-03-07
**Implemented:** Added to global `~/.claude/CLAUDE.md`:
- `## Memory Commands` section with /primeDB (progressive disclosure), /saveDB (confirmation step, max 5 items), /reviewDB (recent extractions audit), /forgetDB (topic-based deletion with confirmation)
- `## Memory Tool Usage` section for proactive tool usage guidance
- Per-project CLAUDE.md not updated (global is sufficient, applies everywhere)

### Step 9: Testing - COMPLETED 2026-03-07
**Implemented:** 72 tests across 3 test files:
- `test-worker.js` - 32 tests (DB, env, parsing, embedding, extraction, dedup)
- `test-search-quality.js` - 13 tests (BM25, vector, temporal, resolution, edge cases)
- `test-e2e.js` - 27 tests (ingest, threads, atoms, search, save, dedup, feedback, admin, hooks, health)
- All tests passing. Discovered schema notes: turns use user_content/assistant_content (not role/content), turn_number (not turn_index), embeddings are 1536 dimensions.

### Step 10: Phased Backfill - COMPLETED 2026-03-07
**Implemented:** `backfill.js` script with --limit, --project, --dry-run, --priority flags.
- Phase A: 10 sessions at priority 3 - all processed, 0 failures
- Phase B: 50 sessions at priority 2 - all processed, 0 failures
- Phase C: 354 remaining at priority 1 - processed in background
- Consolidation ran successfully during backfill: 22 actions (merges, archives, contradiction flags)
- Result: ~660 active atoms across 11 types, ~170 threads
- Worker concurrency (CONCURRENCY=4) added to speed up processing

---

## CHANGES FROM ANALYSIS SESSION (2026-03-06)

All changes below have been integrated into the relevant sections of this document. This log exists for traceability.

### Schema Changes
1. **REMOVED: `topic_hash` column** - Implementation was undefined ("key noun phrases" never specified). Consolidation handles temporal grouping via Haiku semantic understanding. When any type exceeds 50 atoms, add cosine-based pre-clustering.
2. **REMOVED: `valid_at` column** - Redundant with `status` field. `invalid_at IS NULL` is equivalent to `status = 'active'`. Simplifies all retrieval queries.
3. **REMOVED: `invalid_at` column** - Same rationale as `valid_at`.
4. **RENAMED: `impasse_weight` -> `impasse_severity`** - Changed from binary (0/1) to float (0.0-1.0). Binary tagged ~30-40% of sessions, destroying discriminative power. Float lets Haiku distinguish quick fixes from nightmares.
5. **ADDED: `last_injected_at` column** - Tracks when hooks last injected this atom. Enables injection monitoring and future dedup.
6. **ADDED: `contradiction_note` column** - Stores contradictions found by consolidation. Previously logged to console only.
7. **ADDED: `embedding_model` to `schema_version`** - Single place to track model version. Triggers backfill on model change.

### Bug Fixes
8. **`save_knowledge` must set `decay_rate`** - Was only set in worker extraction pipeline. Explicit saves got NULL, causing NaN in ACT-R formula.
9. **Impasse boost formula was broken** - `0.05 * 0.10 = 0.005` was negligible. Changed to multiplicative: `base_score * (1 + 0.10 * impasse_severity * context_flag)`.
10. **Thread metadata not updated on second ingestion** - Full session ingestion after PreCompact snapshot didn't update turn_count, priority, etc.
11. **No graceful degradation when OpenAI down** - Now stores atoms/turns without embeddings (`embed_status='pending'`). Backfilled on next successful connection.

### Hook Token Optimization
12. **PostToolUse: session_id rate limiting** - PPID was fragile (PID reuse). session_id is stable per Claude Code session.
13. **PostToolUse: narrowed skip list** - Only skip pure config files (package.json, tsconfig, etc.). Removed index, utils, types, etc. FTS5 handles no-match silently.
14. **PostToolUse: confidence >= 0.70** - Raised from 0.50. Auto-injection should use only reasonably confident atoms.
15. **PostToolUse: per-session cap of 3** - Prevents excessive injection during exploratory file reading.
16. **UserPromptSubmit Signal 4: first 40 chars only** - "add error handling" (instruction) no longer triggers. "the calendar is broken" (problem report) still triggers.
17. **UserPromptSubmit Signal 4: removed "error"/"issue"** - Too generic. Kept: crash, broken, fail, wrong, stuck, bug.
18. **UserPromptSubmit Signal 4: FTS5 sanitization** - Strip operators (AND/OR/NOT/NEAR, parentheses, quotes) before MATCH query.
19. **UserPromptSubmit Signal 4: require 2+ non-stopwords** - Prevents garbage queries from short remaining text.
20. **PreCompact: Node.js helper for SQL** - Eliminates backslash-single-quote edge case in recovery buffer content.
21. **PreCompact: 10 turns** - Post-compaction is the highest-stakes injection point. 200K context can absorb ~2000 tokens of recovery.
22. **PreCompact: include recently modified files** - Header in recovery buffer. Near-zero cost.
23. **SessionStart/compact: no project-level fallback** - Prevents cross-session contamination with multiple terminals.
24. **SessionStart/compact: topic-aware atom selection** - Keywords from recovery buffer drive FTS5 atom selection instead of confidence-only.
25. **SessionStart/compact: explicit recall_context instruction** - Tells Claude how to load more context if /primeDB isn't recognized post-compaction.

### Retrieval Pipeline
26. **File enrichment as post-RRF boost** - Was corrupting query. Now applies 15% boost after RRF merge for atoms mentioning relevant files.
27. **Source `thread_id` in atom results** - Enables direct `expand` call without round-trip search.
28. **No atom content length cap** - Content stored in full. Metadata is inlined into the content field so it's visible at injection time. The extraction prompt tells Haiku to put all reasoning directly in content. The worker merges any extra metadata fields into content before storing.

### Consolidation
29. **Contradictions stored** - `knowledge.contradiction_note` column. Surfaced via `memory_admin(action='contradictions')`.
30. **Temporal awareness: 7-day rule** - Atoms about same topic created >7 days apart are temporal versions. Archive older, don't merge.
31. **Pre-clustering note** - When any type exceeds 50 atoms, use cosine-based pre-clustering before Haiku review.

### New Tools and Commands
32. **`memory_admin` fully specified** - list/view/delete/edit/recent_extractions/reextract.
33. **ACT-R auto-activation** - Enables at 150+ active atoms automatically. Shows status in `memory_admin(action='summary')`.
34. **/reviewDB** - Periodic extraction quality check slash command.
35. **/forgetDB** - Topic-based atom deletion with confirmation.
36. **/saveDB confirmation step** - Lists items before saving, waits for user approval. Max 5 items.

### Worker and Infrastructure
37. **Streaming JSONL parser** - `readline` instead of `readFileSync`. Prevents memory pressure during backfill.
38. **Watchdog failure tracking** - Cooldown after 5 consecutive failures. Cold-start hook warns user.
39. **Phased backfill** - 10 then 50 then 340 sessions with quality review between phases.
40. **Dedup score logging** - Validates the 0.92 cosine threshold with empirical data.

### Documentation
41. **CONCEPT_MAP specified** - Contents, format, and behavior defined in Section 10.
42. **Few-shot examples diversified** - Added reasoning chain example to extraction prompt.
43. **Impasse calibration guidance** - Most sessions should be 0.0. Only 10-15% above 0.5.
44. **Cost calculations corrected** - All updated for Haiku 4.5 pricing ($1/$5 per MTok).

---

## CHANGES FROM CODE AUDIT (2026-03-08)

Four issues found during deep code review. All fixed and verified.

### Extraction Quality
45. **No content cap, metadata inlined** - Metadata (reasoning, alternatives, triggers) is now merged into the content field by `storeAtom` so it's visible when atoms are injected by hooks. No truncation - full content is stored. The extraction prompt instructs Haiku to put all reasoning in the content field directly. Any extra JSON fields Haiku emits are appended to content as key-value lines. Existing atoms backfilled via `backfill-metadata.cjs`. Files changed: `worker.js` (storeAtom, extraction prompt, extractFileReferences).

### Hook Consistency
46. **Added confidence >= 0.70 floor to session-start-compact.sh** - Both the topic-aware query and the fallback query were missing the confidence threshold that `user-prompt-submit.sh` and `post-tool-use.sh` already had. Low-confidence atoms (0.30) could be injected post-compaction. Now consistent across all 3 injection hooks. Files changed: `hooks/session-start-compact.sh`.

47. **Added knowledge_fts_exact as second FTS signal in all injection hooks** - The server's hybrid search uses 3 signals (stemmed BM25, non-stemmed BM25, vector KNN). All 3 injection hooks were only using stemmed BM25. Added the non-stemmed `knowledge_fts_exact` table via OR subquery. This catches identifiers like `useInfiniteQuery` that Porter stemming mangles to `infinit`. Files changed: `hooks/user-prompt-submit.sh`, `hooks/post-tool-use.sh`, `hooks/session-start-compact.sh`.

### Consolidation Fix
48. **Tags regenerated on merge** - When consolidation merges atoms, the content and embedding were updated but `enrichConcepts()` was not called to regenerate tags. The merged atom kept stale concept-expansion tags from the original content, degrading FTS5 recall. Added `enrichConcepts()` call + tags UPDATE in the merge transaction. Required duplicating `CONCEPT_MAP` and `enrichConcepts()` into `worker.js` (previously only in `server.js`). Files changed: `worker.js` (runConsolidation, added CONCEPT_MAP+enrichConcepts).

---

## Table of Contents

1. [What This System Does](#1-what-this-system-does)
2. [Current System - What Exists Today](#2-current-system---what-exists-today)
3. [What's Wrong With The Current System](#3-whats-wrong-with-the-current-system)
4. [Decisions Made and Why](#4-decisions-made-and-why)
5. [The New System - Complete Architecture](#5-the-new-system---complete-architecture)
6. [How It Works In Practice - A Full Day](#6-how-it-works-in-practice---a-full-day)
7. [Data Flow - Ingestion Pipeline](#7-data-flow---ingestion-pipeline)
8. [Data Flow - Retrieval Pipeline](#8-data-flow---retrieval-pipeline)
9. [LLM Extraction - The Core Innovation](#9-llm-extraction---the-core-innovation)
10. [Hybrid Search Engine](#10-hybrid-search-engine)
11. [Multi-Resolution Memory Model](#11-multi-resolution-memory-model)
12. [Thread-Level Storage and Retrieval](#12-thread-level-storage-and-retrieval)
13. [Hooks Architecture](#13-hooks-architecture)
14. [MCP Tools - What Claude Can Call](#14-mcp-tools---what-claude-can-call)
15. [Slash Commands - /primeDB and /saveDB](#15-slash-commands---primedb-and-savedb)
16. [Database Schema](#16-database-schema)
17. [Worker Process](#17-worker-process)
18. [File Inventory - What Gets Rewritten](#18-file-inventory---what-gets-rewritten)
19. [Build Phases](#19-build-phases)
20. [What Was Cut and Why](#20-what-was-cut-and-why)
21. [Parameters and Their Values](#21-parameters-and-their-values)
22. [Hook Input JSON Schemas](#22-hook-input-json-schemas)
23. [JSONL Transcript Format](#23-jsonl-transcript-format)
24. [sqlite-vec Loading](#24-sqlite-vec-loading)
25. [Setup and Installation](#25-setup-and-installation)
26. [Launchd Plist - Watchdog](#26-launchd-plist---watchdog)

---

## 0. Bugs Found and Fixed (2026-03-06)

Three critical bugs were causing the knowledge database to fill with garbage duplicates. Before fixes: 1,456 active atoms, only 105 unique content strings (92.8% duplicates). After fixes: 2 clean atoms remain, system ready for fresh accumulation.

### Bug 1: Hooks re-queue the same transcript dozens of times

**Root cause:** `pre-compact.sh` fires on every auto-compaction and `stop.sh` fires on session end. Neither checked if a job for that transcript already existed. Long sessions with many compactions queued the same transcript 43+ times. Each extraction run produced duplicate atoms.

**Fix:** Both hooks now check `SELECT COUNT(*) FROM jobs WHERE type = 'extract_knowledge' AND payload LIKE ... AND status IN ('pending', 'processing')` before inserting. Worker also checks `sessions.file_path` to skip already-processed transcripts.

### Bug 2: Signal scoring passed user prompts as "corrections"

**Root cause:** The `correction` signal pattern `/\bi\s+(said|meant|want)\b/i` scored 3 points (instant pass threshold). This matched nearly every user instruction ("I want you to...", "I want a lot of..."), causing raw user prompts to be stored as knowledge atoms.

**Fix:** Changed pattern to `/\bi\s+(said|meant)\s+(to|that|it)\b/i` - requires "said to/that/it" or "meant to/that/it", which are actual corrections. Added noise filter patterns for meta-discussion, agent instructions, and research session content.

### Bug 3: FTS5 dedup silently failed, creating duplicates

**Root cause:** The `deduplicateAtom` function used FTS5 MATCH with a `catch {}` that returned `{ action: "create" }` on any error. Content with special characters produced invalid FTS5 queries, so dedup never ran. Also, only 5 key terms were used (`.slice(0, 5)`), insufficient for matching long content.

**Fix:** Added Stage 0 exact-match check (`WHERE content = ?`) that catches all perfect duplicates regardless of FTS5. Increased key terms to 8 with stopword filtering. FTS5 catch block now falls back to trigram search instead of silently creating.

### Haiku pricing correction

The blueprint assumes Haiku at $0.25/$1.25 per MTok. Current Haiku 4.5 pricing is $1/$5 per MTok (4x higher). Per-session cost is still low (~$0.004) but backfill economics change significantly.

---

## 1. What This System Does

A persistent memory system for Claude Code. It solves four problems:

**Problem 1: Claude forgets everything between sessions.** Every new session starts blank. You re-explain decisions, re-describe architecture, re-state preferences. The memory system captures important knowledge from every session and makes it available in future sessions.

**Problem 2: Claude loses context when it compacts.** During long sessions, Claude Code compresses the conversation to free up context window space. Details get lost. The memory system captures the full transcript before compaction and re-injects critical knowledge after.

**Problem 3: Past experiences are not searchable.** You debugged an OAuth issue 3 weeks ago. Now you're hitting something similar. Without memory, you start from scratch. With memory, Claude can search for and find that past debugging session.

**Problem 4: Conclusions are remembered, but reasoning methods are lost.** When a past bug fix is found, only the answer is stored ("root cause was null timestamps"). The diagnostic METHOD that led to the answer ("compare working vs broken API responses to isolate the differing variable") is lost. These transferable reasoning methods are the most valuable knowledge for solving similar-but-not-identical problems. The memory system extracts and stores reasoning chains alongside conclusions.

**Design principles:**
- Capture automatically, retrieve on demand. You never want to miss saving something. But YOU control when memory gets loaded into a session.
- LLM extraction over regex. Use an actual language model to understand conversations, not pattern matching.
- Structured output over hope. Use Anthropic's tool_use feature for extraction, not free-form JSON.
- Hybrid search. Keywords (BM25) for exact matches + vectors (embeddings) for semantic similarity. Neither alone is sufficient.
- Multi-resolution. Store at three levels of detail. Inject at the right level for the situation.
- File-aware retrieval. When Claude reads or edits a file, automatically surface past knowledge about that file/component via PostToolUse hook.
- Pre-process before LLM. Strip tool_use blocks and tool results from transcripts before sending to Haiku. Cuts costs 60-80% and improves extraction quality.
- Simple over complex. SQLite for everything. No external databases. No distributed systems. Runs locally.

---

## 2. Current System - What Exists Today

### File Structure

```
~/.claude/memory-server/
  server.js              -- MCP server, 6 tools, ~800 lines
  worker.js              -- Background processor, ~730 lines
  watchdog.sh            -- Ensures worker stays alive
  package.json           -- Dependencies: @modelcontextprotocol/sdk, better-sqlite3
  package-lock.json
  node_modules/
  worker.pid             -- Worker process ID
  snapshots/             -- Transcript copies from PreCompact hook
  ARCHITECTURE.md        -- Original architecture vision document (1,295 lines)
  BLUEPRINT.md           -- First revision of this document (to be replaced by SYSTEM.md)
  data/
    memory.db            -- SQLite database (WAL mode), 7.1 MB
    memory.db-shm
    memory.db-wal
    memory-backup.db     -- Daily backup
  logs/
    worker.log           -- Worker activity log
    hooks.log            -- Hook stderr logging
    watchdog-stdout.log  -- Watchdog launchd stdout
    watchdog-stderr.log  -- Watchdog launchd stderr
  hooks/
    pre-compact.sh       -- Fires before context compaction
    stop.sh              -- Fires when session ends
    session-start-compact.sh   -- Fires after compaction
    session-start-cold.sh      -- Fires on first session open
    user-prompt-submit.sh      -- Fires on every user message

~/Library/LaunchAgents/
  com.claude.memory-watchdog.plist   -- Runs watchdog every 5 minutes

~/.claude/settings.json              -- Hook registrations
```

### Database Tables (Current)

| Table | Rows | Purpose | Status |
|-------|------|---------|--------|
| knowledge | 34 | Knowledge atoms (facts, decisions, preferences) | Active, but contains garbage from regex extraction |
| knowledge_fts | - | FTS5 index on knowledge (porter+unicode61) | Working |
| knowledge_trigram | - | FTS5 trigram index on knowledge | Working but redundant |
| messages | 3,443 | Raw message archive (full text, no cap) | Working |
| messages_fts | - | FTS5 index on messages | Working |
| sessions | 407 | Session metadata (file paths, timestamps, projects) | Working |
| concept_synonyms | 1,102 | Query expansion pairs (24 synonym groups) | Working but being removed |
| jobs | 25 | Async work queue | Working, all jobs completed |
| retrieval_events | 0 | Tracks when knowledge is retrieved | Schema exists, recently added |
| feedback_events | 0 | Tracks user feedback signals | Schema exists, recently added |
| corrections | 0 | Tracks atom corrections | Schema exists, never populated |
| feedback_prompts | 0 | Tracks feedback prompt events | Schema exists, never used |
| knowledge_sightings | 0 | Cross-project atom tracking | Schema exists, never populated |

### MCP Tools (Current - 3 tools)

1. **recall_context** - Hybrid BM25+vector search. Multi-resolution (atoms/exchanges/threads). include_threads param for raw turn search.
2. **save_knowledge** - Saves atoms with concept enrichment, cosine dedup, scope detection.
3. **memory_manage** - Unified management tool (merged memory_feedback + memory_admin + ingest_new_sessions). Actions: feedback, batch_feedback, list, view, delete, edit, recent_extractions, reextract, archive_project, purge_archived, summary, stale, low_confidence, most_used, disk_usage, ingest_sessions.

### Hooks (Current)

All 5 hooks are wired in `~/.claude/settings.json` and working:
- **PreCompact (2s):** Copies transcript to snapshots/, queues extraction job
- **Stop (2s):** Queues extraction job
- **SessionStart/compact (1s):** Queries top 10 atoms, injects as context
- **SessionStart/cold (1s):** Checks if 24h+ since last session and injects top 5 atoms
- **UserPromptSubmit (500ms):** Scans message for file paths, error strings, tech+verb patterns. If signal found, injects matching atoms.

### Worker (Current)

Separate Node.js process, polls jobs table every 3-15 seconds. Processes:
- **extract_knowledge:** Reads JSONL transcripts, splits into sentences, runs regex signal scoring, saves atoms if score >= 3
- **decay:** Applies time-based confidence decay per knowledge type
- **promote_global:** Promotes atoms seen in 3+ projects to global scope
- **consolidate:** Stub, not implemented

Monitored by launchd watchdog that checks every 5 minutes.

### What Works Well

- Hook lifecycle integration (PreCompact/Stop capture, SessionStart/UserPromptSubmit injection)
- Raw message archive (3,443 messages, 407 sessions, full text, no cap)
- Knowledge save pipeline (dedup with Jaccard, concept enrichment, scope detection)
- Worker job queue (reliable, handles failures)
- Watchdog (keeps worker alive)

### What's Broken

See next section.

---

## 3. What's Wrong With The Current System

### Problem 1: Regex extraction produces garbage

The worker's `extractFromTranscript` function splits messages into sentences and runs regex signal scoring. In practice:
- It extracted meta-commentary about the memory system itself as "knowledge"
- Created duplicate atoms (atoms #22/#24/#26/#28 are identical, atoms #23/#25/#27/#29 are identical)
- 31 of 34 atoms are `source_type='heuristic'` (regex-extracted), most are low quality
- Only 3 atoms are `source_type='user_explicit'` (manually saved)
- The regex can't distinguish "we chose Supabase" (valuable decision) from "he chose to leave early" (noise)

**Root cause:** Regex pattern matching can't understand conversational context.

**Fix:** Replace with LLM-based extraction using Haiku with structured output (tool_use).

### Problem 2: No vector embeddings - search is keyword-only

Search is FTS5 only (Porter stemmer + trigram). This means:
- "How did we handle rate limiting" won't find threads about "throttling" and "429 errors"
- "Email integration API" won't find atoms about "Unipile" unless that exact word appears
- The 1,102 synonym pairs partially compensate, but they're hand-curated, noisy, and can't cover every semantic relationship

**Root cause:** FTS5 matches words, not meaning.

**Fix:** Add OpenAI text-embedding-3-small embeddings + sqlite-vec (with `distance_metric=cosine`) for vector search. Remove synonym table.

### Problem 3: No thread-level retrieval

Messages are stored flat in the `messages` table. You can search for individual messages but can't retrieve a full conversation thread.

**Root cause:** The schema has no thread/turn structure.

**Fix:** New threads/turns tables with parent-child retrieval pattern.

### Problem 4: SessionStart hooks waste tokens

Both SessionStart hooks auto-inject knowledge atoms on every session start. But you don't always need them.

**Root cause:** Push model - the system decides when to inject, not the user.

**Fix:** Make retrieval opt-in via `/primeDB` command. Keep post-compaction injection (because Claude just lost context mid-task) but make cold-start injection a reminder only.

### Problem 5: Dead code and unused tables

5 tables with 0 rows. Decay system defined but effectively never run. Promotion system depends on knowledge_sightings which is never populated.

**Fix:** Remove unused tables. Keep only what's actively used or needed for the rebuild.

### Problem 6: No file-aware context injection

Claude frequently reads and edits files, but the memory system doesn't know which files Claude is working with. Past debugging knowledge about a specific component only surfaces if the user happens to mention it by name.

**Root cause:** No PostToolUse hook to detect file operations.

**Fix:** Add PostToolUse hook that detects Read/Edit operations and injects relevant knowledge atoms for the files being touched.

---

## 4. Decisions Made and Why

### Decision 1: LLM extraction via Haiku, not regex

**Context:** The current regex-based extraction produces garbage atoms.

**Chose:** Anthropic Haiku via API for post-session transcript extraction, using tool_use for structured output.

**Over:** Regex (current, proven to fail), Sonnet (10x more expensive), free-form JSON from messages.create (unreliable parsing).

**Why Haiku with tool_use:** ~$0.06 per session (after pre-processing, at Haiku 4.5 pricing). Fast (2-5 seconds). Structured output via tool_use guarantees valid JSON schema every time - no parsing failures, no markdown fences, no truncated JSON. Haiku doesn't need to be creative - it needs to read a conversation and fill in fields.

**When to revisit:** If extraction quality is noticeably bad on complex sessions, try Sonnet for those specific cases.

### Decision 2: OpenAI text-embedding-3-small for embeddings, not local models

**Context:** Need vector embeddings for semantic search.

**Chose:** OpenAI text-embedding-3-small via API.

**Over:** sqlite-lembed + MiniLM-L6-v2 (alpha software, MiniLM not trained on code, 384-dim), BGE-small-en-v1.5 local (needs native C extensions), Voyage AI or Cohere (less ecosystem support).

**Why OpenAI:** 1536 dimensions (4x MiniLM's 384), trained on code + technical content, $0.02 per million tokens (< $5/year for one developer), zero maintenance, stable API. sqlite-vec stores the vectors locally - only the embedding generation calls the API.

**Tradeoff:** Requires internet connection. But Claude Code itself requires internet, so this isn't a new constraint.

**When to revisit:** If you need offline capability, evaluate nomic-embed-text or BGE-en-v1.5 locally via transformers.js.

### Decision 3: RRF with k=15, not k=60

**Context:** Reciprocal Rank Fusion merges BM25 and vector search results. The k parameter controls how much top-ranked results dominate.

**Chose:** k=15.

**Over:** k=60 (original paper, too flat for small corpus), k=5 (too aggressive, top result dominates).

**Why k=15:** At k=60, the score difference between rank 1 and rank 10 is only 13% - too flat for a corpus of hundreds to low thousands. At k=15, rank 1 vs rank 10 is ~40% difference, giving meaningful discrimination. At k=5, rank 1 dominates too much.

**When to revisit:** After 2-3 weeks of real usage, if search results feel wrong. Easy to adjust (single constant).

### Decision 4: Drop synonym table, drop trigram FTS5

**Context:** Current system has 1,102 synonym pairs and a trigram FTS5 table.

**Chose:** Remove both.

**Why:** Vector embeddings handle semantic similarity better than hand-curated synonyms. The synonym table was compensating for the lack of embeddings - with embeddings, it's redundant AND hurts precision.

**What stays:** The CONCEPT_MAP in server.js that enriches atoms at WRITE time with tags. This helps FTS5 because tags are stored with the atom, not used for query expansion.

### Decision 5: Pull-based retrieval (slash commands), not push-based (auto-injection)

**Context:** Current SessionStart hooks auto-inject knowledge on every session.

**Chose:** `/primeDB` command for on-demand memory loading. `/saveDB` command for explicit checkpoints.

**Exception:** Post-compaction (SessionStart/compact) still auto-injects a recovery set because Claude just lost context mid-task. PostToolUse file-aware injection is also automatic but lightweight (max 2 atoms).

### Decision 6: Decisions stored as knowledge atoms with metadata, not separate table

**Context:** Original architecture had a dedicated decision_trails table.

**Chose:** Store decisions as knowledge atoms with `type='decision'`. All structured fields (reasoning, alternatives, tradeoffs) are inlined directly into the `content` field. The `metadata` column exists but is not relied on - content is the single source of truth, visible at injection time.

**Why:** One table, one search path, simpler code. Content is self-contained and searchable by FTS5 and vector search. No data is hidden in an unsearchable JSON blob that hooks can't see.

### Decision 7: Thread scoring uses Math.log2, coefficient 0.15

**Context:** When search finds matching turns across threads, threads need a score to rank them.

**Chose:** `thread_score = best_child_score * (1 + 0.15 * Math.log2(matching_turns))`

**Over:** `Math.log` (natural log) - ambiguous and gives too-large boosts. `Math.log10` - too compressed. Coefficient 0.3 (original) - too aggressive with Math.log2.

**Why Math.log2 with 0.15:** Clear semantics: each doubling of matching turns adds a 15% boost. 2 matches = 15% boost. 4 matches = 30% boost. 8 matches = 45% boost. 16 matches = 60% boost. This prevents long threads with many low-quality matches from overwhelming short threads with one high-quality match. Guard: if `matching_turns <= 0`, use score = 0 (should never happen but defensive).

### Decision 8: Connection discovery deferred to post-v1

**Context:** Find similar existing threads and store links for "related experiences."

**Chose:** Build after 200+ threads exist. Not in the initial build phases.

**Why:** At current scale, search itself finds related content. The implementation is cheap but the value only shows with a larger corpus. Build it when the data justifies it.

### Decision 9: Keep worker process, don't go fully synchronous

**Context:** The worker is a separate Node.js process.

**Chose:** Keep the worker.

**Why:** LLM extraction via Haiku takes 2-5 seconds. Embedding generation takes 1-3 seconds. Total ingestion: 5-10 seconds per session. Hook timeouts can't accommodate this. The worker handles it async with retry on failure.

**Change:** Polling interval from 3s to 10s, but only sleep when no pending jobs found. When a job completes and more jobs are pending, process immediately without sleeping.

### Decision 10: Use Anthropic tool_use for structured extraction, not free-form JSON

**Context:** Haiku needs to output structured extraction results. Free-form JSON from messages.create occasionally produces malformed output (trailing commas, markdown fences, commentary outside JSON, truncation).

**Chose:** Define the extraction schema as a tool and have Haiku "call" it. This guarantees valid JSON conforming to the schema.

**Over:** Free-form JSON with post-hoc parsing and repair (fragile, loses data on complex failures).

**Why:** tool_use structured output eliminates an entire class of failures. The cost is identical. The implementation is slightly different (read from tool_use content block instead of text block) but simpler overall because no JSON parsing/repair is needed.

### Decision 11: Pre-process transcripts before sending to Haiku

**Context:** Raw Claude Code transcripts contain massive tool_use blocks (file reads, bash outputs, grep results) that are 60-80% of token count but contain zero extractable knowledge.

**Chose:** Strip tool_use blocks and tool result blocks from transcripts. Keep only text content from user messages and assistant text responses.

**Over:** Sending raw transcripts (5-10x more expensive, slower, degrades extraction quality because Haiku's attention is diluted by code dumps).

**Why:** A 30-turn session with heavy tool use might be 80K raw tokens. After stripping tool blocks, it's 8-15K tokens. Cost drops from ~$0.32 to ~$0.06 (at Haiku 4.5 pricing). Extraction quality improves because Haiku focuses on the conversational content where decisions and reasoning actually happen. Code context in tool results is ephemeral session state, not durable knowledge.

### Decision 12: PostToolUse hook for file-aware memory injection

**Context:** Claude frequently reads and edits files, but the memory system only injects knowledge based on user message content. Past debugging knowledge about a component only surfaces if the user happens to name it.

**Chose:** Add a PostToolUse hook that fires after Read/Edit/Write tool calls. It extracts the file name, searches knowledge atoms via FTS5, and injects max 2 matching atoms.

**Over:** Relying solely on UserPromptSubmit (misses file operations Claude initiates on its own), relying on Claude to call recall_context (requires Claude to know it should search, which is the problem).

**Why:** This is the closest thing to proactive context injection. When Claude opens `InboxCalendar.tsx`, it automatically gets: "[debugging] Unipile returns null timestamps for all-day events. InboxCalendar needs defensive null checks." No user action needed, no query formulation needed. Rate-limited to one injection per unique file per session to avoid noise.

**Timeout:** 500ms. FTS5-only search (no API call). Exits immediately for non-file tools.

### Decision 13: Recovery buffer for compaction gap

**Context:** When context compacts, PreCompact queues an ingestion job and SessionStart/compact fires immediately after. But the worker takes 5-10+ seconds to process. The recovery hook always uses OLD atoms, never the ones from the session being compacted - the most recent decisions are the ones you need most and they're the ones missing.

**Chose:** PreCompact hook writes the last 5-10 conversation turns (verbatim, stripped of tool blocks) to a `recovery_buffer` table synchronously. SessionStart/compact reads this buffer FIRST, then supplements with existing atoms.

**Over:** Waiting for worker (too slow), running Haiku synchronously in the hook (timeout), accepting stale recovery (loses the most valuable context).

**Why:** Writing 10 turns of text to SQLite is < 50ms. Reading them back is < 10ms. This ensures the most recent conversation context survives compaction immediately, without waiting for the full ingestion pipeline. The verbatim turns provide enough context for Claude to continue the current task. The full extraction happens async and provides permanent atoms for future sessions.

### Decision 14: Periodic LLM consolidation (inspired by memory-mcp)

**Context:** Knowledge atoms accumulate over time. Near-duplicates slip through the 0.92 cosine threshold. Outdated atoms persist. Contradictions exist between old and new atoms. The 90-day archive rule only catches unaccessed atoms.

**Chose:** Run a consolidation job weekly (or every 20 extractions, whichever comes first). Send all active atoms grouped by type to Haiku. Haiku identifies: duplicates to merge, outdated entries to archive, and contradictions to flag for user review.

**Over:** Automatic real-time contradiction detection during dedup (impossible without NLI - cosine similarity measures relatedness, not agreement vs disagreement), no consolidation (knowledge rots silently).

**Why:** This is the one feature that prevents knowledge rot. It's the most valuable idea from the memory-mcp open source project. Cost: ~$0.20 per consolidation run (small atom set, Haiku 4.5 pricing). Frequency: weekly is ~$10.40/year. The LLM can understand semantic contradiction ("use HTTPS" vs "HTTP is fine") in a way that no distance metric can.

### Decision 15: Skip automatic contradiction detection in v1

**Context:** The original spec said cosine similarity 0.50-0.92 "AND content contradicts" should trigger supersession. But detecting contradiction from embeddings alone is impossible - cosine measures relatedness, not agreement.

**Chose:** For v1, dedup has two paths only: cosine > 0.80 = reinforce existing atom. Below 0.80 = create new atom. Contradictions are handled by: (a) explicit `memory_feedback(signal='corrected')`, (b) periodic LLM consolidation (Decision 14).

**Over:** Adding another Haiku call during dedup (expensive, adds latency to every atom save), heuristic negation detection (unreliable).

**Why:** Honest about what's feasible. Contradiction detection is a hard NLI problem. Periodic consolidation handles it better in batch, where Haiku can see all related atoms together and make a holistic judgment.

### Decision 16: Synchronous embedding in save_knowledge for dedup

**Context:** The original spec said "generate embedding async - don't block the response" but then immediately required cosine similarity for dedup. These contradict each other - you can't compute cosine without the embedding.

**Chose:** Generate embedding synchronously within save_knowledge. The OpenAI embedding API call takes ~50-100ms. This is acceptable latency for a tool call.

**Over:** Async embedding with deferred dedup (atoms would be stored without dedup, then a background job would retroactively merge them - complex and race-prone).

**Why:** 50-100ms is imperceptible in an MCP tool call that Claude is already waiting for. The alternative creates a window where duplicate atoms exist and could be served to the user before reconciliation.

### Decision 17: sqlite-vec with distance_metric=cosine

**Context:** sqlite-vec defaults to L2 (Euclidean) distance, not cosine similarity. The spec uses cosine similarity thresholds everywhere (0.92 for dedup, 0.70 for connections). Using L2 distances against cosine thresholds would completely break dedup and search ranking.

**Chose:** Specify `distance_metric=cosine` in the vec0 table definition. This makes `MATCH` queries return cosine distance (0 = identical, 1 = orthogonal, 2 = opposite). Convert to similarity via `cosine_similarity = 1 - cosine_distance`.

```sql
CREATE VIRTUAL TABLE knowledge_embeddings USING vec0(
  atom_id INTEGER PRIMARY KEY,
  embedding float[1536] distance_metric=cosine
);
```

**Over:** Manual conversion from L2 (`cosine_sim = 1 - (L2^2 / 2)`) - error-prone and requires remembering to convert everywhere.

**Why:** Native cosine distance means all threshold comparisons work directly: `WHERE distance < 0.08` for cosine similarity > 0.92 (because cosine_distance = 1 - cosine_similarity = 1 - 0.92 = 0.08). No conversion needed. sqlite-vec has supported `distance_metric=cosine` since v0.1.3+.

### Decision 18: Type-based decay with git-aware staleness

**Context:** The original 90-day-unaccessed + confidence < 0.5 archival rule is both too conservative and too blunt. An atom at confidence 0.75 (LLM-extracted default) is never archived even if the decision was reversed months ago. Meanwhile, all atom types are treated the same despite having very different lifespans.

**Chose:** Two-layer staleness detection:

**Layer 1 - Type-based decay:**
- `preference`, `decision`, `architecture`: Never auto-decay. These are stable unless explicitly corrected or contradicted by consolidation.
- `pattern`, `reasoning_chain`, `anti_pattern`: Archive after 180 days unaccessed.
- `debugging`, `fact`, `workaround`, `tool_config`: Archive after 90 days unaccessed.
- `correction`: Archive after 60 days (corrections are time-bound to the error they corrected).

**Layer 2 - Git-aware staleness (Phase 2+):**
- When consolidation runs, check if files referenced in atom content have been significantly modified since the atom was created.
- If file has > 50% diff (by line count): lower atom confidence by 0.15 and flag for review.
- This catches decisions and fixes that are technically still "accessed" but are about code that has fundamentally changed.

**Fallback rule:** Any atom older than 180 days regardless of type or confidence, unless explicitly confirmed via memory_feedback in the last 90 days, gets flagged for consolidation review (not auto-archived, but Haiku reviews it).

### Decision 19: ACT-R Activation Scoring for retrieval ranking

**Context:** RRF merges BM25 and vector scores, but treats all atoms equally regardless of how frequently or recently they were accessed. A debugging fix you referenced 10 times last week should rank higher than a preference you set once 6 months ago - even if both have equal keyword/semantic match scores.

**Chose:** ACT-R (Adaptive Control of Thought-Rational) base-level activation as a retrieval signal, using the Petrov approximation: `B_i = ln(n/(1-d)) - d*ln(T)`. This only needs `access_count` (n), `created_at`/`last_accessed_at` (T), and `decay_rate` (d) - all columns we already have or are adding.

**Over:** Raw access_count ranking (ignores recency), recency-only ranking (ignores frequency), no usage signal at all (current system).

**Why ACT-R:** It's the gold standard in cognitive science for modeling memory retrieval strength. The Petrov approximation avoids needing to store every individual access timestamp - it uses aggregate statistics to approximate the full ACT-R equation. The formula naturally balances "used a lot" with "used recently" in a single score.

**How it integrates:** ACT-R activation is computed at retrieval time as a re-ranking signal applied after RRF. It does NOT replace RRF - it modifies scores. The formula: `final_score = 0.7 * rrf_score + 0.3 * sigmoid(activation)`. This means relevance (RRF) still dominates, but usage patterns break ties and boost frequently-referenced knowledge.

**When to revisit:** After 150+ atoms exist. Below that, the activation scores won't have enough variance to matter. The 0.7/0.3 weights may need tuning based on real retrieval quality.

### Decision 20: Type-aware decay rates for ACT-R

**Context:** ACT-R uses a decay parameter `d` that controls how quickly activation fades over time. A single decay rate treats architectural decisions the same as debugging fixes - but architecture knowledge should persist much longer than a one-off debugging workaround.

**Chose:** Per-type decay rates stored in a `decay_rate` column on each knowledge atom:
- `preference`, `decision`, `architecture`: d=0.15 (very slow decay - these are stable knowledge)
- `pattern`, `reasoning_chain`, `anti_pattern`: d=0.30 (moderate decay - standard ACT-R default)
- `debugging`, `fact`, `workaround`, `tool_config`: d=0.40 (faster decay - tied to specific code that changes)
- `correction`: d=0.50 (fast decay - time-bound to the error they corrected)

**Over:** Single decay rate for all types (d=0.5 from cognitive science literature - too aggressive for stable knowledge, buries architecture atoms that are accessed infrequently but are critically important when needed).

**Why type-aware:** An architectural decision accessed 3 times over 6 months should NOT decay to near-zero activation. With d=0.15, it maintains a reasonable activation score. Meanwhile, a debugging workaround accessed 3 times in one day but never again should decay quickly (d=0.40 ensures this). This directly prevents ACT-R from burying important-but-rarely-accessed knowledge.

**When to revisit:** After observing whether architecture/preference atoms surface correctly when needed. The decay rates may need fine-tuning.

### Decision 21: Impasse detection during extraction

**Context:** Some sessions contain "struggle patterns" - the user or Claude tries something multiple times, hits errors, corrects course, and eventually finds a solution. These sessions contain disproportionately valuable knowledge (the kind you'd want recalled when facing a similar problem), but the current extraction prompt treats all sessions equally.

**Chose:** Add impasse detection to the extraction prompt. When Haiku identifies struggle patterns (multiple failed attempts followed by success, user corrections, error-retry cycles), it tags extracted atoms with `impasse_severity: 1.0`. At retrieval time, if the current session shows impasse signals (error messages, retries, frustration language), atoms with impasse_severity get a contextual boost.

**Over:** No impasse awareness (current system), automatic impasse weight on all debugging atoms (too broad - not all debugging involves struggle).

**Why this matters:** The most valuable debugging knowledge comes from hard-won solutions. When you're currently struggling with something similar, you want that hard-won knowledge to surface first. The boost is contextual - impasse atoms only get boosted when the retrieval context suggests the user is currently struggling, not on every query.

**Implementation:** The extraction prompt detects struggle patterns. The tool schema has an `impasse_severity` float field (0.0-1.0). All atoms from the session get the session's severity value. At retrieval, if the query context contains impasse signals, atoms with impasse_severity > 0 get a multiplicative boost: `final_score = base_score * (1.0 + 0.10 * impasse_severity)`. A severity-1.0 atom gets 10% boost; severity-0.3 gets 3%.

**When to revisit:** After 50+ sessions to see if the detection is accurate. May need to tune what counts as "impasse signals" in the retrieval context.

### Decision 22: Temporal knowledge tracking via consolidation (simplified)

**Context:** Knowledge changes over time. "We use Zustand for state" might be true today but false next month. The current system has `superseded_by` for explicit corrections, but no way to track WHEN a piece of knowledge was valid.

**Original plan:** Add `valid_at`, `invalid_at`, and `topic_hash` columns. **CUT** - see Changes Log items 1-3.

**Chose instead:** Rely on the existing `status` field (`active`/`archived`/`superseded`) + periodic LLM consolidation (Decision 14). Consolidation uses Haiku's semantic understanding to identify temporal chains and contradictions, storing notes in `contradiction_note`. The `status` field handles invalidation (`status = 'archived'` or `status = 'superseded'`). No need for separate `valid_at`/`invalid_at` columns when `status` + `created_at` already capture this.

**Why simpler is better:** `topic_hash` was never properly defined ("key noun phrases" - how exactly?). Haiku-based consolidation handles temporal grouping semantically, which is more accurate than any hash-based approach. When any type exceeds 50 atoms, add cosine-based pre-clustering before Haiku review.

**When to revisit:** If consolidation proves too slow or inaccurate at grouping related atoms, consider adding a lightweight topic clustering mechanism.

---

## 5. The New System - Complete Architecture

### System Diagram

```
YOU TYPE A MESSAGE IN CLAUDE CODE
  |
  |-- [UserPromptSubmit hook, 500ms]
  |     Scans your message for signals (file paths, errors, problem language)
  |     If signal found: fast FTS5 search on knowledge atoms, inject top 1-2 as <memory-context>
  |     If no signal: silent, zero tokens used
  |
  v
CLAUDE RESPONDS (may use tools)
  |
  |-- [PostToolUse hook, 500ms] -- fires after each Read/Edit/Write
  |     Extracts file name from tool input
  |     FTS5 search for atoms mentioning that file/component
  |     If match found AND not already injected this session: inject top 1-2 atoms
  |     Rate-limited: one injection per unique file per session
  |
  |-- Claude may call save_knowledge (explicit capture, immediate with sync embedding + dedup)
  |-- Claude may call recall_context (explicit search, on-demand, hybrid BM25+vector)
  |
  ... conversation continues ...
  |
  |-- [PreCompact hook, 2s] -- fires when context window fills up
  |     1. Writes last 10 turns (stripped of tool blocks) to recovery_buffer table (sync, < 50ms)
  |     2. Copies full transcript to snapshots/ via hard link (sync, O(1))
  |     3. Queues ingestion job at priority 10 (async, worker handles it)
  |
  |-- [SessionStart/compact hook, 1s] -- fires after compaction
  |     1. Reads recovery_buffer for most recent conversation context (highest priority)
  |     2. Queries top 3 knowledge atoms for current project (supplementary)
  |     3. Injects both as recovery context
  |     4. Claude recovers key context that was lost to compaction
  |
  ... session continues with recovered context ...
  |
  |-- [Stop hook, 2s] -- fires when you close terminal / Ctrl+C
  |     Always queues an ingestion job (never skips entirely):
  |     If PreCompact snapshot exists: queues full transcript at priority 5
  |       (session likely continued after compaction; atom-level dedup handles overlap)
  |     If no snapshot exists: queues transcript at priority 5 normally
  |
  v
WORKER PICKS UP INGESTION JOB (async, 5-10 seconds)
  |
  [1] Parse JSONL transcript into conversation turns
  [2] Pre-process: strip tool_use blocks and tool results, keep only text content
  [3] Store thread + turns in database
  [4] Generate OpenAI embeddings for each turn (1536-dim, cosine distance)
  [5] Index turns in FTS5 for keyword search
  [6] Send pre-processed transcript to Haiku via tool_use for structured extraction
  [7] Store extracted knowledge atoms with embeddings
  [8] Deduplicate against existing atoms (cosine distance < 0.08 = similarity > 0.92)
  [9] Mark key exchanges on turns (via content-matching, not Haiku turn numbers)
  |
  v
KNOWLEDGE IS NOW AVAILABLE FOR FUTURE SESSIONS
  |
  Retrievable via:
  - /primeDB command (loads context for current project + conversation topic)
  - recall_context MCP tool (Claude searches explicitly)
  - PostToolUse hook (auto-injection when Claude reads/edits relevant files)
  - UserPromptSubmit hook (auto-injection on signal match in user message)
  - SessionStart/compact hook (post-compaction recovery with buffer + atoms)

PERIODIC MAINTENANCE (worker)
  |
  - Consolidation: weekly or every 20 extractions
    Haiku reviews all active atoms by type, merges duplicates,
    archives outdated, flags contradictions
  - Type-based decay: archives atoms past their type-specific TTL
  - Git-aware staleness (Phase 2+): checks if referenced files changed significantly
  - Daily backup: sqlite3 data/memory.db ".backup data/memory-backup.db"
```

### Technology Stack

| Component | Technology | Why This Specifically |
|-----------|-----------|----------------------|
| Database | SQLite + WAL mode + `PRAGMA foreign_keys = ON` | Already a dependency, zero infrastructure, concurrent-safe |
| Vector storage | sqlite-vec with `distance_metric=cosine` | Stable C extension for SQLite, brute-force KNN, instant at our scale, native cosine distance |
| Embeddings | OpenAI text-embedding-3-small (API) | 1536-dim, trained on code, $0.02/1M tokens, zero maintenance |
| Full-text search | FTS5 (porter + unicode61) | Built into SQLite, BM25 ranking, no external dependencies |
| Result fusion | Reciprocal Rank Fusion (k=15) | Combines BM25 + vector ranks without score normalization |
| LLM extraction | Anthropic Haiku 4.5 via tool_use (API) | ~$0.06/session (at $1/$5 per MTok), structured output guaranteed, good for extraction |
| LLM consolidation | Anthropic Haiku 4.5 (API) | ~$0.20/consolidation run, reviews atom quality in batch |
| MCP server | Node.js + @modelcontextprotocol/sdk | Same ecosystem as Claude Code, already working |
| Worker | Node.js (long-running process) | Handles async ingestion, embedding, extraction, consolidation |
| Hooks | Bash shell scripts | Claude Code's native hook system |
| JSON parsing in hooks | jq | Faster cold start than python3 (20ms vs 200-400ms), standard JSON tool |
| Watchdog | launchd (macOS) | Checks worker health every 5 minutes |

---

## 6. How It Works In Practice - A Full Day

### 9:00 AM - You open terminal, start Claude Code in the Nurch project

**What happens:**
1. Claude Code fires `SessionStart` hook (startup matcher)
2. Hook outputs a one-line reminder: `"Memory system active. Use /primeDB to load project context, /saveDB to checkpoint."`
3. Claude sees this reminder but doesn't waste tokens on auto-injected knowledge
4. You get a clean session

**Token cost:** ~20 tokens for the reminder.

### 9:01 AM - You want to work on the Unipile email integration

```
You: "I need to work on the Unipile email integration today. /primeDB"
```

**What happens:**
1. The /primeDB instruction tells Claude to call `recall_context` with progressive disclosure
2. Claude uses the conversation context: the user mentioned "Unipile email integration"
3. Claude calls `recall_context` with query: "Unipile email integration", resolution=3 (atoms first - lightweight)
4. The MCP tool runs hybrid search:
   - Generates query embedding via OpenAI (~50-100ms)
   - FTS5 BM25 finds atoms containing "Unipile", "email", "integration"
   - Vector search finds semantically related atoms (catches "inbox", "webhook", "API")
   - RRF merges the results (k=15)
5. Top 5-10 atoms returned as a lightweight map of available knowledge
6. Claude sees one atom about "Unipile null timestamps" that looks directly relevant to email work
7. Claude calls `recall_context(expand=thread_id)` to get the full debugging thread for that specific issue
8. Claude summarizes: "Found 8 relevant items. Key context: Unipile API for email+LinkedIn+calendar at ~$55/mo. Webhooks need HTTPS. Expanded the null timestamps debugging thread - full diagnostic method available."

**Token cost:** ~300 tokens for the atom map + ~500 tokens for one expanded thread. Progressive disclosure means you only pay for the detail you actually need.

### 9:05 AM - You're coding. Claude reads the InboxCalendar component.

```
Claude uses Read tool on src/components/InboxCalendar.tsx
```

**What happens:**
1. PostToolUse hook fires (after tool completion, 500ms timeout)
2. Hook detects tool_name = "Read", extracts file_path
3. Extracts filename: "InboxCalendar"
4. Checks rate-limit file: "InboxCalendar" not seen this session
5. Searches knowledge atoms via FTS5: `MATCH '"InboxCalendar"'`
6. Finds atom: `[debugging] Unipile returns null timestamps for all-day events. InboxCalendar needs defensive null checks.`
7. Injects as `<memory-context source="file:InboxCalendar">...</memory-context>`
8. Records "InboxCalendar" in rate-limit file (won't inject again for same file)
9. Claude sees the past debugging knowledge alongside the file contents

**Token cost:** ~50 tokens. Automatic, no user action needed.

### 9:06 AM - You type "yes, do it"

```
You: "yes, do it"
```

**What happens:**
1. UserPromptSubmit hook fires
2. Message length: 10 chars, below 20-char minimum threshold
3. Hook exits immediately. Zero processing.

**Token cost:** 0.

### 10:30 AM - Long session, context window fills up, compaction happens

**What happens:**
1. Claude Code decides to compact the conversation
2. **BEFORE compaction:** PreCompact hook fires
   - Reads last 10 turns from the transcript (stripping tool_use blocks)
   - Writes them to `recovery_buffer` table (< 50ms synchronous)
   - Hard links transcript to `snapshots/` (O(1), no file copy)
   - Queues ingestion job at priority 10
   - Exits in < 200ms total
3. Claude Code compacts - conversation gets summarized, details lost
4. **AFTER compaction:** SessionStart/compact hook fires
   - Reads `recovery_buffer` - gets the most recent conversation turns (the ones that were JUST lost to compaction)
   - Queries top 3 knowledge atoms for current project
   - Injects both:
     ```
     === Memory Recovery (post-compaction) ===

     Recent conversation context:
     [Turn 18, user]: "The recurring events are showing wrong end times..."
     [Turn 18, assistant]: "I see the issue - the recurrence expansion doesn't account for timezone offset..."
     [Turn 19, user]: "Yes, fix it using the UTC offset from the event metadata"

     Related knowledge:
     [#42] [decision] Chose Unipile API (~$55/mo) for unified inbox...
     [#38] [debugging] Unipile returns null timestamps for all-day events...

     Use /primeDB to load more context.
     ```
5. Claude continues the session with the most recent conversation AND relevant atoms

**Token cost of recovery injection:** ~300-600 tokens. Automatic because Claude just lost context.

**Meanwhile, the worker processes the pre-compaction transcript (5-10 seconds):**
- Parses JSONL, strips tool blocks, pairs into turns
- Stores thread + turns + embeddings
- Sends pre-processed transcript to Haiku for extraction
- Haiku extracts: 2 decisions, 1 bug fix, 1 reasoning chain
- New knowledge atoms created, deduplicated, and embedded
- These atoms are available for the rest of this session and all future sessions

### 12:00 PM - You've made important decisions. You want to checkpoint.

```
You: "/saveDB"
```

**What happens:**
1. Claude reviews the recent conversation
2. Identifies: 1 decision (pagination approach), 1 preference (loading states), 1 reasoning chain (how you diagnosed the timezone bug)
3. Claude calls `save_knowledge` three times, each with synchronous embedding + dedup:
   - Decision atom with reasoning in the content field
   - Preference atom with global scope
   - Reasoning chain atom with the diagnostic method
4. Claude confirms: "Saved 3 items: cursor pagination decision, loading states preference, timezone debugging method."

**Token cost:** ~300 tokens for Claude's save_knowledge calls.

### 1:00 PM - You close the terminal

**What happens:**
1. Claude Code fires Stop hook
2. Hook checks: does a snapshot exist in `snapshots/` for this session file?
3. YES - a PreCompact snapshot was already created at 10:30 AM. The snapshot covers the session up to that point, and the worker already ingested it.
4. But the session continued after compaction. Hook queues ingestion for the FULL session transcript (which includes post-compaction content the snapshot didn't have).
5. Worker picks it up, processes it. Dedup catches atoms that overlap with the PreCompact extraction.
6. Everything from this session is now permanently searchable.

**Token cost:** 0 (happens after session ends).

### 3:00 PM - New session, different problem

```
You: "I need to add LinkedIn message sending to Nurch. /primeDB"
```

**What happens:**
1. Claude calls `recall_context` with query derived from "LinkedIn message sending Nurch"
2. Hybrid search finds: Unipile decision atom (mentions LinkedIn), rate limiting atom, webhook HTTPS atom
3. Claude loads context: "Loaded 6 items. Unipile handles LinkedIn via the same API as email. Rate limit 100/min..."
4. You're immediately productive without re-explaining anything

### 5:00 PM - Quick session, don't need memory

```
You: "Add a TODO comment on line 45 of App.tsx"
```

**What happens:**
1. UserPromptSubmit: 38 chars, passes minimum. Checks signals: "App.tsx" is a file path.
2. Searches knowledge for "App.tsx" - no matches. Silent.
3. Claude does the simple task. PostToolUse fires when Claude reads App.tsx - no knowledge atoms about App.tsx specifically. Silent.
4. No memory overhead.

---

## 7. Data Flow - Ingestion Pipeline

### What Triggers Ingestion

Two events:
1. **PreCompact hook** - fires mid-session. Writes recovery buffer first, then hard links transcript to snapshots/, then queues job at priority 10 (high).
2. **Stop hook** - fires when session ends. Checks if a snapshot already exists for this session (by comparing source file paths against existing threads). If no snapshot exists, queues job at priority 5 (normal). If a snapshot exists but the session continued after compaction, queues a job for the full transcript (which will deduplicate against the snapshot's extraction).

Both queue an `ingest_thread` job in the `jobs` table.

### Duplicate Ingestion Prevention

The Stop hook always queues an ingestion job - it never skips entirely. This is intentional:
1. Before queuing, check: `SELECT COUNT(*) FROM jobs WHERE type = 'ingest_thread' AND payload LIKE '%session_basename%' AND status IN ('pending','processing','done')`
2. If a prior job exists (from a PreCompact snapshot): queue the full session transcript at priority 5 with `is_full_session=1`, because the session likely continued after compaction and has new content. The worker's atom-level dedup (cosine distance < 0.08) handles overlap between the snapshot extraction and the full session extraction.
3. If no prior job exists: queue normally at priority 5.

Skipping the Stop hook entirely based on mtime checks was considered and rejected. The cost of duplicate processing is ~$0.06 per session, and the dedup pipeline reliably catches overlap. The risk of accidentally skipping a session with new content outweighs the trivial cost saving.

Additionally, the turns table has `UNIQUE(thread_id, turn_number)` to prevent duplicate turns on retry after partial failure.

### The Full Pipeline (runs in worker.js)

```
STEP 1: PARSE JSONL TRANSCRIPT
  Input: Raw JSONL file (one JSON object per line)
  Process:
    - Read file line by line
    - try/catch on JSON.parse per line - skip malformed lines (handles truncated files gracefully)
    - Keep only entries where type = "user" or type = "assistant"
    - For user entries: extract text content from message.content (string or array of text blocks)
    - For assistant entries: extract text blocks only, IGNORE tool_use blocks entirely
    - Result: ordered list of {role, content, timestamp} objects
  Note: tool_use blocks (Read results, Bash output, Grep results) are stripped here.
  This typically reduces token count by 60-80%.

STEP 2: PAIR INTO TURNS
  Input: Ordered list of messages (text-only)
  Process:
    - Group sequential user + assistant text messages into turns
    - Turn = {user_content, assistant_content, timestamp, turn_number}
    - A user message without a following assistant response is kept as a partial turn
    - Count original tool_use blocks from raw assistant messages (stored as tool_calls_count)
    - Detect if any tool result contained error/failure signals (stored as has_error)
  Output: Array of turns, typically 10-50 per session

STEP 3: CREATE THREAD RECORD
  Input: Array of turns, file metadata
  Process:
    - thread_id = content hash of first 3 turns + timestamp (stable across paths, avoids path-based fragility)
    - project = derived from directory path (use full path hash, not just basename, to avoid collisions)
    - project_name = basename of directory (for display purposes)
    - turn_count = number of turns
    - timestamp_start = first turn's timestamp
    - timestamp_end = last turn's timestamp
    - source_file = original JSONL path
    - file_mtime = file modification time (for change detection on re-ingestion)
  Output: One row in `threads` table (INSERT OR IGNORE - idempotent via content-hash ID)

STEP 4: STORE TURNS
  Input: Array of turns, thread_id
  Process:
    - INSERT OR IGNORE each turn (UNIQUE constraint on thread_id + turn_number prevents duplicates on retry)
    - Content fields stored in full (no truncation)
    - FTS5 triggers auto-populate `turns_fts` on insert
  Output: Rows in `turns` table, auto-indexed in FTS5

STEP 5: GENERATE TURN EMBEDDINGS
  Input: Each turn's concatenated text (user_content + " " + assistant_content)
  Process:
    - Truncate to 8,191 tokens (OpenAI model's max input) - practically never hits this for a single turn
    - Call OpenAI text-embedding-3-small API
    - Batch up to 20 turns per API call for efficiency
    - Store 1536-dim float vector in `turn_embeddings` table (distance_metric=cosine)
  Performance:
    - ~50-100ms per API call (network latency dominates)
    - 30 turns in 2 batches = ~100-200ms total
    - Cost: ~$0.0003 per session
  Failure handling:
    - If OpenAI API fails: set turn.embed_status = 'failed', continue with remaining steps
    - Worker retries turns with embed_status = 'failed' on next poll cycle (UPDATE SET embed_status = 'pending' for retry)
    - Successfully embedded turns are set to embed_status = 'done'
  Output: Vectors in sqlite-vec, searchable via KNN with cosine distance

STEP 6: LLM EXTRACTION VIA HAIKU (tool_use)
  Input: Pre-processed transcript (text-only turns, no tool blocks)
  Process:
    - Build extraction prompt with 3 few-shot examples (see Section 9)
    - Call Anthropic Haiku API using tool_use for structured output
    - Response is guaranteed to conform to schema (no JSON parsing failures)
    - Response contains:
      a) Extracted knowledge items (decisions, bugs, patterns, preferences, corrections, facts, reasoning_chains, workarounds, anti_patterns)
      b) Key exchange content snippets (NOT turn numbers - content-based matching is more reliable)
      c) Thread priority tier (critical / significant / routine) with explicit definitions
      d) Thread flags (has_corrections, has_decisions, has_debugging)
  Performance:
    - 2-5 seconds per session (Haiku processing time)
    - Cost: ~$0.06 per session (after pre-processing, Haiku 4.5 pricing)
  Failure handling:
    - tool_use guarantees valid JSON, but API call can still fail (network, rate limit)
    - On API failure: store thread + turns without atoms, mark job as 'extract_pending'
    - Worker retries extract_pending jobs on next cycle
    - Thread and turn data is preserved even if extraction fails
  Output: Structured extraction results

STEP 7: STORE EXTRACTED KNOWLEDGE ATOMS
  Input: Extraction results from Haiku
  Process:
    For each extracted item:
      a) Merge any extra metadata fields from Haiku output into the content string
         (e.g., chosen/alternatives/reasoning for decisions, trigger/why_bad for anti-patterns)
         Content is the ONLY thing hooks inject - it must be self-contained
      b) Set type (decision/debugging/pattern/preference/correction/fact/reasoning_chain/workaround/anti_pattern)
      d) Set source_type = 'llm_extracted'
      e) Set source_thread_id = thread_id
      f) Generate embedding synchronously via OpenAI API
      f) Run deduplication:
         - Find top 3 most similar existing atoms via sqlite-vec KNN (cosine distance)
         - If cosine distance < 0.20 (similarity > 0.80): reinforce existing atom (bump confidence, update timestamp)
         - If cosine distance >= 0.20 (similarity <= 0.80): create new atom
         - No automatic contradiction detection in v1 (handled by periodic consolidation)
      g) No content length cap - store full content
      h) Store embedding in `knowledge_embeddings` (distance_metric=cosine)
      j) FTS5 triggers auto-index content and tags
  Output: New/updated atoms in knowledge table with embeddings

STEP 8: MARK KEY EXCHANGES (via content-matching)
  Input: Key exchange content snippets from Haiku extraction
  Process:
    - For each snippet Haiku identified as a key exchange:
      - Search the thread's turns via FTS5 or substring match to find the actual turn
      - Mark that turn AND adjacent turns (turn before and after) as potential key exchanges
      - Set is_key_exchange = 1, key_exchange_type = 'correction'|'root_cause'|'decision'|'breakthrough'
    - This content-based matching is more reliable than trusting Haiku's turn numbers,
      which can be off by 1-3 turns on long transcripts
  Output: Turns marked for Resolution 2 retrieval

STEP 9: SET THREAD METADATA
  Input: Thread priority and flags from Haiku extraction
  Process:
    - Update thread: SET priority, has_corrections, has_decisions, has_debugging
  Output: Thread metadata updated

STEP 10: INJECTION FEEDBACK
  Input: Session file path, turns
  Process:
    - Check injection_events for atoms injected into this session
    - Extract key terms from atom content, check if 30%+ appear in assistant responses
    - Update was_referenced flag and recompute injection_success_rate
    - Referenced atoms get +0.05 confidence, unreferenced atoms get -0.03 after 5+ events
  Output: Injection feedback loop closed for this session

STEP 11: REFRESH INJECTION CACHE
  Input: Project identifier
  Process:
    - Load all active atom embeddings for the project from knowledge_embeddings
    - Delete old cache entries for this project
    - Generate embedding for project name, cosine-rank all atoms, store top 10 as context_type='project_general'
    - Extract file basenames from recent atoms (last 50), generate embeddings for each unique file (cap 20)
    - Cosine-rank atoms per file, store top 5 as context_type='file:<basename>'
  Output: injection_cache table populated with pre-computed vector matches
  Note: Non-critical - failures are logged but don't abort ingestion

STEP 12: MARK JOB DONE, THEN CLEANUP
  Order matters for crash safety:
    1. Mark job as 'done' with completion timestamp (FIRST - so a crash after this point doesn't re-process)
    2. If transcript was a snapshot (from PreCompact): leave it for now
       (separate cleanup process deletes snapshots older than 7 days)
    3. Clear recovery_buffer entries older than the current thread's timestamp
  Why this order: If worker crashes between step 1 and step 2, the worst case is an
  orphaned snapshot file (cleaned up later). If the old order (delete then mark done)
  was used, a crash would permanently lose the transcript.
```

### Ingestion Performance Expectations

For a typical 30-turn session (~15K tokens of raw transcript, ~5K after pre-processing):

| Step | Duration | Cost |
|------|----------|------|
| Parse JSONL + strip tool blocks | ~50ms | $0 |
| Pair into turns | ~5ms | $0 |
| Store thread + turns | ~20ms | $0 |
| Generate embeddings (30 turns, 2 batches) | ~200ms | ~$0.0003 |
| FTS5 indexing | ~10ms (auto via triggers) | $0 |
| Haiku extraction (pre-processed input) | ~3,000ms | ~$0.06 |
| Store extracted atoms + embeddings | ~300ms | ~$0.0002 |
| Mark key exchanges | ~10ms | $0 |
| **Total** | **~3.5 seconds** | **~$0.06** |

Backfilling 400 existing sessions: ~25 minutes total, ~$24 (at Haiku 4.5 pricing). Run as phased background jobs (10 -> 50 -> 340 with quality review between phases).

**Annual cost for an active developer (3 sessions/day + 1 compaction/day):**
(Updated for Haiku 4.5 pricing: $1/$5 per MTok - see Section 0 pricing correction)
- Haiku extraction: 4 events/day * 365 * $0.06 = ~$88/year
- Embeddings: 4 * 365 * $0.0003 = ~$0.44/year
- Consolidation (weekly): 52 * $0.20 = ~$10.40/year
- Query embeddings: negligible (< $0.10/year)
- **Total: ~$100/year**

For a heavy user (5 sessions/day + 2 compactions/day): ~$160/year. Still very cheap.

---

## 8. Data Flow - Retrieval Pipeline

### What Triggers Retrieval

Five triggers, from most to least frequent:

**1. PostToolUse hook (after every tool use, 500ms budget)**
- Fires after every tool call Claude makes
- Only acts on Read/Edit/Write tool calls (exits immediately for others)
- Extracts file name, searches knowledge atoms via FTS5 only (no API call)
- Rate-limited: one injection per unique file per session
- Injects max 2 atoms, max 500 tokens

**2. UserPromptSubmit hook (every message, 500ms budget)**
- Fires on every message you type
- Inhibitory gating: stays silent unless a strong signal is detected
- Only searches knowledge atoms (Resolution 3), only via FTS5 (no API call within 500ms)
- Injects max 2 atoms, max 500 tokens

**3. /primeDB command (on-demand, no time limit)**
- You type `/primeDB` when you want memory loaded
- Claude calls `recall_context` with context from the conversation
- Full hybrid search (BM25 + vector + RRF)
- Returns at Resolution 2 (key exchanges) or 3 (atoms) depending on result count
- Budget: up to 3,000 tokens

**4. recall_context MCP tool (Claude's initiative, no time limit)**
- Claude decides to search memory during conversation
- Same as /primeDB but Claude formulates the query
- CLAUDE.md instructs: "Before re-asking the user something, call recall_context first"

**5. SessionStart/compact hook (after compaction, 1s budget)**
- Automatic - fires every time context compacts
- Reads recovery_buffer first (most recent turns), then top 3 atoms
- Quick SQL queries, no hybrid search (must be fast)
- Budget: 800 tokens

### The Hybrid Search Pipeline (used by recall_context and /primeDB)

This pipeline matches the `recall_context` tool behavior defined in Section 14.

```
STEP 1: EARLY EXIT - EXPAND
  If expand parameter is set: return full thread for that thread_id directly.
  Apply 10,000 token soft cap. If thread exceeds cap, truncate non-key turns
  from beginning, keep key exchanges and end. Note total size for user.
  Skip all remaining steps.

STEP 2: FILE ENRICHMENT (post-RRF boost, NOT query modification)
  If files parameter is set: extract basenames without extensions. Store for later.
  Do NOT modify the query string. File boosting is applied AFTER RRF merge in Step 8.5.
  Example: files=["src/components/InboxCalendar.tsx"] -> store ["InboxCalendar"]
  Rationale: Appending filenames to query corrupts both BM25 ranking (implicit AND
  excludes non-file atoms) and vector search (changes embedding semantics).

STEP 3: RECEIVE QUERY + OPTIONS
  Input: query string (possibly enriched from step 2), options:
    - resolution: 1|2|3 (default: 2)
    - project: string (default: current project, use '*' for cross-project)
    - limit: number (default: 5)
    - since: string (ISO date, optional - for temporal filtering)
    - until: string (ISO date, optional - for temporal filtering)

STEP 4: CHECK EMBEDDING CACHE
  LRU cache of last 20 query embeddings (in-memory, ~120KB total).
  Key = query string. Value = 1536-dim embedding vector.
  If cache hit: use cached embedding, skip API call (~0ms instead of ~50-100ms).
  If cache miss: proceed to step 5.

STEP 5: GENERATE QUERY EMBEDDING
  Call OpenAI text-embedding-3-small with query text.
  Store result in LRU cache.
  Latency: ~50-100ms.

STEP 6: BM25 SEARCH VIA FTS5
  If searching atoms (resolution=3):
    SELECT k.*, bm25(knowledge_fts) as bm25_score
    FROM knowledge_fts JOIN knowledge k ON knowledge_fts.rowid = k.id
    WHERE knowledge_fts MATCH ? AND k.status = 'active'
    AND (k.project = ? OR k.scope = 'global')
    ORDER BY bm25_score LIMIT 30

  If searching turns (resolution 1 or 2):
    SELECT t.*, bm25(turns_fts) as bm25_score
    FROM turns_fts JOIN turns t ON turns_fts.rowid = t.id
    JOIN threads th ON t.thread_id = th.id
    [WHERE th.project = ?]
    ORDER BY bm25_score LIMIT 50

  Note: FTS5 rank values are NEGATIVE (more negative = better match).
  ROW_NUMBER() OVER (ORDER BY bm25_score) assigns rank 1 to the best match.
  All FTS5-then-join queries are wrapped in a single read transaction
  to prevent stale rowid references from concurrent writes.

  Note: Temporal filtering (since/until) is NOT applied here. It is applied
  post-RRF in Step 10 so that vector search results are not excluded prematurely.

STEP 7: VECTOR KNN SEARCH VIA sqlite-vec (cosine distance)
  If searching atoms:
    SELECT atom_id, distance
    FROM knowledge_embeddings
    WHERE embedding MATCH ?  -- query vector
    AND k_param = 30
    ORDER BY distance LIMIT 30
    -- distance is cosine distance: 0 = identical, lower = more similar

  If searching turns:
    SELECT turn_id, distance
    FROM turn_embeddings
    WHERE embedding MATCH ?
    AND k_param = 50
    ORDER BY distance LIMIT 50

  Steps 6 and 7 run in parallel (Promise.all in Node.js).
  Combined latency: ~60-100ms (FTS5 is <5ms, vector is <20ms,
  embedding generation was 50-100ms in step 5).

STEP 8: RECIPROCAL RANK FUSION
  For each result that appears in either list:
    rrf_score = 0
    If in BM25 results at rank r1: rrf_score += 1/(15 + r1)
    If in vector results at rank r2: rrf_score += 1/(15 + r2)

  Results ranked high in BOTH searches dominate. Items found by only one
  search method still appear but score lower.

  When one search returns empty (e.g., no FTS5 matches for a semantic query),
  RRF degrades to single-source ranking divided by the constant. This is
  expected behavior and produces reasonable results.

STEP 8.5: FILE RELEVANCE BOOST (if files parameter was set)
  For each result, check if content contains any stored file basename (case-insensitive).
  If match: result.rrf_score *= 1.15 (15% boost for file relevance).
  Re-sort results after applying boosts.
  This preserves search quality while boosting contextually relevant atoms.

STEP 9: ACT-R ACTIVATION RE-RANKING (for atom-level searches, resolution=3)
  For each atom result, compute ACT-R base-level activation:
    T = seconds since last_accessed_at (or created_at if never accessed)
    n = access_count (minimum 1)
    d = decay_rate (per-type, stored on atom)
    B_i = ln(n / (1 - d)) - d * ln(T)

  Normalize activation via sigmoid: act_score = 1 / (1 + exp(-B_i))

  Apply impasse boost (contextual, multiplicative):
    If current query context contains impasse signals (error keywords,
    "tried X but", "still failing", "not working"):
      impasse_context_flag = 1.0
    Else: impasse_context_flag = 0.0

  Compute final score:
    base_score = 0.75 * rrf_score + 0.25 * act_score
    impasse_boost = atom.impasse_severity * impasse_context_flag  // 0.0-1.0
    final_score = base_score * (1.0 + 0.10 * impasse_boost)
    // A severity-1.0 atom during struggle gets 10% multiplicative boost.
    // A severity-0.3 atom gets 3%. Zero when no impasse context.

  Re-sort atoms by final_score descending.

  Note: This step only applies to knowledge atoms (resolution=3).
  For turn-level searches (resolution 1/2), skip to thread grouping.
  Note: Auto-activates at 150+ atoms. Server checks atom count and enables
  automatically (no manual toggle). Below threshold, use raw RRF scores.
  Status shown in memory_admin(action='summary'): "ACT-R scoring: active (203 atoms)" or
  "ACT-R scoring: inactive (87/150 threshold)".

STEP 10: THREAD GROUPING (for turn-level searches)
  Group turn results by thread_id
  Thread score = best_child_rrf * (1 + 0.15 * Math.log2(matching_turns_in_thread))
  Guard: if matching_turns <= 0, thread_score = 0
  Sort threads by score descending

STEP 11: APPLY PRIORITY TIEBREAKER
  For threads with scores within 5% of each other (not 10% - RRF scores
  are compressed, so 10% would fire on nearly every comparison):
    critical > significant > routine
  Priority never OVERRIDES relevance. It only breaks ties.

STEP 12: APPLY TEMPORAL FILTER
  If since/until parameters are provided:
    Filter results to threads where timestamp_start >= since AND/OR timestamp_end <= until.
    This is applied post-RRF so both BM25 and vector results are considered
    before temporal narrowing. Prevents losing semantically relevant results
    that happen to fall outside the time window in only one search path.

STEP 13: APPLY TYPE FILTER
  If type parameter is provided (e.g., type='decision'):
    Filter results to only knowledge atoms matching that type.
    Applied post-RRF alongside temporal filtering so both search paths
    contribute candidates before narrowing.

STEP 14: RESOLUTION FORMATTING (with fallbacks)

  Resolution 3 (atoms):
    Return knowledge atoms directly
    Format: [#id] [type] (thread:source_thread_id) content
    Including thread_id enables direct expand without round-trip search (Changes Log #27)
    Each atom: 20-100 tokens

  Resolution 2 (key exchanges):
    For each top thread: return only turns marked as is_key_exchange = 1
    FALLBACK: if a thread has zero key exchanges (legacy data, extraction failed),
    fall back to showing the first and last 2 turns as a summary, OR
    show the atom extracted from that thread (Resolution 3 for that result).
    Format: Thread #id [project] (date, N turns, priority)
            [Turn X, CORRECTION]: verbatim user message
            [Turn Y, ROOT_CAUSE]: verbatim assistant response
    Each thread's key exchanges: 100-500 tokens

  Resolution 1 (full thread):
    Return ALL turns from the top thread(s)
    TRUNCATION: keep key exchange turns always. Truncate NON-key turns from the
    BEGINNING of the thread, keeping the end (resolutions and fixes are usually
    at the end, not the beginning).
    Format: Thread #id [project] (date, N turns, priority)
            Turn 1 [user]: full message
            ...
    Per thread: 500-5,000 tokens

STEP 15: UPDATE ACCESS COUNTS
  For all atoms/turns returned in the final result set:
    UPDATE knowledge SET access_count = access_count + 1,
      last_accessed_at = datetime('now') WHERE id = ?
  This feeds ACT-R activation scoring for future queries.
  Cap: max 1 access_count increment per atom per session (prevent
  repeated queries from inflating counts).

STEP 16: TOKEN BUDGET ENFORCEMENT
  Token counting: use character_count / 4 as approximation.
  This is ~20% inaccurate vs actual Claude tokenizer but acceptable
  for budget enforcement (err on the side of slightly under-budget).
  Hard caps:
    PostToolUse: 500 tokens
    UserPromptSubmit: 500 tokens
    SessionStart/compact: ~2000 tokens
    recall_context: 3,000 tokens (configurable)
    expand (specific thread): 10,000 tokens soft cap
      If thread exceeds cap, truncate with note:
      "Thread truncated to N turns (~X tokens). Full thread is M turns.
       Use recall_context(expand='thread_id', full=true) for complete content."

  Return results with thread IDs so Claude can call expand later.
```

### Known Limitation: Porter Stemmer and Technical Identifiers

FTS5 with `porter unicode61` tokenizer stems words, which can mangle technical identifiers like `useInfiniteQuery` or `useState`. Vector search partially compensates (embeddings understand technical terms), but exact identifier matching via BM25 is unreliable for camelCase/PascalCase terms.

Mitigation: The PostToolUse hook uses exact file name matching (not stemmed FTS5) for its searches. The CONCEPT_MAP enriches atoms with un-stemmed tags at write time. For explicit searches, users can use `recall_context` with FTS5 phrase syntax (`"useInfiniteQuery"` in quotes) which bypasses stemming.

**IMPLEMENTED**: `knowledge_fts_exact` uses `unicode61` tokenizer (no Porter stemming). Queried as a third signal in hybrid search RRF merge alongside stemmed BM25 and vector KNN. A term-interaction re-ranker (unigram + bigram overlap) provides a lightweight cross-encoder approximation with up to 20% score boost.

---

## 9. LLM Extraction - The Core Innovation

This replaces the regex-based extraction in the current worker.js. Instead of pattern matching, we send the pre-processed transcript to Haiku and get structured extraction via tool_use.

### Transcript Pre-Processing (before sending to Haiku)

The raw JSONL transcript contains massive tool_use blocks (file reads, bash outputs, grep results). These are stripped before sending to Haiku:

1. Parse JSONL into messages
2. For each message:
   - User messages: keep text content only
   - Assistant messages: keep text content blocks only, strip all tool_use blocks
   - Tool result messages: strip entirely
3. Format as numbered turns:
   ```
   Turn 1 [user]: <text>
   Turn 1 [assistant]: <text>
   Turn 2 [user]: <text>
   ...
   ```
4. Truncation guard: if total formatted text exceeds 50K chars, keep first 3 + last 5 turns
   and insert `[... N turns omitted ...]` marker. Prevents exceeding Haiku's context window
   on very long sessions while preserving session start (context/setup) and end (conclusions).

This typically reduces a 80K-token raw transcript to 8-15K tokens, cutting Haiku input cost by 60-80% and improving extraction quality.

### The Extraction Prompt

```
You are a knowledge extraction system for a developer's coding assistant memory.

Given this Claude Code session transcript, extract ONLY items worth remembering for FUTURE sessions.

Rules:
- Extract things that would be useful in a DIFFERENT session, not just this one
- A decision without reasoning is worthless - ALWAYS include why
- A bug fix without root cause is worthless - ALWAYS include what caused it
- A reasoning chain without the transferable method is worthless - extract the DIAGNOSTIC APPROACH, not just the conclusion
- Skip: routine file reads, simple edits, greetings, status updates
- Skip: basic project setup facts (tech stack, folder structure) that belong in CLAUDE.md
- Skip: facts from tool output artifacts (file contents, command results, search results) - these are transient session state
- Each extracted item: 1-3 sentences max, be concise
- A typical session (10-30 turns) should yield 0-5 items. For longer sessions (30-60 turns), up to 8 items is acceptable if genuinely rich. Never extract more than 10 items regardless of session length.
- Extract only the highest-value items. If in doubt, do not extract.
- If nothing worth extracting: return empty arrays
- For decisions: ALWAYS include the reasoning and rejected alternatives IN the content field, not just the choice
- For workarounds: explain what was TRIED first and why it failed, not just the workaround itself

IMPORTANT - Category disambiguation:
- A DECISION involves choosing between specific alternatives with reasoning (e.g., "chose Supabase over PlanetScale because...")
- A PREFERENCE is a user's general style/approach preference that applies broadly (e.g., "always use loading states", "prefer functional components")
- A REASONING_CHAIN is a transferable diagnostic or problem-solving METHOD, not a specific answer. It describes HOW to approach a type of problem.
- A WORKAROUND is a forced choice where the ideal approach failed, not a deliberate design decision.
- An ANTI_PATTERN is something that was tried, failed, and should be avoided in the future. Format as "Don't X because Y. Instead, Z." Only extract when the user or Claude explicitly identified something as a bad approach after trying it.

Priority tier definitions:
- critical: Session contained a major architectural decision, a production outage diagnosis, or a fundamental change in project direction
- significant: Session contained decisions, bug fixes, or pattern discoveries that will likely be referenced again
- routine: Session was simple edits, quick fixes, or one-off tasks with no lasting knowledge

IMPASSE DETECTION:
Look for "struggle patterns" in the transcript - signs that the user or assistant hit a wall and had to change approach:
- Multiple failed attempts at the same thing (error -> retry -> error -> different approach -> success)
- User corrections mid-session ("no, that's wrong", "that didn't work", "try something else")
- Error-retry cycles with escalating changes
- Explicit frustration or confusion followed by a breakthrough
Rate the session's impasse severity as a float from 0.0 to 1.0:
- 0.0 = no impasse (most sessions - 60-70% should be 0.0)
- 0.3 = brief retry (one approach failed, quickly pivoted)
- 0.7 = significant struggle (3+ failed attempts before solution)
- 1.0 = severe impasse (5+ turns circling same problem before breakthrough)
Sessions with impasse patterns contain disproportionately valuable knowledge - the kind of hard-won solution that should surface when someone faces a similar struggle in the future.
```

### Few-Shot Examples (included in the prompt)

```
EXAMPLE INPUT:
Turn 1 [user]: The calendar is showing events on wrong dates
Turn 1 [assistant]: Let me check the InboxCalendar component to see how dates are handled.
Turn 2 [user]: I already checked the component rendering - it looks correct. The issue only happens with all-day events.
Turn 2 [assistant]: That's a good clue. Let me compare the API response for all-day vs timed events.
Turn 3 [user]: Look at the timestamps - all-day events have null start/end times
Turn 3 [assistant]: Found it. Unipile returns null timestamps for all-day events. The component assumes non-null. We need defensive null checks on event.start and event.end.
Turn 4 [user]: Fix it
Turn 4 [assistant]: Done. Added null checks with fallback to the event date field.

EXAMPLE OUTPUT (what the tool should be called with):
{
  "bugs_fixed": [
    {
      "content": "Unipile returns null timestamps for all-day calendar events. InboxCalendar assumed non-null start/end times, causing wrong date display. Fixed with defensive null checks falling back to the event date field.",
      "symptom": "Calendar showing all-day events on wrong dates",
      "root_cause": "Unipile API returns null for start/end timestamps on all-day events",
      "fix": "Added null checks on event.start and event.end with fallback to event.date",
      "files": ["src/components/InboxCalendar.tsx"],
      "key_exchange_snippet": "all-day events have null start/end times"
    }
  ],
  "reasoning_chains": [
    {
      "content": "Diagnostic method for UI displaying wrong data: first verify the component rendering logic is correct, then compare API responses between working cases and broken cases to isolate the differing variable. In this case, comparing all-day vs timed events revealed the null timestamp difference.",
      "problem_type": "UI displaying incorrect data from API",
      "method": "Verify rendering logic -> compare working vs broken API responses -> isolate differing variable",
      "key_insight": "Compare working and broken cases at the data source level, not the UI level"
    }
  ],
  "key_exchange_snippets": ["all-day events have null start/end times", "Unipile returns null timestamps"],
  "thread_priority": "significant",
  "thread_flags": {"has_corrections": true, "has_decisions": false, "has_debugging": true}
}

EXAMPLE INPUT (empty/routine - nothing worth extracting):
Turn 1 [user]: Add a TODO comment on line 45 of App.tsx
Turn 1 [assistant]: I'll add that TODO comment for you.
Turn 2 [user]: Thanks, looks good
Turn 2 [assistant]: Done. The TODO comment has been added.

EXAMPLE OUTPUT:
{
  "thread_priority": "routine",
  "thread_flags": {"has_corrections": false, "has_decisions": false, "has_debugging": false}
}
(No knowledge arrays - routine edit with no lasting value.)

EXAMPLE INPUT (correction - user corrects a prior decision):
Turn 1 [user]: We said we'd use Zustand for state management but I changed my mind. Let's use React Query for server state and just useContext for the little bit of client state we have.
Turn 1 [assistant]: That makes sense - React Query handles server state caching and Zustand would be redundant for the small amount of client state. I'll refactor to remove Zustand.
Turn 2 [user]: Yes exactly. Zustand was overkill.

EXAMPLE OUTPUT:
{
  "decisions": [
    {
      "content": "Switched from Zustand to React Query (server state) + useContext (client state). Zustand was overkill since most state is server-derived. React Query handles caching/sync, and the small amount of client state doesn't justify a dedicated library.",
      "context": "State management approach for the application",
      "chosen": "React Query + useContext",
      "alternatives": ["Zustand"],
      "reasoning": "Most state is server-derived (handled by React Query caching). Remaining client state is minimal, making useContext sufficient without a dedicated state library.",
      "rejected_reasons": {"Zustand": "Overkill for the small amount of client state"},
      "key_exchange_snippet": "React Query for server state and just useContext"
    }
  ],
  "corrections": [
    {
      "content": "Previous decision to use Zustand for state management was reversed. Zustand was overkill - React Query + useContext covers all needs.",
      "key_exchange_snippet": "changed my mind"
    }
  ],
  "key_exchange_snippets": ["React Query for server state and just useContext", "Zustand was overkill"],
  "thread_priority": "significant",
  "thread_flags": {"has_corrections": true, "has_decisions": true, "has_debugging": false}
}
```

### Extraction Tool Schema (for Anthropic tool_use)

The extraction is performed by calling Haiku with a tool definition, NOT by hoping for clean JSON from a messages call:

```javascript
const response = await anthropic.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 4096,
  tools: [{
    name: "extract_knowledge",
    description: "Extract structured knowledge from a coding session transcript",
    input_schema: {
      type: "object",
      properties: {
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "1-3 sentence summary including what was chosen, why, and what was rejected" },
              context: { type: "string" },
              chosen: { type: "string" },
              alternatives: { type: "array", items: { type: "string" } },
              reasoning: { type: "string" },
              rejected_reasons: { type: "object" },
              key_exchange_snippet: { type: "string", description: "A verbatim phrase from the turn where this decision was made, for content-matching" }
            },
            required: ["content", "key_exchange_snippet"]
          }
        },
        bugs_fixed: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "1-3 sentence summary including symptom, root cause, and fix" },
              symptom: { type: "string" },
              root_cause: { type: "string" },
              fix: { type: "string" },
              files: { type: "array", items: { type: "string" } },
              key_exchange_snippet: { type: "string" }
            },
            required: ["content", "key_exchange_snippet"]
          }
        },
        patterns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              when_to_apply: { type: "string" },
              key_exchange_snippet: { type: "string" }
            },
            required: ["content"]
          }
        },
        preferences: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              scope: { type: "string", enum: ["project", "global"] },
              key_exchange_snippet: { type: "string" }
            },
            required: ["content", "scope"]
          }
        },
        corrections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Narrative of what was wrong and what the user corrected, in one statement" },
              key_exchange_snippet: { type: "string" }
            },
            required: ["content"]
          }
        },
        facts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Non-obvious factual information discovered during the session. NOT basic project setup or tech stack info." },
              key_exchange_snippet: { type: "string" }
            },
            required: ["content"]
          }
        },
        reasoning_chains: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "The transferable diagnostic or problem-solving METHOD. Describes HOW to approach this type of problem, not the specific answer." },
              problem_type: { type: "string", description: "What class of problem this method applies to" },
              method: { type: "string", description: "Step-by-step approach" },
              key_insight: { type: "string", description: "The key realization that made the method work" },
              key_exchange_snippet: { type: "string" }
            },
            required: ["content", "problem_type"]
          }
        },
        workarounds: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "What was tried first and why it failed, then what workaround was used instead" },
              ideal_approach: { type: "string" },
              why_it_failed: { type: "string" },
              workaround_used: { type: "string" },
              key_exchange_snippet: { type: "string" }
            },
            required: ["content"]
          }
        },
        anti_patterns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "What NOT to do and why. Format: 'Don't X because Y. Instead, Z.'" },
              trigger: { type: "string", description: "The situation or temptation that leads to this anti-pattern" },
              why_bad: { type: "string", description: "What goes wrong when you do it" },
              better_approach: { type: "string", description: "What to do instead" },
              key_exchange_snippet: { type: "string" }
            },
            required: ["content"]
          }
        },
        key_exchange_snippets: {
          type: "array",
          items: { type: "string" },
          description: "Verbatim phrases from the most critical moments in the conversation. Used for content-matching to mark key exchange turns."
        },
        thread_priority: {
          type: "string",
          enum: ["critical", "significant", "routine"]
        },
        thread_flags: {
          type: "object",
          properties: {
            has_corrections: { type: "boolean" },
            has_decisions: { type: "boolean" },
            has_debugging: { type: "boolean" }
          }
        },
        impasse_severity: {
          type: "number",
          minimum: 0.0,
          maximum: 1.0,
          description: "0.0 = no impasse (most sessions). 0.3 = brief retry (one approach failed, quickly pivoted). 0.7 = significant struggle (3+ failed attempts before solution). 1.0 = severe impasse (5+ turns circling same problem before breakthrough). CALIBRATION: 60-70% of sessions should be 0.0. Only 10-15% should score above 0.5. A single retry is NOT an impasse."
        }
      },
      required: ["thread_priority", "thread_flags"]
    }
  }],
  tool_choice: { type: "tool", name: "extract_knowledge" },
  messages: [{
    role: "user",
    content: extractionPrompt + "\n\nTRANSCRIPT:\n<transcript>\n" + transcriptText + "\n</transcript>"
  }]
});
```

### Key Exchange Identification: Content-Matching, Not Turn Numbers

The original spec asked Haiku to report `turn_number` for each extracted item. This is unreliable - LLMs are imprecise at tracking numeric labels across long documents, and can be off by 1-3 turns.

**New approach:** Instead of turn numbers, Haiku provides `key_exchange_snippet` - a verbatim phrase from the critical turn. The worker then:
1. Searches the thread's turns for that snippet using case-insensitive substring match (`INSTR(LOWER(user_content || assistant_content), LOWER(snippet)) > 0`). Falls back to FTS5 phrase match if substring fails (handles minor Haiku paraphrasing).
2. Marks the matching turn as `is_key_exchange = 1`
3. Also marks the adjacent turns (turn-1 and turn+1) as potential key exchanges (catches near-misses)

This is more reliable because it matches on actual content, not on a number Haiku might miscount.

### How Extraction Output Maps To Storage

| Extraction field | Stored as |
|-----------------|-----------|
| decisions[].content | knowledge atom type='decision', all reasoning inlined in content |
| bugs_fixed[].content | knowledge atom type='debugging' |
| patterns[].content | knowledge atom type='pattern' |
| preferences[].content | knowledge atom type='preference', scope from extraction |
| corrections[].content | knowledge atom type='correction' |
| facts[].content | knowledge atom type='fact' |
| reasoning_chains[].content | knowledge atom type='reasoning_chain', method inlined in content |
| workarounds[].content | knowledge atom type='workaround', ideal approach inlined in content |
| anti_patterns[].content | knowledge atom type='anti_pattern', trigger/better approach inlined in content |
| key_exchange_snippets | Used to mark turns via content-matching |
| thread_priority | threads table: SET priority=value |
| thread_flags | threads table: SET has_corrections, has_decisions, has_debugging |
| impasse_severity | SET impasse_severity=<float value> on all atoms extracted from this session |

### Deduplication on Extracted Atoms

When storing a new extracted atom:
1. Generate its embedding via OpenAI API (synchronous)
2. Find top 3 most similar existing atoms via sqlite-vec KNN (cosine distance)
3. **Cosine distance < 0.08 (similarity > 0.92):** Near-duplicate. Reinforce existing atom (bump confidence, update timestamp, merge source_thread references).
4. **Cosine distance >= 0.08 (similarity <= 0.92):** Different enough. Create new atom.
5. **No automatic contradiction detection.** Contradictions are handled by periodic LLM consolidation (Section 17) and explicit `memory_feedback(signal='corrected')`.

Why 0.92 threshold: High enough to catch near-duplicates ("Unipile needs HTTPS" vs "Unipile webhook URLs must use HTTPS") but low enough to keep genuinely different items separate.

### API Configuration

**Haiku call (tool_use):** See schema above. `max_tokens: 4096` (increased from 2048 to prevent truncation on rich sessions).

**OpenAI embedding call:**
```javascript
const response = await openai.embeddings.create({
  model: "text-embedding-3-small",
  input: texts,  // batch of up to 20 strings
  dimensions: 1536
});
```

### Required API Keys

Both stored in `~/.claude/memory-server/.env` (chmod 600) and loaded by worker.js at startup:
- `ANTHROPIC_API_KEY` - for Haiku extraction and consolidation
- `OPENAI_API_KEY` - for embeddings

**API key validation at startup:** Worker checks both keys exist and makes a test API call (minimal embedding request). If either fails, worker logs a clear error and exits immediately. This prevents the worker from silently failing on every job, burning through retries, and permanently marking all jobs as failed.

**launchd integration:** The launchd plist must set `EnvironmentVariables` for both keys OR the worker must always read from the `.env` file (never rely on shell environment, which launchd doesn't inherit).

---

## 10. Hybrid Search Engine

### Architecture

Two parallel search paths merged via RRF:

```
Query: "how did we handle pagination"
  |
  +---> [OpenAI embed, cached] --> 1536-dim vector
  |           |
  |     [sqlite-vec KNN, cosine distance]
  |           |
  |     Vector results (ranked by cosine similarity):
  |       #1: "Chose cursor-based pagination for Unipile inbox API..." (distance 0.11)
  |       #2: "React Query useInfiniteQuery handles pagination state..." (distance 0.18)
  |       #3: "Unipile returns max 50 items per page, use cursor..." (distance 0.22)
  |
  +---> [FTS5 BM25 search with porter stemming]
  |           |
  |     BM25 results (ranked by term frequency, negative scores, lower = better):
  |       #1: "Chose cursor-based pagination for Unipile inbox API..."
  |       #2: "Pagination component uses @/components/ui/pagination..."
  |       #3: "API pagination offset vs cursor comparison..."
  |
  +---> [RRF merge, k=15]
          |
          Final ranking:
            #1: "Chose cursor-based pagination..." (in both, ranked #1 in both)
            #2: "React Query useInfiniteQuery..." (vector #2, BM25 didn't find it)
            #3: "Unipile returns max 50..." (vector #3, BM25 didn't find it)
            #4: "Pagination component uses..." (BM25 #2, vector didn't find it)
```

### sqlite-vec Distance Metric

All vec0 tables use `distance_metric=cosine`:
```sql
CREATE VIRTUAL TABLE knowledge_embeddings USING vec0(
  atom_id INTEGER PRIMARY KEY,
  embedding float[1536] distance_metric=cosine
);
```

This returns **cosine distance** (not L2 distance):
- 0.0 = identical vectors
- 0.08 = cosine similarity of 0.92 (our dedup threshold)
- 0.30 = cosine similarity of 0.70 (related but distinct)
- 1.0 = orthogonal (unrelated)
- 2.0 = opposite

All threshold comparisons use cosine distance directly:
- Dedup: `distance < 0.08` (similarity > 0.92)
- Connection discovery (future): `distance < 0.30` (similarity > 0.70)

### Why Hybrid Beats Either Alone

**BM25 alone misses:** Semantic matches where the words are different. "How did we handle pagination" won't find "cursor-based scrolling through API results."

**Vectors alone miss:** Exact keyword matches for technical terms. Searching "useInfiniteQuery" should find that exact hook name. Vectors might rank a generic "data fetching" atom higher because it's semantically broad. (Note: Porter stemming also hurts BM25 for technical identifiers - see Section 8 "Known Limitation" for mitigations.)

**Hybrid catches both:** BM25 nails keyword matches. Vectors catch semantic connections. RRF combines them.

### CONCEPT_MAP (write-time tag enrichment)

A lookup table that adds searchable tags to knowledge atoms when they are saved. Maps keywords in atom content to related concept tags that improve FTS5 recall.

```javascript
const CONCEPT_MAP = {
  'unipile':      'email linkedin calendar api integration unified-inbox',
  'supabase':     'database postgres auth backend storage',
  'react query':  'tanstack data-fetching server-state cache useQuery',
  'tailwind':     'css styling utility-classes',
  'shadcn':       'ui components radix primitives',
  'vite':         'bundler build dev-server hmr',
  'zustand':      'state-management client-state store',
  'prisma':       'orm database schema migration',
  // Add entries as new technologies are adopted in projects
};
```

**Behavior:** After atom content is finalized (in both `save_knowledge` and worker extraction), scan content for CONCEPT_MAP keys (case-insensitive). Append matching tags to the atom's `tags` field (space-separated). Tags are indexed by FTS5 alongside content, improving BM25 recall for related concepts. Vector search handles semantic relationships at retrieval time, but tags help BM25 as well.

**Maintenance:** Update CONCEPT_MAP when new technologies are adopted.

### What Was Removed From Search

| Removed | Why |
|---------|-----|
| Synonym expansion (1,102 pairs) | Vectors handle semantic similarity. Synonyms created noisy FTS5 OR chains. |
| Trigram FTS5 | Vectors handle fuzzy/substring matching better. |
| Weighted linear combination | Replaced by RRF which doesn't need score normalization. |
| Concept enrichment at query time | Removed. Enrichment stays at WRITE time (atom tags). |

---

## 11. Multi-Resolution Memory Model

### Resolution 3: Knowledge Atoms

**What:** 1-3 sentence distilled knowledge. The cheapest, most common retrieval unit.

**Structure:**
```
[#42] [decision] Chose Unipile API (~$55/mo) for unified inbox (email + LinkedIn + calendar)
over building custom or using Nylas. Single integration, covers all channels, reasonable pricing.
Rejected Nylas: 3x more expensive. Rejected custom: too much dev time for MVP.
```

Note: Reasoning, alternatives, and all structured metadata are inlined directly in the content field. This makes them searchable by FTS5 and vector search, and visible when hooks inject atoms into sessions.

**Token cost:** 20-100 tokens each (slightly larger than before because reasoning is included in content).

**When used:**
- PostToolUse hook: max 2 atoms, 500 token budget
- UserPromptSubmit hook: max 2 atoms, 500 token budget
- SessionStart/compact hook: top 3 atoms (alongside recovery buffer), ~2000 token budget
- recall_context with resolution=3: when Claude wants quick facts

### Resolution 2: Key Exchanges

**What:** The critical verbatim turns from a thread. Not a summary - the actual words at the turning points.

**Structure:**
```
Thread #47 [Nurch-AI] (2026-02-15, 12 turns, significant)

[Turn 3, user, CORRECTION]: "I already checked that. The URL is correct.
The issue is it works on localhost but not production."

[Turn 8, user, ROOT_CAUSE]: "Oh wait, the issue was the webhook URL needs
HTTPS, not HTTP on production"

[Turn 9, assistant, RESOLUTION]: "That makes sense - Unipile validates SSL
certificates on webhook endpoints. On localhost HTTP works because..."
```

**Token cost:** 100-500 tokens per thread.

**Fallback:** If a thread matches search but has zero key exchanges marked (legacy data, extraction failed, Haiku found none), the system falls back to:
1. Show the atom extracted from that thread (Resolution 3), OR
2. Show the first 2 and last 2 turns as a summary

This prevents empty results for matched threads.

**When used:**
- recall_context default (resolution=2): the standard search result format
- /primeDB: used when Claude drills into specific threads after the initial atom map

### Resolution 1: Full Threads

**What:** The complete conversation. Every turn.

**Token cost:** 500-5,000 tokens per thread.

**Truncation:** When a thread exceeds the token budget, truncation keeps key exchange turns and removes non-key turns from the BEGINNING (resolutions and final decisions are usually at the end). Soft cap of 10,000 tokens with a note about total size.

**When used:**
- recall_context with resolution=1 and limit=1: explicit deep dive
- recall_context with expand=thread_id: drilling into a specific thread
- When debugging something similar to a past issue and you need the full diagnostic process

### Selection Logic

The trigger determines resolution:

| Trigger | Resolution | Budget | Why |
|---------|-----------|--------|-----|
| PostToolUse hook | 3 (atoms) | 500 tokens | Must be fast (500ms), lightweight |
| UserPromptSubmit hook | 3 (atoms) | 500 tokens | Must be fast (500ms), lightweight |
| SessionStart/compact hook | buffer + 3 | ~2000 tokens | Recovery: buffer first, then atoms |
| /primeDB (progressive) | 3 (atoms first), then expand specific threads | 3,000 tokens | Atom map is cheap (~300 tokens), drill into threads on demand |
| recall_context (default) | 2 (key exchanges) | 3,000 tokens | Good balance of context and cost |
| recall_context(resolution=3) | 3 (atoms) | 3,000 tokens | Quick fact check |
| recall_context(resolution=1, limit=1) | 1 (full thread) | 10,000 tokens soft cap | Deep dive |
| recall_context(expand=thread_id) | 1 (that thread) | 10,000 tokens soft cap | Drilling in from Resolution 2 |

---

## 12. Thread-Level Storage and Retrieval

### The Problem

Current system stores messages flat. You search for "OAuth debugging" and get one isolated message. But you want the entire 15-message thread - the failed attempts, the moment the root cause was found, the fix. And you want the reasoning METHOD, not just the conclusion.

### The Solution: Parent-Child Pattern

**Children = individual turns.** Small, precise, good for search matching. Each turn gets its own embedding and FTS5 index entry.

**Parents = threads.** Groups of turns from one session. Not individually indexed. Returned when a child match is found.

**How it works:**
1. Search (BM25 + vector) matches against turn-level chunks
2. Results are grouped by thread_id
3. Thread score = best_child_score * (1 + 0.15 * Math.log2(matching_turns))
4. Guard: matching_turns must be > 0 (defensive)
5. Top threads returned
6. For each thread, appropriate turns are fetched based on resolution

### Turn Chunking

One turn = one user message + one assistant response (text only, tool blocks stripped). This is the natural unit of knowledge exchange.

**Why turn-level, not message-level:**
- A user question without its answer is useless context
- A turn (Q+A pair) captures a complete knowledge exchange
- Typical turn: 200-800 tokens - optimal range for embedding precision

**Thread boundaries:**
- Default: one JSONL session file = one thread
- Long sessions (50+ turns): kept as one thread for Phase 1. Topic segmentation is a future optimization.

### Thread Identification

Thread ID = content hash of first 3 turns + timestamp_start. This is:
- **Stable across file paths** (survives directory renames, unlike path-based IDs)
- **Unique** (timestamp + content makes collisions virtually impossible)
- **Idempotent** (re-ingesting the same transcript produces the same thread_id)

### Project Identification

Project = hash of the full working directory path (not just basename).
Project display name = basename of directory (for human-readable output).

This prevents collisions between projects with the same directory name in different parent paths (e.g., two `frontend/` directories) and survives directory renames better than basename alone. A project registry maps hashes to display names.

### Thread Metadata

Each thread carries:
```
thread_id: content hash (stable, path-independent)
project: full path hash
project_name: basename (for display)
turn_count: number of turns
timestamp_start, timestamp_end: ISO 8601 UTC strings
priority: 'critical' | 'significant' | 'routine' (set by Haiku)
has_corrections: boolean
has_decisions: boolean
has_debugging: boolean
source_file: original JSONL path
file_mtime: REAL (Unix epoch, for change detection)
```

### Constraint: UNIQUE(thread_id, turn_number)

The turns table enforces `UNIQUE(thread_id, turn_number)` to prevent duplicate turns from:
- Retry after partial ingestion failure
- Concurrent ingestion of the same transcript
- Re-processing due to worker restart

This makes turn insertion idempotent via `INSERT OR IGNORE`.

---

## 13. Hooks Architecture

### Hook Registration (~/.claude/settings.json)

```json
{
  "hooks": {
    "PreCompact": [{
      "hooks": [{
        "type": "command",
        "command": "$HOME/.claude/memory-server/hooks/pre-compact.sh",
        "timeout": 2000
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "$HOME/.claude/memory-server/hooks/stop.sh",
        "timeout": 2000
      }]
    }],
    "PostToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "$HOME/.claude/memory-server/hooks/post-tool-use.sh",
        "timeout": 500
      }]
    }],
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [{
          "type": "command",
          "command": "$HOME/.claude/memory-server/hooks/session-start-compact.sh",
          "timeout": 1000
        }]
      },
      {
        "matcher": "startup",
        "hooks": [{
          "type": "command",
          "command": "$HOME/.claude/memory-server/hooks/session-start-cold.sh",
          "timeout": 1000
        }]
      }
    ],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "$HOME/.claude/memory-server/hooks/user-prompt-submit.sh",
        "timeout": 500
      }]
    }]
  }
}
```

### Hook Details

**db-write.js (Node.js helper for parameterized SQL writes from hooks)**

Eliminates edge cases where conversation content (backslash-single-quote sequences from code discussions) breaks bash sqlite3 string escaping. Only used for recovery buffer writes where content is unpredictable. Cost: ~50-80ms Node.js startup, within 2s hook timeout.

```javascript
#!/usr/bin/env node
// db-write.js - parameterized SQL insert for hook scripts
const Database = require('better-sqlite3');
const path = require('path');
const DB_PATH = process.env.DB_PATH || path.join(require('os').homedir(), '.claude/memory-server/data/memory.db');
const db = new Database(DB_PATH, { timeout: 5000 });
const [table, ...args] = process.argv.slice(2);
let content = '';
process.stdin.on('data', d => content += d);
process.stdin.on('end', () => {
  try {
    if (table === 'recovery_buffer') {
      const [project, sessionId] = args;
      db.prepare('INSERT INTO recovery_buffer (project, session_id, content, created_at) VALUES (?, ?, ?, datetime("now"))')
        .run(project, sessionId, content);
    }
  } catch (err) {
    process.stderr.write(`db-write error: ${err.message}\n`);
  }
  db.close();
});
```

**pre-compact.sh (2s timeout) - UPDATED**
Most critical hook. Preserves transcript before compaction destroys it. Now also writes recovery buffer.

1. Read transcript_path from stdin JSON (using `jq`, not python3)
2. Write last 10 turns (text-only, stripped of tool blocks) to `recovery_buffer` table (< 50ms)
3. Hard link transcript to snapshots/ (`ln` instead of `cp` - O(1) regardless of file size, eliminates timeout risk for large files)
4. Queue `ingest_thread` job at priority 10
5. Exit fast

```bash
#!/bin/bash
SERVER_DIR="$HOME/.claude/memory-server"
DB_PATH="$SERVER_DIR/data/memory.db"
SNAPSHOTS="$SERVER_DIR/snapshots"

# Log errors instead of silently discarding them
exec 2>>"$SERVER_DIR/logs/hooks.log"

INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

[ -z "$TRANSCRIPT" ] && exit 0
[ ! -f "$TRANSCRIPT" ] && exit 0

mkdir -p "$SNAPSHOTS"

# Extract project identifier (hash of full path for stability)
PROJECT_HASH=$(echo -n "$CWD" | shasum -a 256 | cut -c1-16)
PROJECT_NAME=$(basename "$CWD")
SESSION_ID=$(basename "$TRANSCRIPT" .jsonl)

# Step 1: Write recovery buffer (last 10 turns, text only + recently modified files header)
# Uses db-write.js for parameterized SQL (handles all content edge cases)

# Extract recently modified files from transcript
MODIFIED_FILES=$(tail -200 "$TRANSCRIPT" | jq -r '
  select(.type == "assistant") |
  .message.content[]? | select(.type == "tool_use") |
  select(.name == "Edit" or .name == "Write") |
  .input.file_path // empty
' 2>/dev/null | sort -u | head -5 | while read f; do [ -n "$f" ] && basename "$f"; done | tr '\n' ', ' | sed 's/,$//')

# Extract last 10 turns of text conversation
RECENT=$(tail -50 "$TRANSCRIPT" | jq -r '
  select(.type == "user" or .type == "assistant") |
  if .type == "user" then
    "[user]: " + (if (.message.content | type) == "string" then .message.content
    else ([.message.content[] | select(.type == "text") | .text] | join(" ")) end)
  elif .type == "assistant" then
    "[assistant]: " + ([.message.content[] | select(.type == "text") | .text] | join(" "))
  else empty end
' | tail -10)

if [ -n "$RECENT" ]; then
  {
    [ -n "$MODIFIED_FILES" ] && echo "Recently modified files: $MODIFIED_FILES"
    echo ""
    echo "Recent conversation context:"
    echo "$RECENT"
  } | DB_PATH="$DB_PATH" node "$SERVER_DIR/db-write.js" recovery_buffer "$PROJECT_HASH" "$SESSION_ID"
fi

# Step 2: Hard link to snapshots (O(1), no file copy)
SNAP_NAME="$(date +%s)-$(basename "$TRANSCRIPT")"
ln "$TRANSCRIPT" "$SNAPSHOTS/$SNAP_NAME" || cp "$TRANSCRIPT" "$SNAPSHOTS/$SNAP_NAME"

# Step 3: Queue ingestion job
SAFE_PATH="${SNAPSHOTS}/${SNAP_NAME}"
SAFE_PATH="${SAFE_PATH//\'/\'\'}"
sqlite3 "$DB_PATH" "
  INSERT INTO jobs (type, payload, priority, created_at)
  VALUES ('ingest_thread', json_object('transcript_path','$SAFE_PATH','project','$SAFE_PROJECT','project_name','$PROJECT_NAME'), 10, datetime('now'));
"
```

**stop.sh (2s timeout) - UPDATED**
Captures session end. Now checks for existing snapshot to prevent duplicate ingestion.

```bash
#!/bin/bash
SERVER_DIR="$HOME/.claude/memory-server"
DB_PATH="$SERVER_DIR/data/memory.db"

# Log errors instead of silently discarding them
exec 2>>"$SERVER_DIR/logs/hooks.log"

INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

[ -z "$TRANSCRIPT" ] && exit 0
[ ! -f "$TRANSCRIPT" ] && exit 0

PROJECT_HASH=$(echo -n "$CWD" | shasum -a 256 | cut -c1-16)
PROJECT_NAME=$(basename "$CWD")
SESSION_BASENAME=$(basename "$TRANSCRIPT")

# Check if a snapshot already exists for this session file
EXISTING=$(sqlite3 "$DB_PATH" "
  SELECT COUNT(*) FROM jobs
  WHERE type = 'ingest_thread'
  AND json_extract(payload, '$.transcript_path') LIKE '%$SESSION_BASENAME'
  AND status IN ('pending','processing','done');
")

# If snapshot was already ingested or is pending, check if session continued after
if [ "$EXISTING" -gt 0 ]; then
  # Session may have continued after compaction - queue full transcript
  # The worker's atom-level dedup (cosine > 0.92) handles overlap
  SAFE_PATH="${TRANSCRIPT//\'/\'\'}"
  SAFE_PROJECT="${PROJECT_HASH//\'/\'\'}"
  sqlite3 "$DB_PATH" "
    INSERT INTO jobs (type, payload, priority, created_at)
    VALUES ('ingest_thread', json_object('transcript_path','$SAFE_PATH','project','$SAFE_PROJECT','project_name','$PROJECT_NAME','is_full_session', 1), 5, datetime('now'));
  "
else
  # No snapshot - queue normally
  SAFE_PATH="${TRANSCRIPT//\'/\'\'}"
  SAFE_PROJECT="${PROJECT_HASH//\'/\'\'}"
  sqlite3 "$DB_PATH" "
    INSERT INTO jobs (type, payload, priority, created_at)
    VALUES ('ingest_thread', json_object('transcript_path','$SAFE_PATH','project','$SAFE_PROJECT','project_name','$PROJECT_NAME'), 5, datetime('now'));
  "
fi
```

**post-tool-use.sh (500ms timeout) - NEW**
File-aware memory injection. Fires after every tool call Claude makes. Only acts on file operations.

```bash
#!/bin/bash
# PostToolUse hook - file-aware memory injection
# Only acts on Read/Edit/Write tools for source files
# Changes from analysis: session_id rate limiting, narrowed skip list,
# confidence >= 0.70, per-session cap of 3 injections

SERVER_DIR="$HOME/.claude/memory-server"
DB_PATH="$SERVER_DIR/data/memory.db"

exec 2>>"$SERVER_DIR/logs/hooks.log"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only trigger on file operations
case "$TOOL_NAME" in
  Read|Edit|Write) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] && exit 0

FILENAME=$(basename "$FILE_PATH" | sed 's/\.[^.]*$//')

# Skip only pure config files (narrowed from original - see Changes Log #13)
case "$FILENAME" in
  package|package-lock|tsconfig|vite.config|tailwind.config|postcss.config) exit 0 ;;
esac

# Rate limit by session_id (stable, unlike PPID which can be reused)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
SEEN_DIR="$SERVER_DIR/seen"
mkdir -p "$SEEN_DIR"
SEEN_FILE="$SEEN_DIR/${SESSION_ID:-unknown}"

# Per-session cap: max 3 file injections total (prevents noise during exploration)
if [ -f "$SEEN_FILE" ]; then
  INJECTION_COUNT=$(wc -l < "$SEEN_FILE" | tr -d ' ')
  [ "$INJECTION_COUNT" -ge 3 ] && exit 0
fi

# Per-file rate limit
grep -qx "$FILENAME" "$SEEN_FILE" 2>/dev/null && exit 0
echo "$FILENAME" >> "$SEEN_FILE"

# Detect project hash for cache lookup
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
PROJECT_HASH=$(echo -n "$CWD" | shasum -a 256 | cut -c1-16)
SAFE_PROJECT="${PROJECT_HASH//\'/\'\'}"
SAFE_FILENAME="${FILENAME//\'/\'\'}"

# Cache-first: vector-quality matching via injection_cache (Phase 4b)
ATOMS=$(sqlite3 "$DB_PATH" ".timeout 3000" -separator '|' "
  SELECT k.id, k.type, k.content, k.source_thread_id FROM injection_cache ic
  JOIN knowledge k ON k.id = ic.atom_id
  WHERE ic.project = '$SAFE_PROJECT' AND ic.context_type = 'file:$SAFE_FILENAME'
  AND k.status = 'active' AND k.confidence >= 0.70
  AND (k.injection_success_rate IS NULL OR k.injection_success_rate >= 0.20)
  ORDER BY ic.score DESC LIMIT 2;
")

# FTS fallback when cache is empty
if [ -z "$ATOMS" ]; then
  ATOMS=$(sqlite3 "$DB_PATH" ".timeout 3000" -separator '|' "
    SELECT k.id, k.type, k.content, k.source_thread_id FROM knowledge k
    WHERE k.status = 'active' AND k.confidence >= 0.70
    AND (k.injection_success_rate IS NULL OR k.injection_success_rate >= 0.20)
    AND (
      k.id IN (SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH '\"$SAFE_FILENAME\"')
      OR k.id IN (SELECT rowid FROM knowledge_fts_exact WHERE knowledge_fts_exact MATCH '\"$SAFE_FILENAME\"')
    )
    ORDER BY k.confidence DESC LIMIT 2;
  ")
fi

[ -z "$ATOMS" ] && exit 0

echo "<memory-context source=\"file:$FILENAME\">"
while IFS='|' read -r id type content thread_id; do
  echo "[#$id] [$type] (thread:$thread_id) $content"
  # Update last_injected_at
  sqlite3 "$DB_PATH" "UPDATE knowledge SET last_injected_at = datetime('now') WHERE id = $id;" 2>/dev/null
done <<< "$ATOMS"
echo "</memory-context>"
```

**session-start-cold.sh (1s timeout) - SIMPLIFIED**
Minimal reminder, no auto-injection.

```bash
#!/bin/bash
exec 2>>"$HOME/.claude/memory-server/logs/hooks.log"

# Check if worker is disabled (repeated failures - see Changes Log #38)
if [ -f "$HOME/.claude/memory-server/.worker-disabled" ]; then
  echo "WARNING: Memory worker is disabled (repeated failures). Check ~/.claude/memory-server/logs/worker.log for errors."
else
  echo "Memory system active. Use /primeDB to load project context, /saveDB to checkpoint, /reviewDB to audit."
fi
```

**session-start-compact.sh (1s timeout) - UPDATED**
Recovery injection with recovery buffer + atoms. Reads the most recent context first.

```bash
#!/bin/bash
SERVER_DIR="$HOME/.claude/memory-server"
DB_PATH="$SERVER_DIR/data/memory.db"

# Log errors instead of silently discarding them
exec 2>>"$SERVER_DIR/logs/hooks.log"

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')

PROJECT_HASH=$(echo -n "$CWD" | shasum -a 256 | cut -c1-16)
SAFE_PROJECT="${PROJECT_HASH//\'/\'\'}"
SESSION_ID=$(basename "$TRANSCRIPT" .jsonl)
SAFE_SESSION="${SESSION_ID//\'/\'\'}"

echo "=== Memory Recovery (post-compaction) ==="
echo ""

# Priority 1: Recovery buffer scoped to THIS session ONLY
# NO project-level fallback - prevents cross-session contamination (Changes Log #23)
BUFFER=$(sqlite3 "$DB_PATH" "
  SELECT content FROM recovery_buffer
  WHERE session_id = '$SAFE_SESSION'
  ORDER BY created_at DESC LIMIT 1;
")

if [ -n "$BUFFER" ]; then
  echo "$BUFFER"
  echo ""
fi

# Priority 2: Cache-first topic-aware atom selection (Phase 4b)
ATOMS=$(sqlite3 "$DB_PATH" ".timeout 3000" -separator '|' "
  SELECT k.id, k.type, k.content FROM injection_cache ic
  JOIN knowledge k ON k.id = ic.atom_id
  WHERE ic.project = '$SAFE_PROJECT' AND ic.context_type = 'project_general'
  AND k.status = 'active' AND k.confidence >= 0.70
  AND (k.injection_success_rate IS NULL OR k.injection_success_rate >= 0.20)
  ORDER BY ic.score DESC LIMIT 3;
")

# FTS fallback: extract keywords from recovery buffer
if [ -z "$ATOMS" ] && [ -n "$BUFFER" ]; then
  STOPWORDS='this|that|with|from|have|been|were|what|when|will|your|just|like|also|than|then|them|into|some|could|would|should|about|after|before|other|which|their|there|these|those|being|doing|going|using|where|while|does|each|make|made|need|only|over|same|such|take|want|very|more|most|much|many|here|back|know|well|even|work|look|time|file|code|line|sure|used|part|seem|find|test|next|type|call|name|tool|read|edit|near'
  KEYWORDS=$(echo "$BUFFER" | tr '[:upper:]' '[:lower:]' | grep -oE '\b[a-z]{5,}\b' | grep -viE "^($STOPWORDS)$" | sort | uniq -c | sort -rn | head -5 | awk '{print $2}')
  if [ -n "$KEYWORDS" ]; then
    FTS_QUERY=$(echo "$KEYWORDS" | tr '\n' ' ' | sed 's/ *$//' | sed 's/ / OR /g')
    ATOMS=$(sqlite3 "$DB_PATH" ".timeout 3000" -separator '|' "
      SELECT k.id, k.type, k.content FROM knowledge k
      WHERE k.status = 'active' AND k.confidence >= 0.70
      AND (k.injection_success_rate IS NULL OR k.injection_success_rate >= 0.20)
      AND (k.project = '$SAFE_PROJECT' OR k.scope = 'global')
      AND (
        k.id IN (SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH '$FTS_QUERY')
        OR k.id IN (SELECT rowid FROM knowledge_fts_exact WHERE knowledge_fts_exact MATCH '$FTS_QUERY')
      )
      ORDER BY k.confidence DESC LIMIT 3;
    " 2>/dev/null)
  fi
fi

# Fallback: confidence-based if both cache and FTS found nothing
if [ -z "$ATOMS" ]; then
  ATOMS=$(sqlite3 "$DB_PATH" ".timeout 3000" -separator '|' "
    SELECT id, type, content FROM knowledge
    WHERE status = 'active' AND confidence >= 0.70
    AND (injection_success_rate IS NULL OR injection_success_rate >= 0.20)
    AND (project = '$SAFE_PROJECT' OR scope = 'global')
    ORDER BY confidence DESC, updated_at DESC
    LIMIT 3;
  ")
fi

if [ -n "$ATOMS" ]; then
  echo "Related knowledge:"
  while IFS='|' read -r id type content; do
    echo "[#$id] [$type] $content"
  done <<< "$ATOMS"
  echo ""
fi

echo "Use /primeDB to load more context, or call recall_context with a query relevant to your current task."
```

**user-prompt-submit.sh (500ms timeout) - UPDATED**
Better signal detection. No python3 dependency. Fixed PascalCase regex.

```bash
#!/bin/bash
SERVER_DIR="$HOME/.claude/memory-server"
DB_PATH="$SERVER_DIR/data/memory.db"

# Log errors instead of silently discarding them
exec 2>>"$SERVER_DIR/logs/hooks.log"

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.user_prompt // empty')

[ -z "$PROMPT" ] && exit 0

# Gate: skip very short messages (no useful signal)
if [ ${#PROMPT} -lt 20 ]; then
  exit 0
fi

SEARCH_TERM=""

# Signal 1: Explicit file paths (src/components/Foo.tsx)
FILE_MATCH=$(echo "$PROMPT" | grep -oE 'src/[a-zA-Z0-9/_.-]+\.[a-z]+' | head -1)
if [ -n "$FILE_MATCH" ]; then
  SEARCH_TERM=$(basename "$FILE_MATCH" | sed 's/\.[^.]*$//')
fi

# Signal 2: Error-like strings
if [ -z "$SEARCH_TERM" ]; then
  ERROR_MATCH=$(echo "$PROMPT" | grep -oiE '(TypeError|ReferenceError|SyntaxError|Cannot read|undefined is not|ENOENT|EACCES|404|500|502|503)' | head -1)
  if [ -n "$ERROR_MATCH" ]; then
    SEARCH_TERM="$ERROR_MATCH"
  fi
fi

# Signal 3: Multi-segment PascalCase (3+ segments to avoid false positives)
# Matches InboxCalendar, EnrichmentPanel but NOT TypeScript, JavaScript, LinkedIn, OAuth
if [ -z "$SEARCH_TERM" ]; then
  COMPONENT=$(echo "$PROMPT" | grep -oE '\b[A-Z][a-z]+([A-Z][a-z]+){2,}\b' | head -1)
  if [ -n "$COMPONENT" ]; then
    SEARCH_TERM="$COMPONENT"
  fi
fi

# Signal 4: Problem language - restricted to first 40 chars (Changes Log #16-19)
# Only triggers when problem word is NEAR THE BEGINNING (user HAS a problem, not discussing errors)
# Removed "error" and "issue" (too generic - "add error handling" is not a problem report)
if [ -z "$SEARCH_TERM" ]; then
  FIRST_PART="${PROMPT:0:40}"
  PROBLEM=$(echo "$FIRST_PART" | grep -oiE '\b(crash(ing|ed)?|break(ing)?|broken|slow|fail(ing|ed|s)?|wrong|stuck|bug(gy)?)\b' | head -1)
  if [ -n "$PROBLEM" ]; then
    RAW_TERM=$(echo "$PROMPT" | sed -E "s/$PROBLEM//i" | tr -s ' ' | sed 's/^ *//;s/ *$//' | head -c 80)
    # Sanitize FTS5 operators (Changes Log #18)
    RAW_TERM=$(echo "$RAW_TERM" | sed 's/[()\"*^]//g' | sed 's/\bAND\b//gi; s/\bOR\b//gi; s/\bNOT\b//gi; s/\bNEAR\b//gi')
    # Require 2+ non-stopword terms (words > 3 chars) to prevent garbage queries (Changes Log #19)
    WORD_COUNT=$(echo "$RAW_TERM" | grep -oE '\b[a-zA-Z]{4,}\b' | wc -l | tr -d ' ')
    if [ "$WORD_COUNT" -ge 2 ]; then
      SEARCH_TERM="$RAW_TERM"
    fi
  fi
fi

# No signal detected - stay silent
[ -z "$SEARCH_TERM" ] && exit 0

# Search knowledge atoms via FTS5 (stemmed + exact for identifier matching)
# Confidence >= 0.70 for auto-injection (higher bar than on-demand search)
SAFE_TERM="${SEARCH_TERM//\'/\'\'}"

# Phrase match for precise signals (1-3), OR-based for multi-word Signal 4
if [ "$SIGNAL_TYPE" = "terms" ]; then
  FTS_MATCH=$(echo "$SAFE_TERM" | grep -oE '\b[a-zA-Z]{4,}\b' | head -5 | tr '\n' ' ' | sed 's/ *$//' | sed 's/ / OR /g')
else
  FTS_MATCH="\"$SAFE_TERM\""
fi

[ -z "$FTS_MATCH" ] && exit 0

ATOMS=$(sqlite3 -separator '|' "$DB_PATH" "
  SELECT k.id, k.type, k.content FROM knowledge k
  WHERE k.status = 'active' AND k.confidence >= 0.70
  AND (k.injection_success_rate IS NULL OR k.injection_success_rate >= 0.20)
  AND (
    k.id IN (SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH '$FTS_MATCH')
    OR k.id IN (SELECT rowid FROM knowledge_fts_exact WHERE knowledge_fts_exact MATCH '$FTS_MATCH')
  )
  ORDER BY k.confidence DESC LIMIT 2;
")

[ -z "$ATOMS" ] && exit 0

echo "<memory-context>"
while IFS='|' read -r id type content; do
  echo "[#$id] [$type] $content"
done <<< "$ATOMS"
echo "</memory-context>"
```

### Hook Error Logging

All hooks redirect stderr to `$SERVER_DIR/logs/hooks.log` via `exec 2>>"$SERVER_DIR/logs/hooks.log"` at the top of each script. This replaces the previous pattern of `2>/dev/null` on every command, which silently discarded all errors and made debugging impossible. Errors are now logged with timestamps (from the failing command) while stdout (which is what gets injected into Claude's context) remains clean.

### Hook Timeout Behavior

When a hook times out, Claude Code kills the process and proceeds without the hook's output. For memory hooks, this is the correct degradation: silent failure, no error shown to user, session continues without memory injection. This is safe because all hooks are additive (they inject optional context) - no hook is required for Claude to function.

### jq Dependency

All hooks use `jq` instead of `python3` for JSON parsing. `jq` cold starts in ~20ms vs python3's 200-400ms, critical for the 500ms UserPromptSubmit and PostToolUse budgets. `jq` is not installed by default on macOS but is available via `brew install jq`. The setup script should verify jq is available and install it if missing.

---

## 14. MCP Tools - What Claude Can Call

### recall_context (REWRITE)

The primary search tool. Uses hybrid search + multi-resolution with caching.

```
Parameters:
  query: string (required)     - what to search for
  resolution: 1|2|3            - detail level (default: 2)
  project: string              - filter to project (optional, defaults to current. Use '*' for cross-project)
  type: string                 - filter to knowledge type (optional, e.g. 'decision', 'debugging', 'pattern')
  limit: number                - max results (default: 5)
  expand: string               - specific thread_id to get full content (soft cap 10,000 tokens)
  files: string[]              - file paths Claude is working with (optional, enriches search)
  since: string                - ISO date, filter results after this date (optional)
  until: string                - ISO date, filter results before this date (optional)

Behavior:
  1. If expand is set: return full thread for that thread_id. Apply 10,000 token soft cap.
     If thread exceeds cap, truncate non-key turns from beginning, keep key exchanges and end.
     Note total size for user.
  2. If files is set: append file names to query for enriched search
  3. If type is set: add WHERE clause filtering knowledge.type = ? (applied to both BM25 and vector results post-merge)
  4. Check embedding cache (LRU, 20 entries). Hit = skip API call.
  5. Generate query embedding via OpenAI (cache miss)
  6. Run BM25 search on turns_fts (and knowledge_fts if resolution=3)
     Wrap FTS5 search + join in single read transaction (prevents stale rowid from concurrent writes)
  7. Run vector KNN on turn_embeddings (and knowledge_embeddings if resolution=3)
     Using cosine distance (distance_metric=cosine on vec0 tables)
  8. Merge via RRF (k=15)
  9. Group by thread, score threads (Math.log2, coefficient 0.15)
  10. Apply priority tiebreaker (5% threshold, not 10%)
  11. Apply temporal filter if since/until provided
  12. Apply type filter if type parameter provided
  13. Format at requested resolution (with fallbacks for empty key exchanges)
  14. Enforce token budget (3,000 default)
  15. Return results with thread IDs for potential expansion

Returns:
  Formatted text with results at appropriate resolution.
  Each result includes thread_id so Claude can call expand later.
```

### save_knowledge (UPDATED - synchronous embedding)

Explicit knowledge capture during a session.

```
Parameters:
  content: string (required)   - the knowledge (1-3 sentences, INCLUDE reasoning for decisions)
  type: string (required)      - decision/fact/pattern/preference/architecture/tool_config/debugging/correction/reasoning_chain/workaround/anti_pattern
  scope: string                - project/global (default: project)
Behavior:
  1. Enrich with concept tags (CONCEPT_MAP - see Section 10)
  2. Set decay_rate from TYPE_CONFIG based on atom type (REQUIRED - ACT-R produces NaN without it)
  3. Generate embedding via OpenAI SYNCHRONOUSLY (~50-100ms, required for dedup)
     - If OpenAI is unreachable: store atom WITHOUT embedding, set embed_status='pending'
     - Fall back to FTS5 exact content match for dedup (less precise but functional)
     - Worker backfills pending embeddings on next successful API connection
  4. Deduplicate:
     - Cosine distance < 0.20 (similarity > 0.80): reinforce existing
     - Cosine distance >= 0.20: create new
     - If no embedding (API was down): exact content match only
     - No automatic contradiction detection (handled by consolidation)
  5. Store atom with source_type, embedding, decay_rate
  6. Return confirmation with atom ID

Source types and confidence levels:
  user_explicit: 0.95 (user said "remember this")
  model_initiated: 0.80 (Claude decided to save)
  llm_extracted: 0.75 (Haiku extracted from transcript)
```

### memory_manage (CONSOLIDATED - merged memory_feedback + memory_admin + ingest_new_sessions)

Unified tool for all management, feedback, and maintenance operations. Reduces context overhead from 3 tool definitions to 1.

```
Parameters:
  action: string (required)    - feedback/batch_feedback/list/view/delete/edit/recent_extractions/reextract/archive_project/purge_archived/summary/stale/low_confidence/most_used/disk_usage/ingest_sessions
  atom_id: number (optional)   - for feedback/view/delete/edit
  signal: string (optional)    - confirmed/corrected/rejected/helpful/applied/ignored/contradicted/task_success/task_failure/stale (for feedback)
  correction: string (optional) - replacement content (if signal=corrected)
  outcomes: array (optional)   - batch outcomes [{atom_id, signal, detail?}] (for batch_feedback)
  content: string (optional)   - new content (for edit)
  limit: number (optional)     - result limit (default: 20)
  type: string (optional)      - type filter (for list)
  thread_id: string (optional) - for reextract
  project: string (optional)   - for archive_project

Behavior:
  Feedback actions:
    feedback: Single atom feedback (atom_id + signal required).
      confirmed: confidence += 0.15
      corrected: old atom superseded, new atom created at 0.95
      rejected: atom archived
      helpful: confidence += 0.10
      applied/ignored/contradicted/task_success/task_failure/stale: adjust confidence by delta
    batch_feedback: Process outcomes array, return count.
  Management actions:
    list: Active atoms, optionally filtered by type. ORDER BY updated_at DESC.
    view: Full atom with all fields.
    delete: Soft delete (status='archived').
    edit: Update content, regenerate embedding.
    recent_extractions: Last N llm_extracted atoms with dates.
    reextract: Queue re-extraction job for a thread.
    archive_project: Archive all atoms for a project.
    purge_archived: Permanently delete archived atoms.
  Stats actions:
    summary: Total atoms, threads, types, jobs, DB size.
    stale: Atoms not accessed in 30+ days.
    low_confidence: Atoms with confidence < 0.40.
    most_used: Top 10 atoms by access_count.
    disk_usage: DB size, snapshots size, embedding counts.
  Ingest actions:
    ingest_sessions: Re-scan project directories for new session files.
```

---

## 15. Slash Commands - /primeDB and /saveDB

These are implemented via CLAUDE.md instructions. Claude reads the instructions and knows what to do.

### /primeDB

Add to project CLAUDE.md or global CLAUDE.md:

```markdown
## Memory Commands
- When the user says "/primeDB", load relevant memory context using progressive disclosure:
  1. Look at the conversation so far to understand what the user is working on
  2. Call recall_context with resolution=3 (atoms) to get a lightweight map of available knowledge
  3. If the conversation is empty/just started, ask the user what they're working on, or use the project name as the query
  4. Present a brief summary of what was found (e.g., "Found 8 relevant items: Unipile setup, pagination decision, timezone debugging...")
  5. For any item that looks particularly relevant to the current task, call recall_context(expand=thread_id) to drill into the full thread
  6. Do not dump raw results - summarize what context is now available and note which threads can be expanded
  7. If the user needs more detail on a specific topic, use recall_context with resolution=2 or expand to drill deeper
```

### /saveDB

```markdown
- When the user says "/saveDB", checkpoint important knowledge from this session:
  1. Review the conversation since the last /saveDB (or session start)
  2. Identify decisions (with reasoning!), bugs fixed (with root cause!), patterns learned, preferences stated, corrections made, reasoning methods used, workarounds applied, anti-patterns discovered
  3. For each item worth saving, call save_knowledge with appropriate type and structured content
  4. For decisions: always include reasoning and alternatives IN the content field
  5. For reasoning chains: extract the transferable METHOD, not just the specific answer
  6. For anti-patterns: format as "Don't X because Y. Instead, Z." - only when something was tried and failed
  7. **Before saving: list what you plan to save (type + one-line summary). Wait for user confirmation** ("save all", "skip #2", etc.). Maximum 5 items per /saveDB.
  8. Only then call save_knowledge for approved items
  9. Confirm what was saved
  10. If nothing worth saving: say so honestly
  11. Check existing atoms for contradictions with what you're about to save. If found, use memory_feedback to correct the old atom.
```

### /reviewDB

```markdown
- When the user says "/reviewDB":
  1. Call memory_admin(action='recent_extractions', limit=10)
  2. Present each atom: [#id] [type] content (extracted from session on DATE)
  3. Ask: "Any of these wrong or low-quality? I can reject, correct, or confirm them."
  4. For flagged items: call memory_feedback with appropriate signal
  5. Also check memory_admin(action='low_confidence') and report any low-confidence atoms
```

### /forgetDB

```markdown
- When the user says "/forgetDB [topic]":
  1. Call recall_context with the topic at resolution=3
  2. Present matching atoms with IDs and content
  3. Ask which ones to delete
  4. Call memory_admin(action='delete') for each confirmed deletion
  5. Confirm what was removed
```

### Post-Compaction Reliability

After compaction, Claude may not have the full CLAUDE.md instructions in its summarized context. The SessionStart/compact hook output includes "Use /primeDB to load more context" as a reminder. If Claude doesn't recognize /primeDB after compaction, the recovery buffer and auto-injected atoms still provide continuity. The /primeDB command is most valuable at session start (before any compaction), where CLAUDE.md is fully loaded.

---

## 16. Database Schema

### New Schema (replaces current)

Migration is non-destructive. Old tables (messages, sessions) are kept. New tables are added alongside. All connections use `PRAGMA foreign_keys = ON` in both server.js and worker.js.

```sql
-- Enable foreign key enforcement (must be set per-connection)
PRAGMA foreign_keys = ON;

-- Set busy timeout to handle concurrent access between server and worker
PRAGMA busy_timeout = 5000;

-- ============================================================================
-- THREADS: Conversation sessions (parent records)
-- ============================================================================

CREATE TABLE threads (
  id TEXT PRIMARY KEY,                -- content hash of first 3 turns + timestamp (stable, path-independent)
  project TEXT NOT NULL,              -- hash of full working directory path
  project_name TEXT,                  -- basename of directory (for display)
  turn_count INTEGER NOT NULL,
  timestamp_start TEXT,               -- ISO 8601 UTC
  timestamp_end TEXT,                 -- ISO 8601 UTC
  priority TEXT DEFAULT 'routine' CHECK(priority IN ('critical','significant','routine')),
  has_corrections INTEGER DEFAULT 0,
  has_decisions INTEGER DEFAULT 0,
  has_debugging INTEGER DEFAULT 0,
  source_file TEXT NOT NULL,          -- original JSONL path
  file_mtime REAL NOT NULL,           -- Unix epoch, for change detection
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_threads_project ON threads(project);
CREATE INDEX idx_threads_priority ON threads(priority, created_at DESC);
CREATE INDEX idx_threads_timestamp ON threads(timestamp_start, timestamp_end);

-- ============================================================================
-- TURNS: Individual conversation turns (child chunks, search targets)
-- ============================================================================

CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  user_content TEXT,                  -- full text, no cap, tool blocks stripped
  assistant_content TEXT,             -- full text, no cap, tool blocks stripped
  timestamp TEXT,                     -- ISO 8601 UTC
  is_key_exchange INTEGER DEFAULT 0,
  key_exchange_type TEXT,             -- 'correction','root_cause','decision','breakthrough'
  tool_calls_count INTEGER DEFAULT 0, -- count of tool_use blocks in original message
  has_error INTEGER DEFAULT 0,
  embed_status TEXT DEFAULT 'pending' CHECK(embed_status IN ('pending','done','failed')),
  UNIQUE(thread_id, turn_number)      -- prevents duplicate turns on retry
);

CREATE INDEX idx_turns_thread ON turns(thread_id, turn_number);
CREATE INDEX idx_turns_key ON turns(is_key_exchange) WHERE is_key_exchange = 1;

-- ============================================================================
-- TURN EMBEDDINGS: Vector search on turns (sqlite-vec, cosine distance)
-- ============================================================================

CREATE VIRTUAL TABLE turn_embeddings USING vec0(
  turn_id INTEGER PRIMARY KEY,
  embedding float[1536] distance_metric=cosine
);

-- ============================================================================
-- TURNS FTS: Full-text keyword search on turns
-- ============================================================================

CREATE VIRTUAL TABLE turns_fts USING fts5(
  content,
  content='turns',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- FTS sync triggers (INSERT, DELETE, and UPDATE)
CREATE TRIGGER turns_fts_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, content)
  VALUES (new.id, COALESCE(new.user_content,'') || ' ' || COALESCE(new.assistant_content,''));
END;

CREATE TRIGGER turns_fts_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content)
  VALUES('delete', old.id, COALESCE(old.user_content,'') || ' ' || COALESCE(old.assistant_content,''));
END;

CREATE TRIGGER turns_fts_au AFTER UPDATE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content)
  VALUES('delete', old.id, COALESCE(old.user_content,'') || ' ' || COALESCE(old.assistant_content,''));
  INSERT INTO turns_fts(rowid, content)
  VALUES (new.id, COALESCE(new.user_content,'') || ' ' || COALESCE(new.assistant_content,''));
END;

-- ============================================================================
-- KNOWLEDGE: Extracted atoms (primary injection surface)
-- ============================================================================

CREATE TABLE knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,               -- 1-3 sentence summary WITH reasoning inline (searchable)
  metadata TEXT,                       -- JSON: legacy field, structured data now inlined into content
  type TEXT NOT NULL CHECK(type IN (
    'preference','decision','fact','pattern',
    'architecture','tool_config','debugging','correction',
    'reasoning_chain','workaround','anti_pattern'
  )),
  scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','global')),
  project TEXT,
  project_name TEXT,                   -- display name
  origin_project TEXT,                 -- original project (preserved even for global atoms)
  tags TEXT,                           -- concept enrichment tags (space-separated)
  source_type TEXT CHECK(source_type IN (
    'user_explicit','model_initiated','llm_extracted'
  )),
  source_thread_id TEXT,               -- links back to source thread
  confidence REAL NOT NULL DEFAULT 0.80,
  access_count INTEGER NOT NULL DEFAULT 1,   -- starts at 1 (creation counts as first access, prevents ACT-R degenerate scores)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT,
  decay_rate REAL,                    -- ACT-R decay parameter, per-type (e.g., 0.15 for architecture, 0.40 for debugging). MUST be set on insert from TYPE_CONFIG.
  impasse_severity REAL DEFAULT 0.0,  -- 0.0-1.0 float. 0.0=no impasse, 0.3=brief retry, 0.7=significant struggle, 1.0=severe impasse
  last_injected_at TEXT,              -- timestamp of last hook injection (for monitoring and future injection dedup)
  contradiction_note TEXT,            -- set by consolidation when contradictions found, surfaced via memory_admin
  superseded_by INTEGER REFERENCES knowledge(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','archived'))
);

CREATE INDEX idx_knowledge_status ON knowledge(status);
CREATE INDEX idx_knowledge_type ON knowledge(type) WHERE status = 'active';
CREATE INDEX idx_knowledge_project ON knowledge(project) WHERE status = 'active';
CREATE INDEX idx_knowledge_confidence ON knowledge(confidence DESC) WHERE status = 'active';
-- topic_hash, valid_at, invalid_at: CUT from v1. See Changes Log items 1-3.

-- ============================================================================
-- KNOWLEDGE EMBEDDINGS: Vector search on atoms (sqlite-vec, cosine distance)
-- ============================================================================

CREATE VIRTUAL TABLE knowledge_embeddings USING vec0(
  atom_id INTEGER PRIMARY KEY,
  embedding float[1536] distance_metric=cosine
);

-- ============================================================================
-- KNOWLEDGE FTS: Keyword search on atoms
-- ============================================================================

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  content, tags,
  content='knowledge',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- FTS sync triggers (INSERT, DELETE, UPDATE)
CREATE TRIGGER knowledge_fts_ai AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts(rowid, content, tags)
  VALUES (new.id, new.content, COALESCE(new.tags,''));
END;

CREATE TRIGGER knowledge_fts_ad AFTER DELETE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags)
  VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
END;

CREATE TRIGGER knowledge_fts_au AFTER UPDATE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags)
  VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
  INSERT INTO knowledge_fts(rowid, content, tags)
  VALUES (new.id, new.content, COALESCE(new.tags,''));
END;

-- ============================================================================
-- RECOVERY BUFFER: Recent turns for post-compaction recovery
-- ============================================================================

CREATE TABLE recovery_buffer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  session_id TEXT,                      -- session identifier to scope buffer per concurrent session
  content TEXT NOT NULL,               -- last 10 turns, text only
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_recovery_project ON recovery_buffer(project, created_at DESC);

-- ============================================================================
-- CONNECTIONS: Related thread links (post-v1)
-- ============================================================================

CREATE TABLE connections (
  thread_a TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  thread_b TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  similarity REAL NOT NULL,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (thread_a, thread_b)
);

-- ============================================================================
-- INJECTION EVENTS: Tracks hook-injected atoms for feedback loop (Phase 3)
-- ============================================================================

CREATE TABLE injection_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  atom_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  session_file TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN ('post_tool_use','user_prompt_submit','session_start_compact')),
  injected_at TEXT NOT NULL DEFAULT (datetime('now')),
  was_referenced INTEGER DEFAULT NULL  -- NULL=unknown, 1=yes, 0=no
);

CREATE INDEX idx_injection_atom ON injection_events(atom_id);
CREATE INDEX idx_injection_session ON injection_events(session_file);

-- ============================================================================
-- INJECTION CACHE: Pre-computed vector-quality matches for hook queries (Phase 4b)
-- Populated by worker after each ingestion via refreshInjectionCache()
-- Hooks query this instead of running live FTS, falling back to FTS when cache is empty
-- ============================================================================

CREATE TABLE injection_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,              -- project hash
  atom_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  score REAL NOT NULL,                -- cosine similarity score
  context_type TEXT NOT NULL,         -- 'project_general' or 'file:<basename>'
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project, atom_id, context_type)
);

CREATE INDEX idx_injection_cache_project ON injection_cache(project, context_type);

-- ============================================================================
-- JOBS: Async work queue
-- ============================================================================

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN (
    'ingest_thread','consolidate','archive_stale','discover_connections'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending','processing','done','failed'
  )),
  payload TEXT NOT NULL,               -- JSON
  priority INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  retry_count INTEGER DEFAULT 0
);

CREATE INDEX idx_jobs_status ON jobs(status, priority DESC, created_at ASC);

-- ============================================================================
-- STATS: Daily snapshots for observability
-- ============================================================================

CREATE TABLE stats_daily (
  date TEXT PRIMARY KEY,               -- YYYY-MM-DD
  atoms_created INTEGER DEFAULT 0,
  atoms_deduplicated INTEGER DEFAULT 0,
  atoms_archived INTEGER DEFAULT 0,
  threads_ingested INTEGER DEFAULT 0,
  api_errors INTEGER DEFAULT 0,
  extraction_time_avg_ms INTEGER DEFAULT 0,
  total_atoms INTEGER DEFAULT 0,
  total_threads INTEGER DEFAULT 0,
  db_size_bytes INTEGER DEFAULT 0
);

-- ============================================================================
-- SCHEMA VERSION: Tracks database schema migrations
-- ============================================================================

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  description TEXT,
  embedding_model TEXT              -- tracks which model generated embeddings (for migration detection)
);

-- Insert initial version after migration
INSERT INTO schema_version (version, description, embedding_model)
VALUES (1, 'Initial rebuild schema', 'text-embedding-3-small');

-- At worker/server startup: check embedding_model matches current EMBED_MODEL constant.
-- If mismatch: queue backfill job to re-embed all atoms and turns.

-- ============================================================================
-- KEPT FROM CURRENT SYSTEM (backward compatibility + archive)
-- ============================================================================

-- messages table: kept as-is, raw message archive
-- messages_fts: kept as-is
-- sessions table: kept as-is, session metadata

-- ============================================================================
-- REMOVED FROM CURRENT SYSTEM
-- ============================================================================

-- concept_synonyms: removed (vectors handle semantic similarity)
-- knowledge_trigram: removed (vectors handle fuzzy matching)
-- retrieval_events: removed (replaced by injection_events in Phase 3)
-- feedback_events: removed (replaced by injection_events in Phase 3)
-- corrections: removed (handled by superseded_by on knowledge)
-- feedback_prompts: removed (never used)
-- knowledge_sightings: removed (never used)
```

---

## 17. Worker Process

### New Worker

The new worker.js handles:
1. **Parse JSONL into turns** with tool block stripping
2. **Store threads and turns** with content-hash IDs and UNIQUE constraint
3. **Generate OpenAI embeddings** for turns and atoms (cosine distance)
4. **Call Haiku for LLM extraction** via tool_use (replaces regex)
5. **Store extracted atoms** with synchronous embedding + cosine dedup
6. **Mark key exchanges** via content-matching (not turn numbers)
7. **Consolidation** (weekly or every 20 extractions)
8. **Type-based decay + archival**
9. **Daily backup**
10. **Daily stats snapshot**
11. **Poll job queue** (10s interval, immediate re-poll when jobs remain)

### Startup Sequence

```javascript
async function startup() {
  // 1. Validate API keys
  if (!process.env.OPENAI_API_KEY) {
    console.error('FATAL: OPENAI_API_KEY not set. Check .env file.');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('FATAL: ANTHROPIC_API_KEY not set. Check .env file.');
    process.exit(1);
  }

  // 2. Test API connectivity (minimal calls)
  try {
    await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: 'test',
      dimensions: 1536
    });
  } catch (err) {
    console.error('FATAL: OpenAI API test failed:', err.message);
    process.exit(1);
  }

  // 3. Open database with safety pragmas
  const db = new Database(DB_PATH, { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // 4. Recovery sweep: reset stuck jobs
  const stuck = db.prepare(`
    UPDATE jobs SET status = 'pending', retry_count = retry_count + 1
    WHERE status = 'processing'
    AND started_at < datetime('now', '-5 minutes')
  `).run();
  if (stuck.changes > 0) {
    console.log(`Recovered ${stuck.changes} stuck jobs from previous crash`);
  }

  // 5. Start poll loop
  pollLoop(db);
}
```

### Job Types

| Job type | Triggered by | What it does |
|----------|-------------|-------------|
| ingest_thread | PreCompact/Stop hooks | Full pipeline: parse, strip tool blocks, store, embed, extract, dedup |
| consolidate | Scheduled (weekly or every 20 extractions) | Haiku reviews all active atoms, merges/archives/flags |
| archive_stale | Scheduled daily | Archive atoms past their type-specific TTL |
| discover_connections | After ingest_thread (post-v1) | Find similar threads, store links |

### Polling and Lifecycle

```javascript
const POLL_INTERVAL_MS = 10000;  // 10 seconds when idle

async function pollLoop(db) {
  while (true) {
    const job = claimNextJob(db);  // atomic UPDATE ... SET status='processing' ... RETURNING
    if (job) {
      try {
        await processJob(db, job);
        markDone(db, job.id);
        updateDailyStats(db, job);
        // Do NOT sleep - check for more jobs immediately
        continue;
      } catch (err) {
        // Detect auth errors - do not retry, they will never succeed
        const isAuthError = err.status === 401 || err.status === 403
          || (err.message && err.message.includes('invalid_api_key'));
        if (isAuthError) {
          console.error('FATAL: API authentication failed. Check .env keys.');
          markFailed(db, job.id, 'auth_error: ' + err.message);
          logApiError(db);
          // Stop processing - all subsequent API jobs will also fail
          break;
        } else if (job.retry_count < 3) {
          markPending(db, job.id);  // retry later
        } else {
          markFailed(db, job.id, err.message);
          logApiError(db);
        }
      }
    }

    // Check if scheduled jobs need to run
    await maybeRunConsolidation(db);
    await maybeRunArchiveStale(db);
    await maybeRunDailyBackup(db);
    await maybeRunStatsSnapshot(db);

    // Only sleep when no jobs are pending
    await sleep(POLL_INTERVAL_MS);
  }
}
```

### Consolidation Engine

Runs weekly or every 20 extractions (whichever comes first):

```javascript
async function runConsolidation(db) {
  // Load all active atoms grouped by type
  const atoms = db.prepare(`
    SELECT id, type, content, confidence, created_at, project_name
    FROM knowledge WHERE status = 'active'
    ORDER BY type, created_at DESC
  `).all();

  if (atoms.length === 0) return;

  // Group by type
  const byType = {};
  for (const atom of atoms) {
    (byType[atom.type] = byType[atom.type] || []).push(atom);
  }

  // Send each group to Haiku for review
  for (const [type, group] of Object.entries(byType)) {
    if (group.length < 3) continue;  // Not enough atoms to consolidate

    const atomList = group.map(a =>
      `[#${a.id}] (confidence: ${a.confidence}, created: ${a.created_at}) ${a.content}`
    ).join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      tools: [{
        name: 'consolidation_result',
        description: 'Report consolidation recommendations for a group of knowledge atoms',
        input_schema: {
          type: 'object',
          properties: {
            merge: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  atom_ids: { type: 'array', items: { type: 'number' } },
                  merged_content: { type: 'string' },
                  reason: { type: 'string' }
                },
                required: ['atom_ids', 'merged_content']
              }
            },
            archive: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  atom_id: { type: 'number' },
                  reason: { type: 'string' }
                },
                required: ['atom_id']
              }
            },
            contradictions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  atom_ids: { type: 'array', items: { type: 'number' } },
                  description: { type: 'string' }
                },
                required: ['atom_ids', 'description']
              }
            }
          }
        }
      }],
      tool_choice: { type: 'tool', name: 'consolidation_result' },
      messages: [{
        role: 'user',
        content: `Review these ${type} knowledge atoms. Identify:
1. DUPLICATES: atoms saying the same thing differently. Merge into one clean statement.
2. OUTDATED: atoms that are likely no longer true (old decisions that may have been reversed, fixes for code that has probably changed). Recommend archival.
3. CONTRADICTIONS: atoms that disagree with each other. Flag them - do not resolve, just identify.

IMPORTANT: Pay attention to creation dates. Atoms about the same topic created more than 7 days apart may be TEMPORAL VERSIONS (the newer one supersedes the older). Do NOT merge temporal versions - instead, recommend ARCHIVING the older version if the newer one clearly supersedes it. Only merge atoms that say the same thing from approximately the same time period.

Atoms:
${atomList}`
      }]
    });

    // Process recommendations - each operation in its own transaction
    // so a failure in one merge does not roll back other successful operations
    const toolResult = response.content.find(b => b.type === 'tool_use')?.input;
    if (!toolResult) continue;

    for (const merge of (toolResult.merge || [])) {
      try {
        db.transaction(() => {
          const keepId = merge.atom_ids[0];
          db.prepare('UPDATE knowledge SET content = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(merge.merged_content, keepId);
          for (const id of merge.atom_ids.slice(1)) {
            db.prepare('UPDATE knowledge SET status = \'archived\', superseded_by = ? WHERE id = ?')
              .run(keepId, id);
          }
        })();
        // Re-generate embedding for merged content (outside transaction - API call)
        // If this fails, stale embedding persists until next consolidation
      } catch (err) {
        console.error(`Consolidation merge failed for atoms ${merge.atom_ids}:`, err.message);
      }
    }

    for (const arch of (toolResult.archive || [])) {
      try {
        db.prepare('UPDATE knowledge SET status = \'archived\' WHERE id = ?').run(arch.atom_id);
      } catch (err) {
        console.error(`Consolidation archive failed for atom ${arch.atom_id}:`, err.message);
      }
    }

    // Store contradictions for user review via memory_admin(action='contradictions')
    for (const c of (toolResult.contradictions || [])) {
      for (const atomId of c.atom_ids) {
        try {
          const otherIds = c.atom_ids.filter(id => id !== atomId).join(',');
          db.prepare(
            "UPDATE knowledge SET contradiction_note = ? WHERE id = ?"
          ).run(`Conflicts with atom(s) #${otherIds}: ${c.description}`, atomId);
        } catch (err) {
          console.error(`Failed to store contradiction for atom ${atomId}:`, err.message);
        }
      }
      console.log(`CONTRADICTION STORED: atoms ${c.atom_ids.join(',')} - ${c.description}`);
    }
  }
}
```

### Type-Based Decay

```javascript
// TTL: how long before an unaccessed atom is archived
// ACT-R decay_rate: how quickly activation fades over time (lower = slower fade)
const TYPE_CONFIG = {
  preference:      { ttl: Infinity, decay_rate: 0.15 },  // stable, slow fade
  decision:        { ttl: Infinity, decay_rate: 0.15 },  // stable, slow fade
  architecture:    { ttl: Infinity, decay_rate: 0.15 },  // stable, slow fade
  pattern:         { ttl: 180,      decay_rate: 0.30 },  // moderate
  reasoning_chain: { ttl: 180,      decay_rate: 0.30 },  // moderate
  anti_pattern:    { ttl: 180,      decay_rate: 0.30 },  // moderate
  debugging:       { ttl: 90,       decay_rate: 0.40 },  // faster fade, code-specific
  fact:            { ttl: 90,       decay_rate: 0.40 },  // faster fade
  workaround:      { ttl: 90,       decay_rate: 0.40 },  // faster fade
  tool_config:     { ttl: 90,       decay_rate: 0.40 },  // faster fade
  correction:      { ttl: 60,       decay_rate: 0.50 },  // fastest fade, time-bound
};

// When storing a new atom, set its decay_rate from TYPE_CONFIG:
// atom.decay_rate = TYPE_CONFIG[atom.type].decay_rate;

async function runArchiveStale(db) {
  for (const [type, { ttl: ttlDays }] of Object.entries(TYPE_CONFIG)) {
    if (ttlDays === Infinity) continue;

    // Pure TTL: archive any atom of this type that has not been accessed
    // within the TTL window, regardless of confidence. A high-confidence
    // atom that nobody has accessed in 90+ days is stale by definition.
    // (Decision 18: confidence gate was removed because llm_extracted atoms
    // start at 0.75 and would never decay without an active feedback loop.)
    db.prepare(`
      UPDATE knowledge SET status = 'archived'
      WHERE type = ? AND status = 'active'
      AND last_accessed_at < datetime('now', '-' || ? || ' days')
    `).run(type, ttlDays);
  }

  // Fallback: flag any atom older than 180 days for consolidation review
  // (not auto-archived, but included in next consolidation run)
  // This catches preference/decision/architecture atoms that may be stale
}
```

### Git-Aware Staleness (Phase 2+)

During consolidation, for atoms that reference specific files (extracted from content via regex):
1. Check `git diff --stat <atom_created_date>..HEAD -- <file_path>`
2. If file has > 50% changed lines: lower confidence by 0.15
3. If file no longer exists: archive the atom
4. This requires the worker to have access to the project's git repo, which may not always be available. When git is not available, skip this check.

### Daily Backup

```javascript
async function runDailyBackup(db) {
  const backupPath = path.join(SERVER_DIR, 'data', 'memory-backup.db');
  db.backup(backupPath);

  // Truncate hooks.log if it grows too large
  const hooksLog = path.join(SERVER_DIR, 'logs', 'hooks.log');
  if (fs.existsSync(hooksLog)) {
    const lines = fs.readFileSync(hooksLog, 'utf8').split('\n');
    if (lines.length > 1000) {
      fs.writeFileSync(hooksLog, lines.slice(-500).join('\n'));
    }
  }

  // Clean old snapshots
  // Delete snapshot files older than 7 days that have been successfully ingested

  // Clean old recovery buffer entries (only needed for minutes, not days)
  db.prepare("DELETE FROM recovery_buffer WHERE created_at < datetime('now', '-1 hour')").run();
}
```

### Snapshot Cleanup

Snapshots are NOT deleted by the ingestion pipeline (to prevent data loss on crash). Instead, a separate cleanup runs daily:
- Find snapshot files older than 7 days
- Check that a corresponding thread exists in the database (was successfully ingested)
- Delete the snapshot file

### JSONL Read Safety

The worker's JSONL parser handles truncated files gracefully:
```javascript
// IMPORTANT: Use streaming parser, not readFileSync.
// Raw JSONL files can be 10-50MB for heavy tool-use sessions.
// readFileSync + split('\n') doubles memory usage. Streaming prevents memory pressure
// during backfill of 400 sessions.
const readline = require('readline');

async function parseJSONL(filePath) {
  const messages = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch (err) {
      // Skip malformed lines (truncated file, concurrent write)
      continue;
    }
  }
  return messages;
}
```

### Watchdog (UPDATED)

```bash
#!/bin/bash
# watchdog.sh - runs via launchd every 5 minutes

SERVER_DIR="$HOME/.claude/memory-server"
PIDFILE="$SERVER_DIR/worker.pid"
LOGFILE="$SERVER_DIR/logs/worker.log"

# Resolve Node.js path (handles nvm/fnm/asdf)
# This path is set during installation and stored in a config file
NODE_PATH=$(cat "$SERVER_DIR/.node-path" 2>/dev/null)
if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
  # Fallback: try common locations
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_PATH="$candidate"
      echo "$NODE_PATH" > "$SERVER_DIR/.node-path"
      break
    fi
  done
fi

if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
  echo "$(date): FATAL - Cannot find Node.js" >> "$LOGFILE"
  exit 1
fi

if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  # Verify PID is alive AND is actually a Node.js process (prevents PID recycling false positives)
  if kill -0 "$PID" 2>/dev/null && ps -p "$PID" -o comm= 2>/dev/null | grep -q node; then
    exit 0  # worker is alive and is node
  fi
fi

# Worker is dead or PID was recycled - restart
cd "$SERVER_DIR"
nohup "$NODE_PATH" worker.js >> "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"
echo "$(date): Worker restarted (PID $!)" >> "$LOGFILE"
```

### SQLITE_BUSY Handling

Both the MCP server (server.js) and worker (worker.js) use `better-sqlite3` with a 5-second busy timeout:
```javascript
const db = new Database(DB_PATH, { timeout: 5000 });
```
This handles concurrent write contention under WAL mode. If a write still fails after 5 seconds (extremely unlikely with single-writer patterns), it throws an error that is caught and logged.

---

## 18. File Inventory - What Gets Rewritten

| File | Action | Status | What Changes |
|------|--------|--------|-------------|
| server.js | **REWRITE** | DONE | Hybrid BM25+vector+RRF (k=15). sqlite-vec cosine distance. Multi-resolution recall_context. ACT-R with impasse context detection. Embedding LRU cache (20). 7 MCP tools. File enrichment as post-RRF 15% boost. FTS5 query sanitization. |
| worker.js | **REWRITE** | DONE | Streaming JSONL parser + Haiku CLI extraction. CONCURRENCY=4. Cosine dedup. Consolidation with git-aware staleness. Injection feedback loop. Connection discovery. Trivial session skip. Type-based decay. Daily backup/stats/cleanup. |
| hooks/pre-compact.sh | **REWRITE** | DONE | Recovery buffer via db-write.js. Hard link snapshot. jq. |
| hooks/stop.sh | **REWRITE** | DONE | Duplicate ingestion prevention. Seen file cleanup. jq. |
| hooks/post-tool-use.sh | **NEW** | DONE | File-aware injection. session_id rate limit. Per-session cap of 3. injection_events tracking. |
| hooks/session-start-cold.sh | **REWRITE** | DONE | Worker-disabled check. One-line reminder. |
| hooks/session-start-compact.sh | **REWRITE** | DONE | Session-scoped recovery buffer. Topic-aware atoms. injection_events tracking. |
| hooks/user-prompt-submit.sh | **REWRITE** | DONE | 4 signal types. PascalCase 3+. FTS5 sanitization. injection_events tracking. |
| watchdog.sh | **UPDATE** | DONE | Node.js path resolution. PID recycling detection. Failure counter (5 = disable). |
| ~/.claude/CLAUDE.md | **UPDATE** | DONE | /primeDB, /saveDB, /reviewDB, /forgetDB + memory tool usage guidance. |
| data/memory.db | **MIGRATE** | DONE | New tables (threads, turns, embeddings, jobs, connections, injection_events, recovery_buffer, stats_daily). New columns on knowledge. Foreign keys. |
| test-search-quality.js | **NEW** | DONE | 13 search quality tests. |
| test-e2e.js | **NEW** | DONE | 27 end-to-end integration tests. |
| backfill.js | **NEW** | DONE | Phased backfill script with --limit, --project, --dry-run, --priority. |

### New Files

| File | Purpose |
|------|---------|
| .env | API keys: ANTHROPIC_API_KEY, OPENAI_API_KEY (chmod 600) |
| .node-path | Resolved Node.js binary path (for watchdog) |
| db-write.js | Parameterized SQL helper for hooks (avoids content escaping issues) |
| migrate.js | Schema migration script (creates new tables, cleans garbage, backs up first) |

---

## 19. Build Phases

> **NOTE:** The step-by-step execution order is defined in the EXECUTION PLAN at the top of this document. The phases below describe the logical grouping and detailed tasks. Use the Execution Plan for build order; use these phases for detailed task lists.

### Phase 1: Fix search + add vectors + update hooks (Week 1)

**Goal:** Replace keyword-only search with hybrid BM25+vector on existing knowledge atoms. Update all hooks.

1. `npm install sqlite-vec openai`
2. Create `.env` with OPENAI_API_KEY (chmod 600)
3. Store Node.js path in `.node-path` for watchdog
4. Install jq: `brew install jq`
5. Write `migrate.js`:
   - Backup: `sqlite3 data/memory.db ".backup data/memory-backup.db"`
   - Create knowledge_embeddings table (sqlite-vec, distance_metric=cosine)
   - Create recovery_buffer table
   - Create stats_daily table
   - Add columns to knowledge table: decay_rate, impasse_severity, last_injected_at, contradiction_note (NOTE: topic_hash, valid_at, invalid_at are CUT)
   - Backfill decay_rate on existing atoms based on TYPE_CONFIG
   - Drop concept_synonyms, knowledge_trigram tables
   - Delete garbage/duplicate atoms from knowledge table
   - Add PRAGMA foreign_keys = ON to init
6. Generate embeddings for all existing clean atoms
7. Update `server.js`:
   - Load sqlite-vec extension
   - Set PRAGMA foreign_keys = ON, busy_timeout = 5000
   - Replace hybridSearch() with BM25+vector+RRF (k=15, cosine distance)
   - Remove synonym expansion, trigram search
   - Add OpenAI embedding generation (synchronous) on save_knowledge
   - Add embedding LRU cache (20 entries)
   - Wrap FTS5+join queries in read transactions
   - Add memory_admin tool (includes stats actions: summary/stale/low_confidence/most_used/disk_usage)
8. Rewrite all hook scripts (jq, SQL injection fixes, PascalCase fix, recovery buffer, PostToolUse)
9. Update watchdog.sh (Node.js path resolution, PID check)
10. Add /primeDB and /saveDB instructions to CLAUDE.md files
11. Test: verify search quality with 10 real queries against existing atoms

**Deliverable:** Working hybrid search. All hooks updated. Slash commands ready. PostToolUse file-aware injection working.

### Phase 2: LLM extraction + thread storage (Week 2-3)

**Goal:** Replace regex extraction with Haiku LLM via tool_use. Add thread/turn storage. Add consolidation.

12. `npm install @anthropic-ai/sdk`
13. Add ANTHROPIC_API_KEY to `.env`
14. Update `migrate.js` to create threads, turns, turn_embeddings, turns_fts tables
15. Rewrite `worker.js`:
    - Startup: API key validation, recovery sweep for stuck jobs
    - JSONL parser with tool block stripping and malformed line handling
    - Turn pairing and thread storage (content-hash IDs, UNIQUE constraint)
    - OpenAI embedding generation for turns (with embed_pending fallback)
    - Haiku tool_use extraction (structured prompt with few-shot examples, max_tokens 4096, impasse detection)
    - Content-based key exchange matching (not turn numbers)
    - Cosine-based deduplication (distance < 0.08)
    - Set decay_rate per atom type from TYPE_CONFIG
    - Set impasse_severity (float 0.0-1.0) on atoms from impasse sessions
    - Set decay_rate from TYPE_CONFIG on all atoms (REQUIRED - prevents NaN in ACT-R)
    - Type-based TTL decay + archival
    - Consolidation engine (weekly/every 20 extractions) with contradiction storage (knowledge.contradiction_note) and 7-day temporal rule
    - Use status field for supersession (status='superseded'), not separate columns
    - Daily backup
    - Daily stats snapshot
    - Snapshot cleanup (7-day retention)
    - Poll loop: immediate re-poll on success, 10s sleep on idle
16. Update `server.js` recall_context:
    - Add resolution parameter (1/2/3) with fallbacks
    - Add expand parameter with 10,000 token soft cap
    - Add files parameter for file-aware search
    - Add since/until temporal filtering
    - Add project='*' cross-project search
    - Implement thread grouping (Math.log2, coefficient 0.15)
    - Implement multi-resolution formatting
    - Implement Resolution 2 fallback for missing key exchanges
    - Implement Resolution 1 truncation (keep end, trim beginning)
    - Priority tiebreaker at 5% threshold
17. Backfill existing sessions through new pipeline
    - Run as batch of background ingest_thread jobs
    - Estimated: ~25 minutes, ~$6 in API costs
    - Do this AFTER search is ready (unlike original plan which backfilled before search could use results)
18. Run first consolidation pass on existing atoms

**Deliverable:** Complete system working end-to-end. Thread retrieval at all resolutions. Consolidation running. Backfill complete. Impasse detection and temporal tracking active. Decay rates applied per type.

### Phase 3: ACT-R activation scoring - COMPLETED 2026-03-07

**Goal:** Enable usage-aware retrieval ranking once enough data exists.

19. DONE - ACT-R scoring in retrieval pipeline. Formula: `0.75 * rrf + 0.25 * sigmoid(activation)`. Auto-activates at 150+ atoms.
20. DONE - Impasse-context detection at query time. Regex scans query for struggle signals (crash/error/stuck/broken/etc). Sets contextFlag.
21. DONE - Full formula: `base_score = 0.75 * rrf + 0.25 * sigmoid(activation)`, then `final_score = base_score * (1.0 + 0.10 * impasse_severity * context_flag)`.
22. PENDING - Evaluate ACT-R quality vs raw RRF (needs real usage data over weeks).
23. PENDING - Tune weights (needs real usage data over weeks).

### Phase 4: Refinement + git-aware staleness - COMPLETED 2026-03-07

**Goal:** Add advanced features based on real usage feedback.

24. DONE - Git-aware staleness in consolidation. Extracts file refs from atom content, checks git log for changes >50 lines, lowers confidence by 0.15 and flags.
25. DONE - Connection discovery via KNN. `discover_connections` job queued after each ingestion. Computes average thread embedding, KNN search, stores connections with similarity >= 0.5.
26. DONE - Injection feedback loop. Hooks write injection_events. Worker checks during ingestion if injected atoms were referenced (30%+ key term overlap). +0.05 confidence if referenced, -0.03 per unreferenced event after 5+ events (floor 0.30).
27. PENDING - Evaluate search quality (needs 2-3 weeks of real data).
28. PENDING - Tune parameters (needs real usage data).
29. DONE - Non-stemmed FTS5 index (`knowledge_fts_exact` with `unicode61`). 3rd signal in RRF merge. Term-interaction re-ranker adds up to 20% boost based on unigram/bigram overlap.
30. NOT IMPLEMENTED - Topic segmentation for long threads. No 50+ turn threads exist yet.

### Phase 4b: Architectural Improvements - COMPLETED 2026-03-08

**Goal:** Reduce context overhead, prevent context window overflows, improve hook injection quality.

31. DONE - Transcript truncation. `formatTranscriptForExtraction` caps at 50K chars: keeps first 3 + last 5 turns, omits middle. Prevents Haiku context overflow on long sessions.
32. DONE - Tool consolidation (5 to 3). Merged `memory_feedback`, `memory_admin`, `ingest_new_sessions` into `memory_manage` with action enum. Saves ~40% of MCP tool definition context tokens.
33. DONE - Injection cache. New `injection_cache` table with pre-computed vector matches per project. Worker populates after each ingestion via `refreshInjectionCache()`. Hooks query cache-first with FTS fallback. Enables semantic matching in hooks without live API calls.

#### Automatic Injection Feedback Loop (Phase 4, item 26)

When PostToolUse or UserPromptSubmit hooks inject atoms into a session, the system currently has no way to know if that injection was helpful or noise. This creates a closed-loop learning opportunity that no open-source memory project has implemented.

**How it works:**

1. When a hook injects atoms, it also writes an `injection_event` to a new table:
   ```sql
   CREATE TABLE injection_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     atom_id INTEGER NOT NULL REFERENCES knowledge(id),
     session_file TEXT NOT NULL,
     trigger TEXT NOT NULL CHECK(trigger IN ('post_tool_use','user_prompt_submit','session_start_compact')),
     injected_at TEXT NOT NULL DEFAULT (datetime('now')),
     was_referenced INTEGER DEFAULT NULL  -- NULL=unknown, 1=yes, 0=no
   );
   ```

2. During ingestion (when the worker processes the session transcript), it checks: did Claude's subsequent responses reference concepts from the injected atoms? This is a lightweight check - search for key terms from the atom's content in the assistant messages that followed the injection point.

3. If referenced: set `was_referenced=1`, boost atom confidence by 0.05 (capped at 1.0).
4. If NOT referenced across 5+ injection events: lower atom confidence by 0.03 per unreferenced injection (floor at 0.30).

**Why this matters:** Over time, atoms that consistently get injected but ignored will naturally sink in confidence, while atoms that are consistently useful will rise. The system learns which memories are actually valuable in context, not just which ones match a search query.

**Why Phase 4:** Requires the ingestion pipeline (Phase 2) to be working first, since the feedback check happens during transcript processing. Also needs enough injection events to be statistically meaningful.

**Deliverable:** Refined system with usage-informed tuning. Injection feedback loop closing the gap between retrieval and actual usefulness.

---

## 20. What Was Cut and Why

| Cut | Why |
|-----|-----|
| Synonym table (1,102 pairs) | Vectors handle semantic similarity. Synonyms hurt FTS5 precision. |
| Trigram FTS5 table | Vectors handle fuzzy matching better. |
| Automatic contradiction detection in dedup | Impossible without NLI. Handled by periodic LLM consolidation instead. |
| Turn-number-based key exchange marking | LLMs miscount turn numbers on long transcripts. Content-matching is more reliable. |
| Free-form JSON from Haiku | tool_use structured output eliminates parsing failures. |
| python3 for JSON parsing in hooks | jq is 10x faster cold start (20ms vs 200ms). |
| Auto-injection on cold session start | Wastes tokens. /primeDB gives control. |
| decision_trails separate table | Decisions stored as knowledge atoms with metadata. |
| knowledge_sightings table | Never populated. Cross-project via search. |
| Feedback/retrieval event tracking (original tables) | Replaced by injection_events table in Phase 3. Simpler model: track whether hook-injected atoms were actually referenced by Claude, not generic retrieval events. |
| memory_report_outcome tool (standalone) | Merged into memory_feedback (outcomes array param). Outcome tracking unified with feedback. |
| Promotion system | Depends on knowledge_sightings. Removed with it. |
| Multi-type decay curves (original) | Replaced with simpler type-based TTLs + consolidation. |
| Connection discovery (Phase 1-2) | Deferred to Phase 3. Search finds related content at current scale. |
| File path as thread_id | Content hash is more stable across renames. |
| Async embedding in save_knowledge | Contradicts synchronous dedup requirement. 50-100ms is acceptable. |
| ~~Cross-encoder re-ranker~~ | **IMPLEMENTED** as lightweight term-interaction re-ranker (unigram + bigram overlap). Max 20% boost. No API latency. |
| sqlite-lembed for local embeddings | Alpha software. OpenAI API is better quality, negligible cost. |
| Unified scoring formula (all signals in one equation) | Deferred. RRF + ACT-R re-ranking is simpler and achieves 90% of the value. A unified formula would add generalization bonus, feedback modifier, etc. - premature without enough data to tune. |
| Self-rewriting CLAUDE.md | Recursive corruption risk. Memory system should inform Claude, not modify its own instruction files. |
| topic_hash column | Implementation undefined ("key noun phrases" never specified). Consolidation handles temporal grouping semantically. Add cosine-based pre-clustering when any type exceeds 50 atoms. |
| valid_at / invalid_at columns | Redundant with status field. `status = 'active'` serves the same purpose as `invalid_at IS NULL`. Simplifies all retrieval queries. |
| Binary impasse_severity | Changed to impasse_severity float (0.0-1.0). Binary flagged ~30-40% of sessions, destroying discriminative power. |
| Memory poisoning defense | Non-threat for single-user system. Only relevant if the system were multi-tenant. |
| Spreading activation (graph traversal) | Overkill below 5,000 atoms. KNN via sqlite-vec achieves similar results. |
| Session-start auto-injection (beyond recovery) | User decided /primeDB is the approach. Cold start = reminder only. Auto-injection wastes tokens on sessions that don't need memory. |
| Feedback/outcome tracking (per-retrieval) | Deferred. Injection feedback loop (Phase 4) is a better-scoped version. Per-retrieval tracking has no reliable signal (Claude doesn't report "this was useful"). |
| Procedural memory / CASS | Academic concept without clear implementation path. Knowledge atoms already capture "how to do X" as reasoning_chains. |

---

## 21. Parameters and Their Values

Every tunable parameter, its value, and why.

| Parameter | Value | Why | Revisit when |
|-----------|-------|-----|-------------|
| RRF k constant | 15 | Good discrimination at small corpus size. | If search ranking feels wrong after 2-3 weeks |
| Embedding dimensions | 1536 | OpenAI text-embedding-3-small output. | If switching provider |
| Embedding distance metric | cosine (via sqlite-vec) | Direct threshold comparisons, no conversion needed. | Stable |
| Dedup cosine distance threshold | < 0.20 (similarity > 0.80) | Raised from 0.08 to reduce 26% duplicate rate. Catches near-duplicates more aggressively. | If duplicates appear (raise) or distinct items merge (lower) |
| Thread score formula | best * (1 + 0.15 * Math.log2(matches)) | Math.log2 gives clear semantics (doubling = +15% boost). 0.15 coefficient prevents multi-match threads from overwhelming single high-quality matches. | If irrelevant threads rank high |
| Priority tiebreaker threshold | 5% | RRF scores are compressed (~0.06-0.13 range). 10% would fire on nearly every comparison. 5% is selective. | If priority seems to dominate or never applies |
| PostToolUse token budget | 500 | Max 2 atoms. Lightweight file-aware injection. | If important atoms are cut |
| UserPromptSubmit token budget | 500 | Max 2 atoms. Lightweight signal-gated injection. | If important atoms are cut |
| SessionStart/compact token budget | ~2000 | Recovery buffer (10 turns) + top 3 atoms. Post-compaction is highest-stakes injection - 200K context absorbs this easily. | If recovery bloats context or feels insufficient |
| recall_context token budget | 3,000 | ~5 key exchange results or ~30 atoms. | If results feel truncated |
| expand token soft cap | 10,000 | Prevents blowing up context window. | If users need fuller threads |
| Worker poll interval | 10,000ms (idle) | Balance responsiveness and CPU. Immediate re-poll when jobs pending. | If ingestion feels slow (lower to 5s) |
| Haiku max_tokens | 4,096 | Prevents truncation on rich sessions (original 2048 was too low). | Stable |
| Embedding batch size | 20 | Keeps memory reasonable. OpenAI allows up to 2048. | If ingestion is slow |
| Embedding LRU cache size | 20 queries | ~120KB memory. Prevents repeated API calls for same query. | If cache hit rate is low |
| Short message gate | 20 chars | "yes", "do it", "ok" are under 20. No useful signal possible. | If legitimate short messages need injection |
| PascalCase signal regex | `/[A-Z][a-z]+([A-Z][a-z]+){2,}/` | 3+ segments. Matches InboxCalendar but NOT TypeScript, JavaScript, LinkedIn, OAuth, GitHub, OpenAI. ~95% fewer false positives than 2-segment version. | If false positives persist or real components are missed |
| Problem language signal (Signal 4) | Detect problem word, use rest of message as query | Matches "the calendar is crashing" by detecting "crashing" and using "the calendar is" as FTS5 query. Much broader than old rigid 3-word pattern. | If false positives overwhelm results |
| Confidence: user_explicit | 0.95 | User explicitly said "remember this". | Stable |
| Confidence: model_initiated | 0.80 | Claude decided to save. | Stable |
| Confidence: llm_extracted | 0.75 | Haiku extracted from transcript. | If extraction quality proves higher/lower |
| Type TTL: preference/decision/arch | Never | Stable knowledge. Managed by consolidation. | Stable |
| Type TTL: pattern/reasoning_chain/anti_pattern | 180 days | Methods and anti-patterns stay relevant longer. | If patterns expire too fast/slow |
| Type TTL: debugging/fact/workaround | 90 days | Tied to specific code that changes. | After 6 months of usage |
| Type TTL: correction | Never (Infinity) | Corrections persist indefinitely - they represent user-confirmed fixes that remain relevant. Managed by consolidation. | Stable |
| Consolidation frequency | Weekly or every 20 extractions | Balances freshness and API cost (~$10.40/year at Haiku 4.5 pricing). | If knowledge rot is noticeable |
| Consolidation cost | ~$0.20 per run | Small atom set, Haiku 4.5 pricing. | If atom count grows significantly |
| Snapshot retention | 7 days | Enough time for failed ingestions to be retried. | If disk space is tight |
| Recovery buffer size | Last 10 turns (text-only) | Post-compaction is highest-stakes injection. 10 turns gives Claude enough context to continue the current task. 200K context absorbs ~2000 tokens easily. | If recovery bloats context |
| Stuck job timeout | 5 minutes | Any job in 'processing' longer than this is considered crashed. | If jobs legitimately take longer |
| API call cost per session | ~$0.06 (after pre-processing) | Haiku 4.5: ~10K input * $1/MTok + ~1K output * $5/MTok. | If Anthropic changes pricing |
| Annual cost (moderate use) | ~$100/year | 3 sessions/day + 1 compaction + weekly consolidation. | Track via stats_daily |
| Annual cost (heavy use) | ~$160/year | 5 sessions/day + 2 compactions. | Track via stats_daily |
| Backfill cost (400 sessions) | ~$24 | One-time cost. Phased: 10 -> 50 -> 340 with quality review. | N/A |
| SQLite busy timeout | 5,000ms | Handles concurrent writes between server and worker under WAL. | If SQLITE_BUSY errors persist |
| Daily backup | 1x/day via worker | sqlite3 .backup command. Overwrites previous backup. | Consider keeping 3 rotating backups |
| ACT-R decay rate: preference/decision/architecture | 0.15 | Very slow decay. These are stable knowledge accessed infrequently but critical when needed. Standard ACT-R uses 0.5 which would bury these. | If architecture atoms don't surface when needed (lower) or dominate when stale (raise) |
| ACT-R decay rate: pattern/reasoning_chain/anti_pattern | 0.30 | Standard ACT-R default. Moderate fade for methodological knowledge. | If patterns feel stale or too fresh |
| ACT-R decay rate: debugging/fact/workaround/tool_config | 0.40 | Faster fade. Tied to specific code that changes. | If debugging atoms linger too long (raise) or disappear too fast (lower) |
| ACT-R decay rate: correction | 0.20 | Slow decay matching preference/decision. Corrections are user-confirmed fixes that persist indefinitely (TTL = Infinity). | Stable |
| ACT-R scoring weight (in final_score) | 0.25 | RRF relevance (0.70) should dominate. ACT-R (0.25) breaks ties and boosts frequently-used atoms. | If usage patterns don't affect results enough (raise) or override relevance (lower) |
| RRF weight (in final_score) | 0.70 | Relevance must be the primary signal. | If RRF alone produces good enough results, consider raising to 0.80 |
| Impasse boost | 10% multiplicative | `base_score * (1 + 0.10 * severity * context_flag)`. Severity is 0.0-1.0 float. A severity-1.0 atom during struggle gets full 10% boost. Severity-0.3 gets 3%. | If impasse atoms don't surface during struggles (raise multiplier) |
| ACT-R activation threshold | 150 atoms | Below this count, activation scores have too little variance to provide meaningful discrimination. Use raw RRF until threshold is reached. | If earlier activation helps (lower) |
| Impasse signal keywords | "error", "failed", "not working", "tried X but", "still", "bug", "crash", "broken" | Used to detect impasse context in the current query for contextual boost. | Add more if false negatives, remove if false positives |

---

## Testing Strategy

Before declaring any phase complete, run these validation checks:

### Search Quality Tests (10 queries)

Create a file `test-queries.json` with 10 queries and expected results:
1. An exact project name query should return project-specific atoms
2. A semantic query ("how did we handle rate limiting") should find related atoms even without keyword overlap
3. A file name query ("InboxCalendar") should find debugging atoms for that component
4. A cross-project query (project='*') should return atoms from multiple projects
5. An exact identifier query (`"useInfiniteQuery"` in quotes) should find that specific term
6. A temporal query (since last week) should only return recent results
7. A resolution=1 query should return full thread content
8. A resolution=2 query should return key exchanges (or fallback if none exist)
9. An expand query should return a specific thread with truncation note if over cap
10. A query with no results should return empty gracefully

### Extraction Quality Spot-Check

After Phase 2, manually review 5 randomly selected extractions:
- Did Haiku extract the right number of items (not too many, not too few)?
- Are decision atoms including reasoning?
- Are reasoning_chain atoms capturing the METHOD, not just the answer?
- Are key exchanges marked on the correct turns?
- Are thread priorities reasonable?

### Operational Health Checks

- `memory_admin(action='summary')` returns sensible numbers
- `memory_admin(action='disk_usage')` shows reasonable growth
- `memory_admin(action='recent_extractions')` shows recent activity
- Worker.log has no repeated errors
- Backup file exists and is recent

---

## 22. Hook Input JSON Schemas

Each hook receives JSON on stdin from Claude Code. These schemas are reverse-engineered from the jq filters in the hook scripts and Claude Code's documented hook behavior.

### PreCompact Hook Input

```json
{
  "transcript_path": "/Users/you/.claude/projects/.../session.jsonl",
  "cwd": "/Users/you/projects/my-project"
}
```

| Field | Type | Description |
|-------|------|-------------|
| transcript_path | string | Absolute path to the session JSONL transcript file |
| cwd | string | Working directory of the Claude Code session |

### Stop Hook Input

```json
{
  "transcript_path": "/Users/you/.claude/projects/.../session.jsonl",
  "cwd": "/Users/you/projects/my-project"
}
```

Same schema as PreCompact.

### PostToolUse Hook Input

```json
{
  "tool_name": "Read",
  "tool_input": {
    "file_path": "/Users/you/projects/my-project/src/components/InboxCalendar.tsx"
  },
  "session_id": "abc123"
}
```

| Field | Type | Description |
|-------|------|-------------|
| tool_name | string | Name of the tool that was called (Read, Edit, Write, Bash, Grep, etc.) |
| tool_input | object | The input parameters passed to the tool |
| tool_input.file_path | string | (For file tools) Absolute path to the file operated on |
| session_id | string | Session identifier (available but not currently used) |

### UserPromptSubmit Hook Input

```json
{
  "user_prompt": "Fix the calendar bug in InboxCalendar.tsx",
  "cwd": "/Users/you/projects/my-project"
}
```

| Field | Type | Description |
|-------|------|-------------|
| user_prompt | string | The user's message text |
| cwd | string | Working directory |

### SessionStart Hook Input (both compact and cold)

```json
{
  "cwd": "/Users/you/projects/my-project",
  "session_type": "compact"
}
```

| Field | Type | Description |
|-------|------|-------------|
| cwd | string | Working directory |
| session_type | string | "compact" (after compaction) or "startup" (cold start) |

Note: The `matcher` field in settings.json determines which SessionStart hook runs. The hook itself receives the session context.

---

## 23. JSONL Transcript Format

Claude Code session transcripts are stored as JSONL files (one JSON object per line). The worker parses these during ingestion. Here is a realistic 4-line example:

```jsonl
{"type":"user","message":{"content":"Fix the calendar showing wrong dates for all-day events"},"timestamp":"2026-03-06T09:15:22Z"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Let me check the InboxCalendar component to see how dates are handled."},{"type":"tool_use","id":"toolu_01abc","name":"Read","input":{"file_path":"/Users/you/src/components/InboxCalendar.tsx"}}]},"timestamp":"2026-03-06T09:15:25Z"}
{"type":"tool_result","tool_use_id":"toolu_01abc","content":"import React from 'react';\nimport { format } from 'date-fns';\n// ... (file contents)","timestamp":"2026-03-06T09:15:26Z"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Found the issue. Unipile returns null timestamps for all-day events, but the component assumes non-null. Adding defensive null checks."},{"type":"tool_use","id":"toolu_01def","name":"Edit","input":{"file_path":"/Users/you/src/components/InboxCalendar.tsx","old_string":"event.start","new_string":"event.start ?? event.date"}}]},"timestamp":"2026-03-06T09:15:30Z"}
```

**Pre-processing rules (applied before Haiku extraction):**
- `type: "user"` - keep `message.content` (string or array of text blocks)
- `type: "assistant"` - keep only `content` blocks where `type: "text"`, strip all `type: "tool_use"` blocks
- `type: "tool_result"` - strip entirely
- After pre-processing, the 4 lines above become 2 turns:
  - Turn 1: user="Fix the calendar..." / assistant="Let me check the InboxCalendar component..."
  - Turn 2: user=(none, partial turn) / assistant="Found the issue. Unipile returns null timestamps..."

---

## 24. sqlite-vec Loading

sqlite-vec is a C extension for SQLite that must be loaded explicitly in both server.js and worker.js. The `better-sqlite3` library supports loading extensions via `db.loadExtension()`.

### Installation

sqlite-vec is installed via npm as `sqlite-vec`. The npm package bundles the precompiled native extension for the current platform.

### Loading Code (used in both server.js and worker.js)

```javascript
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

function openDatabase(dbPath) {
  const db = new Database(dbPath, { timeout: 5000 });

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Set pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return db;
}
```

**Notes:**
- `sqliteVec.load(db)` handles finding and loading the correct native binary for the platform.
- This must be called BEFORE any queries that reference vec0 virtual tables.
- If the extension fails to load (missing binary, architecture mismatch), it throws immediately. The server/worker should catch this and exit with a clear error message.
- Both server.js and worker.js must load the extension independently since they are separate processes with separate database connections.

---

## 25. Setup and Installation

### Prerequisites

- **Node.js** >= 18 (check with `node --version`)
- **jq** - install via `brew install jq` (required by all hook scripts)
- **API keys:**
  - Anthropic API key (for Haiku extraction and consolidation)
  - OpenAI API key (for text-embedding-3-small embeddings)
- **Claude Code** installed and functional

### Installation Steps

```bash
# 1. Navigate to the memory server directory
cd ~/.claude/memory-server

# 2. Install dependencies
npm install better-sqlite3 @modelcontextprotocol/sdk sqlite-vec openai @anthropic-ai/sdk

# 3. Create .env file with API keys
cat > .env << 'EOF'
ANTHROPIC_API_KEY=sk-ant-your-key-here
OPENAI_API_KEY=sk-your-key-here
EOF
chmod 600 .env

# 4. Store the Node.js path for the watchdog
which node > .node-path

# 5. Run database migration
node migrate.js
# This will: backup existing db, create new tables, clean garbage atoms,
# generate embeddings for existing clean atoms

# 6. Make hook scripts executable
chmod +x hooks/*.sh
chmod +x watchdog.sh

# 7. Install the launchd watchdog (see Section 26 for plist content)
cp com.claude.memory-watchdog.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.claude.memory-watchdog.plist

# 8. Verify jq is available
command -v jq >/dev/null 2>&1 || { echo "jq is required. Install with: brew install jq"; exit 1; }

# 9. Start the worker manually for initial testing
node worker.js
```

### Verify settings.json

Ensure `~/.claude/settings.json` contains the hook registrations from Section 13. The key sections:
- `PreCompact` pointing to `hooks/pre-compact.sh` (timeout 2000)
- `Stop` pointing to `hooks/stop.sh` (timeout 2000)
- `PostToolUse` pointing to `hooks/post-tool-use.sh` (timeout 500)
- `SessionStart` with two entries: `compact` matcher and `startup` matcher
- `UserPromptSubmit` pointing to `hooks/user-prompt-submit.sh` (timeout 500)

### Verify MCP Server Registration

The memory MCP server must be registered in Claude Code's MCP configuration. Add to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["~/.claude/memory-server/server.js"]
    }
  }
}
```

### Post-Installation Verification

```bash
# Check worker is running
cat ~/.claude/memory-server/worker.pid && kill -0 $(cat ~/.claude/memory-server/worker.pid) && echo "Worker is alive"

# Check database has new tables
sqlite3 ~/.claude/memory-server/data/memory.db ".tables"
# Should show: threads, turns, turn_embeddings, turns_fts, knowledge_embeddings, recovery_buffer, etc.

# Check hook scripts are executable
ls -la ~/.claude/memory-server/hooks/
```

---

## 26. Launchd Plist - Watchdog

The watchdog runs every 5 minutes via macOS launchd to ensure the worker process stays alive.

**File:** `~/Library/LaunchAgents/com.claude.memory-watchdog.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.memory-watchdog</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>watchdog.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/v3velev/.claude/memory-server</string>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/Users/v3velev/.claude/memory-server/logs/watchdog-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/v3velev/.claude/memory-server/logs/watchdog-stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/v3velev</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
```

**Notes:**
- `StartInterval` of 300 = every 5 minutes.
- `RunAtLoad` ensures the watchdog runs immediately when loaded (e.g., after login).
- `EnvironmentVariables` sets `HOME` explicitly because launchd does not inherit shell environment variables. The watchdog script uses `$HOME` to locate the memory server directory.
- `PATH` includes `/opt/homebrew/bin` for Homebrew on Apple Silicon and `/usr/local/bin` for Intel Macs.
- The watchdog itself resolves the Node.js path from `.node-path` (not from PATH) to handle nvm/fnm/asdf installations.
- API keys are NOT set in the plist. The worker reads them from `.env` at startup, which is more secure and easier to update.
- `WorkingDirectory` is set so `watchdog.sh` can be referenced without an absolute path.
- Replace `/Users/v3velev` with the actual home directory if deploying on a different machine.

### Launchd Management Commands

```bash
# Load (start the watchdog)
launchctl load ~/Library/LaunchAgents/com.claude.memory-watchdog.plist

# Unload (stop the watchdog)
launchctl unload ~/Library/LaunchAgents/com.claude.memory-watchdog.plist

# Check if running
launchctl list | grep claude.memory

# Force run immediately (for testing)
launchctl start com.claude.memory-watchdog
```

---

*This document is the single source of truth for the memory system rebuild. It incorporates all architectural fixes, operational safety improvements, and design insights from comparative analysis with open source memory systems (memory-mcp, claude-mem, mcp-memory-service, hmem, Engram, ALMA-memory, Mem0, Letta/MemGPT, Zep/Graphiti, SimpleMem, Kore, and others). Key additions from the March 2026 landscape review: anti-pattern extraction (inspired by ALMA-memory), progressive disclosure in /primeDB (inspired by hmem's hierarchical loading), and automatic injection feedback loop (novel - no open-source project has closed this loop). Additions from the March 2026 deep research phase: ACT-R activation scoring with type-aware decay rates (cognitive science-backed retrieval ranking), impasse detection (boosting hard-won solutions when facing similar struggles), and temporal knowledge tracking (preventing stale knowledge from poisoning retrieval). See RESEARCH-FINDINGS.md for the full multi-agent analysis. The original ARCHITECTURE.md contains the research and vision. This SYSTEM.md contains what we're actually building.*

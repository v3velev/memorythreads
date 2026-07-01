# MemoryThreads

[![CI](https://github.com/v3velev/memorythreads/actions/workflows/ci.yml/badge.svg)](https://github.com/v3velev/memorythreads/actions/workflows/ci.yml)

**Persistent, searchable conversation memory shared across Claude Code and Codex.**

MemoryThreads is a local MCP server that auto-captures every conversation turn from both Claude Code and OpenAI Codex into one SQLite database, then makes that history instantly searchable from any future session - hybrid BM25 (FTS5) + vector (sqlite-vec) recall, with cross-platform thread continuity. Start work in Claude Code, continue it in Codex, and either side can recall the full shared history.

No cloud, no account - everything lives in `~/.claude/memory-server/` on your machine.

---

## Install (one command)

**Prerequisites:** Node.js 18.18+, and an OpenAI API key (used only for local embeddings).

```bash
git clone https://github.com/v3velev/memorythreads ~/.claude/memory-server
cd ~/.claude/memory-server && ./install.sh
```

The installer prompts for your OpenAI key (or reads `OPENAI_API_KEY` from your env), then does everything:

- installs npm dependencies and writes `.env`
- registers the `memory` MCP server for **Claude Code** (`claude mcp add`) and **Codex** (`~/.codex/config.toml`)
- installs the capture/recall **hooks** into `~/.claude/settings.json` and `~/.codex/hooks.json`
- installs the `/mt-*` **slash commands**
- adds the **Memory block to your `~/.claude/CLAUDE.md`** (and `~/.codex/AGENTS.md`) so your agent uses recall automatically
- starts the **background worker** (launchd on macOS) that parses + embeds transcripts

It is idempotent - safe to re-run. After it finishes, restart Claude Code / Codex.

### Install with your AI agent

You can also just hand the repo to your own Claude Code and let it install itself. Paste this:

> Install the MemoryThreads memory server from https://github.com/v3velev/memorythreads - clone it to `~/.claude/memory-server`, run `./install.sh`, and give it my OpenAI API key when it asks. Then restart so the MCP server and hooks load.

### What gets added to your CLAUDE.md

The installer inserts this block (between `<!-- memorythreads:start/end -->` markers, so re-running never duplicates it):

```markdown
## Memory (MemoryThreads)
- Conversation turns are auto-saved to SQLite and searchable across all past sessions (both Claude Code and Codex).
- Before guessing or asking the user about an unfamiliar term, file, project, or past decision, call `recall_context(query, include_threads=true)` first.
- `search_docs(query)` searches ingested reference docs.
- Bookmark the current session with `/mt-save <name>`; list and resume bookmarks with `mt launch`.
```

Full manual steps and Linux notes are in [SETUP.md](SETUP.md).

---

## Why

LLM coding sessions are stateless - close the terminal and the context is gone. MemoryThreads fixes that:

- **Never re-explain.** `recall_context("that auth bug from last week")` pulls the actual prior turns.
- **Cross-tool.** Claude Code and Codex write into and read from the same memory, so switching tools never loses the thread.
- **Automatic.** Hooks capture turns on every session; you don't manage it.
- **Fast + private.** Local SQLite, FTS5 + sqlite-vec. Your conversations never leave your machine.

---

## How it works

```
  Claude Code  ─┐                            ┌─ recall_context / search_docs
                ├─ hooks ─► jobs queue ─► worker.js ─► SQLite ◄─┤  (MCP tools)
  Codex        ─┘   (capture)             (parse + embed)        └─ mt launch (resume)
```

1. **Capture.** Session hooks (Stop, PreCompact, UserPromptSubmit) queue each session's transcript for ingestion. A launchd file-watcher (`incremental-sync.js`) also ingests Claude Code turns continuously.
2. **Parse + embed.** `worker.js` parses transcripts (dual-format: Claude Code JSONL and Codex rollout JSONL via `transcript-parser.js`), stores turns + threads, and embeds each turn (OpenAI `text-embedding-3-small`, 1536-dim) into a sqlite-vec table.
3. **Recall.** The MCP server (`server.js`) exposes `recall_context`, which runs hybrid BM25 + cosine search over turns/threads and returns the matches to the model.
4. **Continuity.** A `canonical_thread_id` links a Claude Code stream and a Codex stream into one logical MemoryThread, so continuation works across both tools without sharing native session files.

---

## MCP tools

| Tool | Purpose |
|---|---|
| `recall_context(query, resolution=0, include_threads)` | Hybrid BM25 + vector search. `resolution` 0 = raw turns (default), 1 = full threads, 2 = thread key-exchanges. |
| `search_docs(query)` | FTS5 search over ingested reference docs. |
| `ingest_doc(source, tags?, title?)` | Add a reference doc (URL, llms.txt, or local file). |
| `list_docs` / `delete_doc` | Manage ingested docs. |
| `save_thread(name, ...)` | Bookmark the current session as a named MemoryThread. |
| `list_threads` / `activate_thread` / `delete_thread` | Manage and resume bookmarks. |

### Slash commands & CLI

- `/mt-save <name>`, `/mt-list`, `/mt-delete <name>`, `/mt-doc-ingest <source>`
- `mt launch` - interactive picker to resume a saved thread (`mt launch tmux` for a tmux session)
- `mt browse` - TUI to browse/filter all threads
- `mt status` - DB stats, worker status, recent activity
- `mt doctor` - full health check (worker, job backlog, embeddings, hooks + MCP wiring). Run this if memory seems stale - it surfaces silent failures. The session-start hook also warns automatically if the ingest backlog gets stuck.

---

## Data model

One SQLite DB (`data/memory.db`). Core tables: `threads`, `turns`, `turns_fts` (FTS5), `turn_embeddings` (sqlite-vec), plus `saved_threads`, `active_memory_threads`, `docs`, `tool_uses`, `summaries`, `recovery_buffer`, and the worker `jobs` queue. Full DDL in [SCHEMA.md](SCHEMA.md).

Recall operates directly over conversation turns and threads - there is no extracted-knowledge layer.

---

## Setup

See [SETUP.md](SETUP.md) for the full guide. In short:

1. `npm install`
2. Put `OPENAI_API_KEY=...` in `.env` (gitignored).
3. Register the MCP server: `claude mcp add --scope user memory node ~/.claude/memory-server/server.js` (and the `[mcp_servers.memory]` block in `~/.codex/config.toml` for Codex).
4. Add the hooks block to `~/.claude/settings.json` and `~/.codex/hooks.json`.
5. Start the worker via the launchd watchdog.

## Hooks

| Event | Script | Role |
|---|---|---|
| `SessionStart` | `session-start-cold.sh` / `session-start-compact.sh` | Status line; compaction recovery |
| `UserPromptSubmit` | `user-prompt-submit.cjs` | Inject relevant prior turns + active-thread context |
| `PreCompact` | `pre-compact.sh` | Snapshot recent turns to `recovery_buffer` before compaction |
| `Stop` | `stop.cjs` | Queue the session transcript for ingestion |

The same hook scripts serve both Claude Code (`settings.json`) and Codex (`hooks.json`).

---

## Tech stack

Node.js (ES modules) · better-sqlite3 · sqlite-vec · OpenAI embeddings · `@modelcontextprotocol/sdk` · SQLite FTS5.

## Privacy

All data is local. `.env` (your API key) and `data/` (the DB) are gitignored and never committed.

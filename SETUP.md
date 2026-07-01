# Memory Server - Setup Guide

This guide is designed to be followed by Claude Code itself. Hand it to a session and provide your OpenAI API key when prompted.

## Prerequisites

| Requirement | Check |
|---|---|
| Node.js v18+ | `node --version` |
| Claude Code CLI | `claude --version` |
| macOS (for watchdog) | Linux works but needs systemd instead of launchd |
| jq | `jq --version` |
| sqlite3 | `sqlite3 --version` |
| OpenAI API key | For embeddings (text-embedding-3-small) |

## 1. Clone & Install

```bash
git clone <repo-url> ~/.claude/memory-server
```

```bash
cd ~/.claude/memory-server
```

```bash
npm install
```

Verify: `ls node_modules/.package-lock.json` should exist.

## 2. Environment Setup

Create the `.env` file with your OpenAI API key:

```bash
echo "OPENAI_API_KEY=<your-key-here>" > ~/.claude/memory-server/.env
```

If your `claude` CLI is NOT at `~/.local/bin/claude`, also add the path to `.env`:

```bash
echo "CLAUDE_CLI_PATH=$(which claude)" >> ~/.claude/memory-server/.env
```

Lock down permissions:

```bash
chmod 600 ~/.claude/memory-server/.env
```

No Anthropic API key needed. The worker uses the `claude` CLI directly (your existing Claude Code auth).

Verify: `cat ~/.claude/memory-server/.env` shows your key. Run `which claude` and confirm it matches `~/.local/bin/claude` or that you set `CLAUDE_CLI_PATH`.

## 3. Database Initialization

Create the required directories:

```bash
mkdir -p ~/.claude/memory-server/{data,logs,snapshots,seen}
```

There are no manual migrations to run. The database and its full schema are created automatically by `ensureCanonicalSchema()` (in `memory-schema.js`) the first time the server or worker starts. `install.sh` does the directory creation for you.

Verify (after the worker/server has started once): `sqlite3 ~/.claude/memory-server/data/memory.db ".tables"` should list the core tables - `threads`, `turns`, `turns_fts`, `turn_embeddings`, `docs`, `saved_threads`, `active_memory_threads`, `tool_uses`, `summaries`, `recovery_buffer`, `jobs`.

## 4. Register MCP Server

```bash
claude mcp add --scope user memory node ~/.claude/memory-server/server.js
```

This makes the MemoryThreads MCP tools available in all sessions: `recall_context`, `search_docs`, `ingest_doc`, `list_docs`, `delete_doc`, and the thread bookmark tools (`save_thread`, `list_threads`, `activate_thread`, `delete_thread`).

Verify: `claude mcp get memory` returns the server config.

## 5. Configure Hooks

Merge the following `hooks` block into `~/.claude/settings.json`. If the file already has other keys, preserve them - only add/replace the `hooks` key.

```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/memory-server/hooks/pre-compact.sh",
            "timeout": 2000
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/memory-server/hooks/stop.sh",
            "timeout": 2000
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/memory-server/hooks/session-start-compact.sh",
            "timeout": 1000
          }
        ]
      },
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/memory-server/hooks/session-start-cold.sh",
            "timeout": 1000
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/memory-server/hooks/user-prompt-submit.sh",
            "timeout": 500
          }
        ]
      }
    ]
  }
}
```

Make hooks executable and cache the node path:

```bash
chmod +x ~/.claude/memory-server/hooks/*.sh
```

```bash
which node > ~/.claude/memory-server/.node-path
```

Verify: `cat ~/.claude/settings.json | jq '.hooks | keys'` should list all 4 hook types.

## 6. Watchdog (macOS - launchd)

```bash
mkdir -p ~/Library/LaunchAgents
```

Create `~/Library/LaunchAgents/com.claude.memory-watchdog.plist` with the content below. Replace `HOMEDIR` with your actual home directory path (run `echo $HOME` to get it). launchd does not expand `$HOME` or `~`.

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
        <string>HOMEDIR/.claude/memory-server/watchdog.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>HOMEDIR/.claude/memory-server/logs/watchdog-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>HOMEDIR/.claude/memory-server/logs/watchdog-stderr.log</string>
</dict>
</plist>
```

Load the watchdog:

```bash
launchctl load ~/Library/LaunchAgents/com.claude.memory-watchdog.plist
```

The watchdog runs every 5 minutes and starts the worker on its first run (also runs immediately at load due to `RunAtLoad`). Wait ~10 seconds after loading, then verify:

```bash
cat ~/.claude/memory-server/worker.pid && ps -p $(cat ~/.claude/memory-server/worker.pid)
```

If no PID file yet, check the log:

```bash
cat ~/.claude/memory-server/logs/watchdog-stdout.log
```

**Linux alternative:** Use a systemd user service or cron job that runs `~/.claude/memory-server/watchdog.sh` every 5 minutes.

## 7. Incremental Sync (File-System Watcher)

The incremental sync script watches `~/.claude/projects/` for JSONL file changes and inserts new turns into the database in near-real-time. This means open sessions are searchable from other sessions without waiting for compaction or session end.

Create `~/Library/LaunchAgents/com.claude.memory-sync.plist` with the content below. Replace `HOMEDIR` with your actual home directory path and `NODEPATH` with the output of `which node`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.memory-sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>NODEPATH</string>
        <string>HOMEDIR/.claude/memory-server/incremental-sync.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>HOMEDIR/.claude/memory-server</string>
    <key>WatchPaths</key>
    <array>
        <string>HOMEDIR/.claude/projects</string>
    </array>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>HOMEDIR/.claude/memory-server/logs/sync-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>HOMEDIR/.claude/memory-server/logs/sync-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
```

Load the sync agent:

```bash
launchctl load ~/Library/LaunchAgents/com.claude.memory-sync.plist
```

Verify: `launchctl list | grep claude` should show both `com.claude.memory-sync` and `com.claude.memory-watchdog`.

**How it works:**
- launchd `WatchPaths` triggers `incremental-sync.js` whenever any file changes under `~/.claude/projects/`
- 30-second throttle prevents rapid re-firing
- Tracks sync state in `data/sync-state.json` (file path -> last mtime + turn count)
- Only processes new turns since last sync (incremental, not full re-parse)
- Inserts turns with `embed_status='pending'` - the worker generates embeddings asynchronously
- FTS entries auto-populated by existing `turns_fts_ai` trigger
- Dedup: `INSERT OR IGNORE` with `UNIQUE(thread_id, turn_number)` prevents duplicates when pre-compact.sh or stop.sh later ingests the same session

**Linux alternative:** Use a systemd path unit watching `~/.claude/projects` that triggers the sync script.

## 8. Global CLAUDE.md Setup

Add a memory block to `~/.claude/CLAUDE.md` (and `~/.codex/AGENTS.md` for Codex) so memory is used in all sessions:

```markdown
## Memory (MemoryThreads)
- Conversation turns are auto-saved to SQLite and searchable across all past sessions (both Claude Code and Codex).
- Before guessing or asking the user about an unfamiliar term, file, project, or past decision, call `recall_context(query, include_threads=true)` first.
- `search_docs(query)` searches ingested reference docs.
- Bookmark the current session with `/mt-save <name>`; list and resume bookmarks with `mt launch`.
```

## 9. Verification Checklist

Run each of these to confirm everything works:

- [ ] `sqlite3 ~/.claude/memory-server/data/memory.db ".tables"` - shows tables
- [ ] `claude mcp get memory` - returns server config
- [ ] `cat ~/.claude/memory-server/worker.pid && ps -p $(cat ~/.claude/memory-server/worker.pid)` - worker running
- [ ] `launchctl list | grep claude` - shows both `memory-watchdog` and `memory-sync`
- [ ] Start a new Claude Code session - you should see a memory status message on startup
- [ ] Send a short message (e.g., "hi") - you should see the static memory reminder
- [ ] Ask Claude to run `recall_context` - the MCP tool should respond
- [ ] Run `recall_context(query="test", resolution=0)` - should return raw individual turns
- [ ] Check `data/sync-state.json` exists after first sync run

## Troubleshooting

| Problem | Fix |
|---|---|
| Worker won't start | Check `logs/worker.log` and `.node-path` |
| Worker disabled after crashes | `rm .worker-disabled .watchdog-failures` |
| Hooks not firing | Check `~/.claude/settings.json` structure, run `chmod +x hooks/*.sh` |
| No embeddings generated | Check `.env` has correct `OPENAI_API_KEY` |
| MCP tools not available | `claude mcp add --scope user memory node ~/.claude/memory-server/server.js` |
| Worker crashes: "Claude CLI not found" | Set `CLAUDE_CLI_PATH=$(which claude)` in `.env` |
| launchd not starting watchdog | Check paths in plist are absolute (no `$HOME`), run `launchctl list | grep memory` |
| Incremental sync not running | Check `logs/sync.log` and `logs/sync-stderr.log`. Verify plist loaded: `launchctl list | grep sync` |
| Sync finds 0 new turns | Check `data/sync-state.json` - if mtimes are current, files haven't changed since last sync |
| Schema looks wrong on a fresh DB | The live schema is created by `ensureCanonicalSchema()` in `memory-schema.js` (not the manual `migrations/` scripts, which are historical and not auto-run) |

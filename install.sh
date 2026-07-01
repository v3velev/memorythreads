#!/usr/bin/env bash
# MemoryThreads installer - sets up the whole system on a fresh machine.
# Idempotent: safe to re-run. Works for Claude Code and Codex.
#
# Usage:
#   git clone https://github.com/v3velev/memorythreads ~/.claude/memory-server
#   cd ~/.claude/memory-server && ./install.sh
#
# The OpenAI API key (for embeddings) can be supplied 3 ways:
#   - already in ./.env as OPENAI_API_KEY=...
#   - exported: OPENAI_API_KEY=sk-... ./install.sh
#   - interactively (the script prompts if it can't find one)

set -euo pipefail

TARGET="$HOME/.claude/memory-server"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. Location check ────────────────────────────────────────────────────────
# Hooks and configs reference $HOME/.claude/memory-server by absolute path, so
# the repo must live there.
if [ "$SCRIPT_DIR" != "$TARGET" ]; then
  die "This repo must be installed at: $TARGET
   You are running from: $SCRIPT_DIR
   Fix: move/clone it there, e.g.
     git clone https://github.com/v3velev/memorythreads \"$TARGET\"
     cd \"$TARGET\" && ./install.sh"
fi
cd "$TARGET"

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
say "Checking prerequisites"
command -v node >/dev/null || die "node not found (need Node.js 18.18+)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18.18+ required (found $(node -v))"
command -v npm >/dev/null || die "npm not found"
command -v sqlite3 >/dev/null || warn "sqlite3 CLI not found (optional, used for manual inspection)"
NODE_BIN="$(command -v node)"
ok "node $(node -v) at $NODE_BIN"
HAS_CLAUDE=0; command -v claude >/dev/null && HAS_CLAUDE=1
HAS_CODEX=0;  { command -v codex >/dev/null || [ -d "$HOME/.codex" ]; } && HAS_CODEX=1
[ "$HAS_CLAUDE" = 1 ] && ok "Claude Code detected" || warn "Claude Code CLI not found - will still write settings, but 'claude mcp add' is skipped"
[ "$HAS_CODEX" = 1 ] && ok "Codex detected" || warn "Codex not detected - skipping Codex wiring"

# ── 2. Dependencies ──────────────────────────────────────────────────────────
say "Installing npm dependencies"
npm install --silent --no-audit --no-fund
mkdir -p data logs
echo "$NODE_BIN" > .node-path
ok "dependencies installed"

# ── 3. .env / OpenAI key ─────────────────────────────────────────────────────
say "Configuring .env (OpenAI key for embeddings)"
touch .env; chmod 600 .env
if ! grep -q "^OPENAI_API_KEY=" .env 2>/dev/null; then
  KEY="${OPENAI_API_KEY:-}"
  if [ -z "$KEY" ] && [ -t 0 ]; then
    printf "  Enter your OpenAI API key (input hidden): "
    read -rs KEY; echo
  fi
  if [ -n "$KEY" ]; then
    printf 'OPENAI_API_KEY=%s\n' "$KEY" >> .env
    ok "OpenAI key written to .env"
  else
    warn "No key provided. Add it later: echo 'OPENAI_API_KEY=sk-...' >> $TARGET/.env"
  fi
else
  ok ".env already has OPENAI_API_KEY (left unchanged)"
fi

# ── 4. Register MCP server ───────────────────────────────────────────────────
say "Registering MCP server"
if [ "$HAS_CLAUDE" = 1 ]; then
  claude mcp remove memory --scope user >/dev/null 2>&1 || true
  claude mcp add --scope user memory "$NODE_BIN" "$TARGET/server.js" >/dev/null 2>&1 \
    && ok "Claude Code: memory MCP registered" \
    || warn "Claude Code: 'claude mcp add' failed - add manually (see SETUP.md)"
fi
if [ "$HAS_CODEX" = 1 ]; then
  CODEX_CFG="$HOME/.codex/config.toml"; mkdir -p "$HOME/.codex"; touch "$CODEX_CFG"
  if ! grep -q "^\[mcp_servers.memory\]" "$CODEX_CFG" 2>/dev/null; then
    printf '\n[mcp_servers.memory]\ncommand = "%s"\nargs = ["%s/server.js"]\n' "$NODE_BIN" "$TARGET" >> "$CODEX_CFG"
    ok "Codex: [mcp_servers.memory] added to config.toml"
  else
    ok "Codex: [mcp_servers.memory] already present"
  fi
fi

# ── 5. Hooks (merge into settings, idempotent, via node) ─────────────────────
say "Installing hooks"
CLAUDE_HOOKS_JSON='{"PreCompact":[{"hooks":[{"type":"command","command":"$HOME/.claude/memory-server/hooks/pre-compact.sh","timeout":2000}]}],"Stop":[{"hooks":[{"type":"command","command":"$HOME/.claude/memory-server/hooks/stop.sh","timeout":2000}]}],"SessionStart":[{"matcher":"compact","hooks":[{"type":"command","command":"$HOME/.claude/memory-server/hooks/session-start-compact.sh","timeout":1000}]},{"matcher":"startup","hooks":[{"type":"command","command":"$HOME/.claude/memory-server/hooks/session-start-cold.sh","timeout":1000}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"$HOME/.claude/memory-server/hooks/user-prompt-submit.sh","timeout":500}]}]}'
merge_hooks() {  # $1 = target json file, $2 = hooks object json
  local file="$1" hooks="$2"
  mkdir -p "$(dirname "$file")"; [ -f "$file" ] || echo '{}' > "$file"
  HOOKS_JSON="$hooks" node -e '
    const fs=require("fs"); const f=process.argv[1];
    const cfg=JSON.parse(fs.readFileSync(f,"utf8")||"{}");
    cfg.hooks=Object.assign({}, cfg.hooks, JSON.parse(process.env.HOOKS_JSON));
    fs.writeFileSync(f, JSON.stringify(cfg,null,2));
  ' "$file"
}
chmod +x hooks/*.sh 2>/dev/null || true
merge_hooks "$HOME/.claude/settings.json" "$CLAUDE_HOOKS_JSON" && ok "Claude Code hooks -> settings.json"
if [ "$HAS_CODEX" = 1 ]; then
  # Codex uses the same hook set (its Stop hook captures Codex rollouts).
  merge_hooks "$HOME/.codex/hooks.json" "$CLAUDE_HOOKS_JSON" && ok "Codex hooks -> hooks.json"
fi

# ── 6. Slash commands ────────────────────────────────────────────────────────
say "Installing slash commands"
mkdir -p "$HOME/.claude/commands"
cp -f commands/*.md "$HOME/.claude/commands/" 2>/dev/null && ok "/mt-* commands -> ~/.claude/commands/" || warn "no commands/ dir to copy"

# ── 7. CLAUDE.md / AGENTS.md memory block (idempotent, marker-bounded) ───────
say "Adding memory instructions to CLAUDE.md / AGENTS.md"
MEM_BLOCK='<!-- memorythreads:start -->
## Memory (MemoryThreads)
- Conversation turns are auto-saved to SQLite and searchable across all past sessions (both Claude Code and Codex).
- Before guessing or asking the user about an unfamiliar term, file, project, or past decision, call `recall_context(query, include_threads=true)` first.
- `search_docs(query)` searches ingested reference docs.
- Bookmark the current session with `/mt-save <name>`; list and resume bookmarks with `mt launch`.
<!-- memorythreads:end -->'
add_mem_block() {  # $1 = target md file
  local file="$1"; mkdir -p "$(dirname "$file")"; touch "$file"
  BLOCK="$MEM_BLOCK" node -e '
    const fs=require("fs"); const f=process.argv[1]; const b=process.env.BLOCK;
    let t=fs.readFileSync(f,"utf8");
    const s="<!-- memorythreads:start -->", e="<!-- memorythreads:end -->";
    if(t.includes(s)&&t.includes(e)){ t=t.slice(0,t.indexOf(s))+b+t.slice(t.indexOf(e)+e.length); }
    else { t=t.replace(/\s*$/,"")+"\n\n"+b+"\n"; }
    fs.writeFileSync(f,t);
  ' "$file"
}
add_mem_block "$HOME/.claude/CLAUDE.md" && ok "~/.claude/CLAUDE.md updated"
[ "$HAS_CODEX" = 1 ] && add_mem_block "$HOME/.codex/AGENTS.md" && ok "~/.codex/AGENTS.md updated"

# ── 8. Background worker (launchd on macOS, nohup fallback elsewhere) ─────────
say "Setting up the background worker"
if [ "$(uname)" = "Darwin" ]; then
  LA="$HOME/Library/LaunchAgents"; mkdir -p "$LA"
  cat > "$LA/com.claude.memory-watchdog.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude.memory-watchdog</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$TARGET/watchdog.sh</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$TARGET/logs/watchdog-stdout.log</string>
  <key>StandardErrorPath</key><string>$TARGET/logs/watchdog-stderr.log</string>
</dict></plist>
PLIST
  cat > "$LA/com.claude.memory-sync.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude.memory-sync</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$TARGET/incremental-sync.js</string></array>
  <key>WorkingDirectory</key><string>$TARGET</string>
  <key>WatchPaths</key><array><string>$HOME/.claude/projects</string></array>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$TARGET/logs/sync-stdout.log</string>
  <key>StandardErrorPath</key><string>$TARGET/logs/sync-stderr.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string></dict>
</dict></plist>
PLIST
  launchctl unload "$LA/com.claude.memory-watchdog.plist" 2>/dev/null || true
  launchctl unload "$LA/com.claude.memory-sync.plist" 2>/dev/null || true
  launchctl load "$LA/com.claude.memory-watchdog.plist" && ok "watchdog agent loaded"
  launchctl load "$LA/com.claude.memory-sync.plist" && ok "sync agent loaded (watches ~/.claude/projects)"
else
  warn "Non-macOS: no launchd. Starting worker via nohup; for continuous Claude sync set up a systemd path unit on ~/.claude/projects (see SETUP.md)."
  rm -f .worker-disabled .watchdog-failures 2>/dev/null || true
  nohup "$NODE_BIN" worker.js >> logs/worker.log 2>&1 &
  echo $! > worker.pid
  ok "worker started (pid $(cat worker.pid))"
fi

# ── 9. Verify ────────────────────────────────────────────────────────────────
say "Verifying"
node --check server.js && node --check worker.js && ok "server.js + worker.js parse clean"
sleep 2
if pgrep -f "$TARGET/worker.js" >/dev/null; then ok "worker process running"; else warn "worker not detected yet (watchdog will start it within ~5 min, or run: bash watchdog.sh)"; fi

cat <<DONE

$(printf '\033[1;32m')MemoryThreads installed.$(printf '\033[0m')
  - Restart Claude Code (and Codex) so they pick up the new MCP server + hooks.
  - Try it: start a session, then run  recall_context(query="test")
  - Bookmark a session: /mt-save <name>   |   Resume: mt launch
  - Docs: SETUP.md (full setup), SCHEMA.md (data model), README.md (overview)
DONE

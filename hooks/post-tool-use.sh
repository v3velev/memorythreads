#!/bin/bash
# PostToolUse hook - file-aware memory injection
# Only acts on Read/Edit/Write tools for source files
# Timeout: 500ms

# ATOMS DISABLED 2026-04-30 - hook short-circuits since knowledge table is empty
exit 0

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

# Skip only pure config files
case "$FILENAME" in
  package|package-lock|tsconfig|vite.config|tailwind.config|postcss.config) exit 0 ;;
esac

# Rate limit by session_id (stable, unlike PPID which can be reused)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
SEEN_DIR="$SERVER_DIR/seen"
mkdir -p "$SEEN_DIR"
SEEN_FILE="$SEEN_DIR/${SESSION_ID:-unknown}"

# Per-session cap: max 3 file injections total
if [ -f "$SEEN_FILE" ]; then
  INJECTION_COUNT=$(wc -l < "$SEEN_FILE" | tr -d ' ')
  [ "$INJECTION_COUNT" -ge 3 ] && exit 0
fi

# Per-file rate limit
grep -qx "$FILENAME" "$SEEN_FILE" 2>/dev/null && exit 0

# Detect project hash for cache lookup
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
PROJECT_HASH=$(echo -n "$CWD" | shasum -a 256 | cut -c1-16)
SAFE_PROJECT="${PROJECT_HASH//\'/\'\'}"
SAFE_FILENAME="${FILENAME//\'/\'\'}"

# Cache-first: vector-quality matching via injection_cache
ATOMS=$(sqlite3 "$DB_PATH" ".timeout 3000" -separator $'\x1f' "
  SELECT k.id, k.type, k.content, k.source_thread_id FROM injection_cache ic
  JOIN knowledge k ON k.id = ic.atom_id
  WHERE ic.project = '$SAFE_PROJECT' AND ic.context_type = 'file:$SAFE_FILENAME'
  AND k.status = 'active' AND k.confidence >= 0.70
  AND (k.injection_success_rate IS NULL OR k.injection_success_rate >= 0.20)
  ORDER BY ic.score DESC LIMIT 2;
" 2>/dev/null)

# FTS fallback when cache is empty
if [ -z "$ATOMS" ]; then
  ATOMS=$(sqlite3 "$DB_PATH" ".timeout 3000" -separator $'\x1f' "
    SELECT k.id, k.type, k.content, k.source_thread_id FROM knowledge k
    WHERE k.status = 'active' AND k.confidence >= 0.70
    AND (k.injection_success_rate IS NULL OR k.injection_success_rate >= 0.20)
    AND (
      k.id IN (SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH '\"$SAFE_FILENAME\"')
      OR k.id IN (SELECT rowid FROM knowledge_fts_exact WHERE knowledge_fts_exact MATCH '\"$SAFE_FILENAME\"')
    )
    ORDER BY k.confidence DESC LIMIT 2;
  " 2>/dev/null)
fi

[ -z "$ATOMS" ] && exit 0

# Only count successful injections toward cap
echo "$FILENAME" >> "$SEEN_FILE"

# Get session file for injection tracking
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
SAFE_TRANSCRIPT="${TRANSCRIPT//\'/\'\'}"

echo "<memory-context source=\"file:$FILENAME\">"
while IFS=$'\x1f' read -r id type content thread_id; do
  echo "[#$id] [$type] (thread:$thread_id) $content"
  # Update last_injected_at + record injection event
  sqlite3 "$DB_PATH" ".timeout 3000" "
    UPDATE knowledge SET last_injected_at = datetime('now') WHERE id = $id;
    INSERT INTO injection_events (atom_id, session_file, trigger_type)
    VALUES ($id, '$SAFE_TRANSCRIPT', 'post_tool_use');
  " 2>/dev/null
done <<< "$ATOMS"
echo "</memory-context>"

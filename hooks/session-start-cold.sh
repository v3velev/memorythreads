#!/bin/bash
# SessionStart (startup) Hook: status line + fast health warning.
# Surfaces silent ingest failures (stuck jobs / backlog) so they don't pile up
# unnoticed. Timeout: 1000ms - keep the DB queries fast and fail-soft.

DIR="$HOME/.claude/memory-server"
DB="$DIR/data/memory.db"
exec 2>>"$DIR/logs/hooks.log"

if [ -f "$DIR/.worker-disabled" ]; then
  echo "WARNING: MemoryThreads worker is DISABLED (repeated failures). Run 'mt doctor' to diagnose, then: rm ~/.claude/memory-server/.worker-disabled ~/.claude/memory-server/.watchdog-failures && bash ~/.claude/memory-server/watchdog.sh"
  exit 0
fi

echo "MemoryThreads active. Conversation turns are auto-saved to SQLite and searchable with recall_context (and search_docs for ingested reference docs)."

# Fast health signal: catch a silently-failing worker (stuck jobs) or a large
# backlog. Both queries are cheap + time-boxed; any error falls through silently.
STUCK=$(sqlite3 "$DB" ".timeout 400" "SELECT COUNT(*) FROM jobs WHERE status='pending' AND attempts >= 3;" 2>/dev/null)
PENDING=$(sqlite3 "$DB" ".timeout 400" "SELECT COUNT(*) FROM jobs WHERE status='pending';" 2>/dev/null)
if [ -n "$STUCK" ] && [ "$STUCK" -gt 0 ] 2>/dev/null; then
  echo "WARNING: MemoryThreads has $STUCK ingest job(s) stuck (failing repeatedly). Run 'mt doctor'."
elif [ -n "$PENDING" ] && [ "$PENDING" -gt 300 ] 2>/dev/null; then
  echo "WARNING: MemoryThreads ingest backlog is $PENDING jobs (worker may be behind or stopped). Run 'mt doctor'."
fi

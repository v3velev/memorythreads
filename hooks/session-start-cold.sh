#!/bin/bash
# SessionStart (startup) Hook: Minimal status check on cold starts
# Timeout: 1000ms

exec 2>>"$HOME/.claude/memory-server/logs/hooks.log"

# Check if worker is disabled (repeated failures)
if [ -f "$HOME/.claude/memory-server/.worker-disabled" ]; then
  echo "WARNING: Memory worker is disabled (repeated failures). Check ~/.claude/memory-server/logs/worker.log for errors."
else
  RULES_FILE="$HOME/.claude/memory-server/RULES.md"
  if [ -f "$RULES_FILE" ]; then
    echo "Memory system active. Use /primeDB to load project context, /saveDB to checkpoint, /reviewDB to audit."
    echo ""
    cat "$RULES_FILE"
  else
    echo "Memory system active. Use /primeDB to load project context, /saveDB to checkpoint, /reviewDB to audit."
  fi
fi

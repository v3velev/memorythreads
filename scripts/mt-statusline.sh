#!/usr/bin/env bash
# Statusline wrapper - runs the original statusline command unchanged.
# Thread name display is intentionally OFF.

INPUT=$(cat)
ORIGINAL_STATUSLINE="$HOME/.claude/statusline-command.sh"

if [ -f "$ORIGINAL_STATUSLINE" ]; then
  echo "$INPUT" | bash "$ORIGINAL_STATUSLINE" 2>/dev/null
fi

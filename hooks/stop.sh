#!/bin/bash

SERVER_DIR="$HOME/.claude/memory-server"
mkdir -p "$SERVER_DIR/logs" 2>/dev/null
exec 2>>"$SERVER_DIR/logs/hooks.log"

node "$SERVER_DIR/hooks/stop.cjs"
exit 0

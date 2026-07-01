#!/bin/bash
# Watchdog: Ensures the memory worker process is running
# Runs via launchd every 5 minutes
# Tracks consecutive failures and disables worker after 5 failures

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
SERVER_DIR="$HOME/.claude/memory-server"
PIDFILE="$SERVER_DIR/worker.pid"
LOGFILE="$SERVER_DIR/logs/worker.log"
FAILURE_FILE="$SERVER_DIR/.watchdog-failures"
DISABLED_FILE="$SERVER_DIR/.worker-disabled"

mkdir -p "$SERVER_DIR/logs"

# If worker is disabled, don't restart
if [ -f "$DISABLED_FILE" ]; then
  exit 0
fi

# Resolve Node.js path
NODE_PATH=$(cat "$SERVER_DIR/.node-path" 2>/dev/null)
if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
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
  # Verify PID is alive AND is actually running worker.js. Checking the full
  # command (not just comm=node) prevents PID-recycling false positives where the
  # old worker died and its PID was reused by an unrelated node process.
  if kill -0 "$PID" 2>/dev/null && ps -p "$PID" -o command= 2>/dev/null | grep -q "worker.js"; then
    # Worker is alive - reset failure counter
    echo "0" > "$FAILURE_FILE"
    exit 0
  fi
fi

# Worker is dead or PID was recycled - increment failure counter
FAILURES=$(cat "$FAILURE_FILE" 2>/dev/null || echo "0")
FAILURES=$((FAILURES + 1))
echo "$FAILURES" > "$FAILURE_FILE"

# If too many consecutive failures, disable worker
if [ "$FAILURES" -ge 5 ]; then
  touch "$DISABLED_FILE"
  echo "$(date): Worker disabled after $FAILURES consecutive failures. Delete .worker-disabled and .watchdog-failures to re-enable." >> "$LOGFILE"
  exit 1
fi

# Restart worker
cd "$SERVER_DIR"
nohup "$NODE_PATH" worker.js >> "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"
echo "$(date): Watchdog restarted worker (PID $!, failure count: $FAILURES)" >> "$LOGFILE"

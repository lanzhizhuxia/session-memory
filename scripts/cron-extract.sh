#!/bin/bash
# session-memory incremental extraction cron job
# Runs every 4 hours, incremental mode (~1-2 min)
# Logs to ~/.local/share/session-memory/cron.log

set -euo pipefail

export PATH="/opt/homebrew/bin:$PATH"
WORKDIR="/Users/user/Documents/workspace/session-memory"
LOGFILE="$HOME/.local/share/session-memory/cron.log"

mkdir -p "$(dirname "$LOGFILE")"

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') session-memory extract ==="
  cd "$WORKDIR"
  npm run extract 2>&1
  echo "=== done at $(date '+%Y-%m-%d %H:%M:%S') ==="
  echo ""
} >> "$LOGFILE" 2>&1

# Keep log file under 1MB
if [ -f "$LOGFILE" ] && [ "$(stat -f%z "$LOGFILE" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -n 500 "$LOGFILE" > "${LOGFILE}.tmp" && mv "${LOGFILE}.tmp" "$LOGFILE"
fi

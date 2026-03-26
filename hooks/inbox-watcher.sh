#!/usr/bin/env bash
# CC2CC real-time inbox watcher using fswatch (macOS/Linux)
# Requires: fswatch (brew install fswatch / apt install fswatch)
set -euo pipefail

SELF="${CC2CC_SELF:?Set CC2CC_SELF}"
BRIDGE="${CC2CC_BRIDGE_DIR:-$HOME/.cc2cc}"
LOCK="/tmp/cc2cc-watcher-${SELF}.lock"
LOG="/tmp/cc2cc-watcher-${SELF}.log"

# Find all inbox dirs for this agent
WATCH_DIRS=()
for DIR in "$BRIDGE"/*-to-"$SELF"/inbox; do
  [ -d "$DIR" ] && WATCH_DIRS+=("$DIR")
done

[ ${#WATCH_DIRS[@]} -eq 0 ] && { echo "No inbox dirs found for $SELF"; exit 1; }

log() { echo "$(date +%H:%M:%S) $*" >> "$LOG"; }

# Trim log
[ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 1000 ] && tail -500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

log "Watcher started for $SELF, monitoring ${WATCH_DIRS[*]}"

fswatch -0 --event Created --event MovedTo --event Renamed "${WATCH_DIRS[@]}" | while IFS= read -r -d '' FILE; do
  [[ "$FILE" == *.json ]] || continue
  sleep 0.3  # debounce

  # Concurrency lock
  if [ -d "$LOCK" ]; then
    LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null || echo 0) ))
    [ "$LOCK_AGE" -lt 300 ] && { log "Locked, skipping"; continue; }
    rmdir "$LOCK" 2>/dev/null
  fi
  mkdir "$LOCK" 2>/dev/null || continue

  COUNT=$(find "${WATCH_DIRS[@]}" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  log "Processing $COUNT message(s)"

  # Notify — platform-specific
  if command -v osascript &>/dev/null; then
    # macOS
    osascript -e "display notification \"$COUNT message(s) in CC2CC inbox\" with title \"CC2CC\" sound name \"Submarine\"" 2>/dev/null || true
  elif command -v notify-send &>/dev/null; then
    # Linux
    notify-send "CC2CC" "$COUNT message(s) in inbox" 2>/dev/null || true
  else
    log "No notification system available"
  fi

  rmdir "$LOCK" 2>/dev/null
done

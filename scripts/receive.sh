#!/usr/bin/env bash
set -euo pipefail

AGENT="${1:?Usage: receive.sh <agent> [--peek]}"
PEEK="${2:-}"
BRIDGE="${CC2CC_BRIDGE_DIR:-$HOME/.cc2cc}"

# Find all inboxes addressed to this agent
shopt -s nullglob
for DIR in "$BRIDGE"/*-to-"$AGENT"/inbox; do
  FILES=("$DIR"/*.json)
  [ ${#FILES[@]} -eq 0 ] && continue

  for FILE in "${FILES[@]}"; do
    python3 - "$FILE" << 'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    m = json.load(f)
print(f"From: {m['from']}  Type: {m['type']}  Priority: {m.get('priority','normal')}")
print(f"Time: {m['timestamp']}")
print(f"Content: {m['content']['text'][:200]}")
if m.get('task'):
    print(f"Task: {m['task']['title']} [{m['task']['status']}]")
print('---')
PYEOF
    # Move to done unless peeking
    if [ "$PEEK" != "--peek" ]; then
      DONE_DIR="${DIR%inbox}done"
      mkdir -p "$DONE_DIR"
      mv "$FILE" "$DONE_DIR/"
    fi
  done
done

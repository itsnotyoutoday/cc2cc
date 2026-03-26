#!/usr/bin/env bash
# CC2CC SessionStart hook — write heartbeat, check inbox
set -euo pipefail

# Read stdin (required by hook protocol)
cat > /dev/null

SELF="${CC2CC_SELF:-$(hostname -s)}"
BRIDGE="${CC2CC_BRIDGE_DIR:-$HOME/.cc2cc}"

# Write heartbeat
mkdir -p "$BRIDGE/status"
cat > "$BRIDGE/status/${SELF}-heartbeat.json" << EOF
{
  "agent": "$SELF",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "session_id": "$$",
  "status": "active",
  "context": "session started"
}
EOF

# Check inbox for pending messages
PENDING=0
OUTPUT=""
shopt -s nullglob
for FILE in "$BRIDGE"/*-to-"$SELF"/inbox/*.json; do
  PENDING=$((PENDING + 1))
  INFO=$(python3 - "$FILE" << 'PYEOF' 2>/dev/null || echo "unknown ? ?")
import json, sys
with open(sys.argv[1]) as f:
    m = json.load(f)
print(f"{m['from']} {m['type']} {m['content']['text'][:80]}")
PYEOF
  FROM=$(echo "$INFO" | cut -d' ' -f1)
  TYPE=$(echo "$INFO" | cut -d' ' -f2)
  TEXT=$(echo "$INFO" | cut -d' ' -f3-)
  OUTPUT="${OUTPUT}\n  - [$TYPE] from $FROM: $TEXT"
done

# Output for Claude Code context
if [ "$PENDING" -gt 0 ]; then
  echo "CC2CC: $PENDING pending message(s) in inbox:$OUTPUT"
else
  echo "CC2CC: No pending messages. Bridge active."
fi

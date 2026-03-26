#!/usr/bin/env bash
set -euo pipefail

BRIDGE="${CC2CC_BRIDGE_DIR:-$HOME/.cc2cc}"

echo "=== CC2CC Bridge Status ==="
echo ""

# Heartbeats
for HB in "$BRIDGE"/status/*-heartbeat.json; do
  [ -f "$HB" ] || continue
  python3 - "$HB" << 'PYEOF'
import json, sys
from datetime import datetime, timezone

with open(sys.argv[1]) as f:
    h = json.load(f)

ts = datetime.fromisoformat(h['timestamp'].replace('Z', '+00:00'))
age = (datetime.now(timezone.utc) - ts).total_seconds()

if age < 60:
    age_str = f'{age:.0f}s ago'
elif age < 3600:
    age_str = f'{age/60:.0f}m ago'
elif age < 86400:
    age_str = f'{age/3600:.1f}h ago'
else:
    age_str = f'{age/86400:.1f}d ago'

indicator = '●' if age < 600 else '○'
print(f"{indicator} {h['agent']}: {h['status']} ({age_str})")
if h.get('context'):
    print(f"  Context: {h['context']}")
PYEOF
done

echo ""

# Mailboxes
for DIR in "$BRIDGE"/*/inbox; do
  [ -d "$DIR" ] || continue
  NAME=$(basename "$(dirname "$DIR")")
  INBOX_COUNT=$(find "$DIR" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  DONE_DIR="${DIR%inbox}done"
  DONE_COUNT=$(find "$DONE_DIR" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  echo "$NAME: $INBOX_COUNT pending, $DONE_COUNT processed"
done

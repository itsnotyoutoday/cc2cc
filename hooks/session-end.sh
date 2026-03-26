#!/usr/bin/env bash
# CC2CC SessionEnd hook — mark agent offline
set -euo pipefail

cat > /dev/null

SELF="${CC2CC_SELF:-$(hostname -s)}"
BRIDGE="${CC2CC_BRIDGE_DIR:-$HOME/.cc2cc}"

mkdir -p "$BRIDGE/status"
cat > "$BRIDGE/status/${SELF}-heartbeat.json" << EOF
{
  "agent": "$SELF",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "session_id": "none",
  "status": "offline",
  "context": "session ended"
}
EOF

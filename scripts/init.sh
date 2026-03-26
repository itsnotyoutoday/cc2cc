#!/usr/bin/env bash
set -euo pipefail

AGENT_A="${1:?Usage: init.sh <agent-a> <agent-b> [bridge-dir]}"
AGENT_B="${2:?Usage: init.sh <agent-a> <agent-b> [bridge-dir]}"
BRIDGE="${3:-$HOME/.cc2cc}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

echo "Initializing CC2CC bridge: $AGENT_A ↔ $AGENT_B at $BRIDGE"

# Mailboxes
mkdir -p "$BRIDGE/${AGENT_A}-to-${AGENT_B}/"{inbox,done}
mkdir -p "$BRIDGE/${AGENT_B}-to-${AGENT_A}/"{inbox,done}

# Status
mkdir -p "$BRIDGE/status"

# Agent cards
mkdir -p "$BRIDGE/agent-cards"
for AGENT in "$AGENT_A" "$AGENT_B"; do
  PEER=$( [ "$AGENT" = "$AGENT_A" ] && echo "$AGENT_B" || echo "$AGENT_A" )
  cat > "$BRIDGE/agent-cards/$AGENT.json" << CARD
{
  "name": "$AGENT",
  "version": "1.0.0",
  "protocol": "cc2cc/1.1",
  "identity": {
    "agent_id": "$AGENT",
    "runtime": "claude-cli",
    "modes": {
      "session": "Interactive session with user",
      "heartbeat": "Autonomous periodic wake"
    }
  },
  "capabilities": {
    "taskDelegation": true,
    "persistent": false
  },
  "endpoint": "file://$BRIDGE/${PEER}-to-${AGENT}/inbox/"
}
CARD
done

# MCP channel servers
for AGENT in "$AGENT_A" "$AGENT_B"; do
  DIR="$BRIDGE/${AGENT}-channel"
  mkdir -p "$DIR"

  # Copy server.mjs from repo
  if [ -f "$REPO_DIR/channel/server.mjs" ]; then
    cp "$REPO_DIR/channel/server.mjs" "$DIR/server.mjs"
  else
    echo "Warning: channel/server.mjs not found, skipping MCP server for $AGENT"
  fi

  cat > "$DIR/package.json" << PKG
{
  "name": "cc2cc-channel-${AGENT}",
  "version": "1.1.0",
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0"
  }
}
PKG
  echo "Installing MCP dependencies for $AGENT..."
  (cd "$DIR" && npm install --silent) || echo "Warning: npm install failed for $AGENT (is Node.js installed?)"
done

# Hooks
mkdir -p "$BRIDGE/hooks"
for HOOK in session-start.sh session-end.sh inbox-watcher.sh; do
  if [ -f "$REPO_DIR/hooks/$HOOK" ]; then
    cp "$REPO_DIR/hooks/$HOOK" "$BRIDGE/hooks/$HOOK"
    chmod +x "$BRIDGE/hooks/$HOOK"
  fi
done

# Scripts
mkdir -p "$BRIDGE/scripts"
for SCRIPT in send.py receive.sh reply.py task.py status.sh validate.py cleanup.py; do
  if [ -f "$REPO_DIR/scripts/$SCRIPT" ]; then
    cp "$REPO_DIR/scripts/$SCRIPT" "$BRIDGE/scripts/$SCRIPT"
    chmod +x "$BRIDGE/scripts/$SCRIPT"
  fi
done

echo ""
echo "Bridge initialized at $BRIDGE"
echo ""
echo "Next steps:"
echo "  1. Add MCP server + hooks to each agent's ~/.claude/settings.json"
echo "  2. See docs/CONFIGURATION.md for full settings.json examples"
echo "  3. (Optional) Set up LaunchAgent for auto-wake: see launchd/"
echo ""
echo "Quick test:"
echo "  $BRIDGE/scripts/send.py $AGENT_A $AGENT_B message \"Hello from $AGENT_A\""
echo "  $BRIDGE/scripts/status.sh"

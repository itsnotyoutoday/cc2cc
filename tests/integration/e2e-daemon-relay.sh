#!/usr/bin/env bash
# Live end-to-end: real hub + two daemons ("machines") relay a message A(alpha) -> B(beta).
# Proves the daemon owns the hub connection, drains the outbox, and delivers to the peer inbox.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="$HOME/venv/bin/python"
PORT=10399; TOK=TESTTOK
A=$(mktemp -d /tmp/e2e-A-XXXX); B=$(mktemp -d /tmp/e2e-B-XXXX)
KEY="e2e-test-key-do-not-reuse"
RESULT=/tmp/e2e_result.txt; : > "$RESULT"
pids=()

cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; pkill -f "relay_hub.py --token $TOK" 2>/dev/null; }
trap cleanup EXIT

# shared key + relay config (distinct machine_id per "machine")
for d in "$A" "$B"; do printf '%s' "$KEY" > "$d/secret.key"; chmod 600 "$d/secret.key"; done
cat > "$A/relay.json" <<JSON
{ "hub_url": "http://127.0.0.1:$PORT", "token": "$TOK", "machine_id": "mach-A", "enabled": true }
JSON
cat > "$B/relay.json" <<JSON
{ "hub_url": "http://127.0.0.1:$PORT", "token": "$TOK", "machine_id": "mach-B", "enabled": true }
JSON

# 1. hub
( cd "$REPO" && CC2CC_RELAY_TOKEN=$TOK "$PY" relay_hub.py --token "$TOK" --port "$PORT" --host 127.0.0.1 ) >/tmp/e2e_hub.log 2>&1 &
pids+=($!)
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.3; done

# 2. daemons (A=alpha/a1, B=beta/b1)
( cd "$REPO" && CC2CC_BRIDGE_DIR="$A" CC2CC_TEAM=alpha CC2CC_IDENTITY=a1 CC2CC_ENCRYPT=1 node channel/daemon.mjs ) >/tmp/e2e_dA.log 2>&1 &
pids+=($!)
( cd "$REPO" && CC2CC_BRIDGE_DIR="$B" CC2CC_TEAM=beta  CC2CC_IDENTITY=b1 CC2CC_ENCRYPT=1 node channel/daemon.mjs ) >/tmp/e2e_dB.log 2>&1 &
pids+=($!)
sleep 5   # let both register + poll at least once

# 3. spool a message in A's outbox addressed to team beta (what the thinned MCP does)
mkdir -p "$A/outbox"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$A/outbox/msg-e2e.json" <<JSON
{ "id":"msg-e2e","from_team":"alpha","to_team":"beta","created":"$NOW",
  "msg":{ "id":"msg-e2e","timestamp":"$NOW","from":"a1","from_team":"alpha","to_team":"beta",
          "type":"interteam","content":{"text":"hello-e2e-DAEMON"} } }
JSON

# 4. wait for A to drain (relay) + B to poll/deliver
sleep 8

# 5. verdicts
echo "outbox_drained=$([ ! -f "$A/outbox/msg-e2e.json" ] && echo yes || echo no)" >> "$RESULT"
HIT=$(grep -rl "hello-e2e-DAEMON" "$B"/to-*/inbox/ 2>/dev/null | head -1)
echo "delivered_to_B=$([ -n "$HIT" ] && echo yes || echo no)" >> "$RESULT"
echo "B_inbox_file=${HIT:-none}" >> "$RESULT"
echo "A_daemon_relay=$(grep -o 'relay started' /tmp/e2e_dA.log | head -1)" >> "$RESULT"
echo "DONE" >> "$RESULT"

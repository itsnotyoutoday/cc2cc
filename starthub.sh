#!/usr/bin/env bash
# starthub.sh — start the cc2cc Relay Hub (the cross-machine "server" / message queue).
#
# Usage:
#   ./starthub.sh                          # foreground (Ctrl-C to stop)
#   ./starthub.sh --bg                     # background → logs to ~/relayhub.log
#   ./starthub.sh --token MYTOK --port 10322 --host 127.0.0.1
#   ./starthub.sh stop                     # stop a backgrounded hub
#
# Env overrides: CC2CC_HUB_TOKEN, CC2CC_HUB_PORT, CC2CC_HUB_HOST, CC2CC_PY
set -euo pipefail

# Repo = the directory this script lives in (portable; works wherever the repo is cloned).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Python: prefer a project venv, else system python3.
PY="${CC2CC_PY:-$HOME/venv/bin/python}"
[ -x "$PY" ] || PY="$(command -v python3 || true)"
TOKEN="${CC2CC_HUB_TOKEN:-PEERTEST}"
PORT="${CC2CC_HUB_PORT:-10322}"
HOST="${CC2CC_HUB_HOST:-127.0.0.1}"
BG=0

while [[ $# -gt 0 ]]; do case "$1" in
  stop)    pkill -f "relay_hub.py" && echo "hub stopped" || echo "no hub running"; exit 0;;
  --token) TOKEN="$2"; shift 2;;
  --port)  PORT="$2";  shift 2;;
  --host)  HOST="$2";  shift 2;;
  --bg)    BG=1; shift;;
  -h|--help) sed -n '2,9p' "$0"; exit 0;;
  *) echo "unknown arg: $1" >&2; exit 1;;
esac; done

[ -n "$PY" ] && [ -x "$PY" ]  || { echo "python not found (set CC2CC_PY or create ~/venv)"; exit 1; }
[ -f "$REPO/relay_hub.py" ]   || { echo "relay_hub.py not found in $REPO"; exit 1; }

if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  echo "Port $PORT already in use — hub may already be running (./starthub.sh stop to kill it)."
  exit 1
fi

echo "cc2cc Relay Hub → $HOST:$PORT   token=$TOKEN"
cd "$REPO"
if [[ "$BG" == "1" ]]; then
  nohup "$PY" relay_hub.py --token "$TOKEN" --port "$PORT" --host "$HOST" > "$HOME/relayhub.log" 2>&1 &
  sleep 1
  echo "started in background (pid $!) — logs: ~/relayhub.log"
  echo "peers connect with hub_url=\"http://$HOST:$PORT\" token=\"$TOKEN\"  (+ CC2CC_ENCRYPT=1, shared secret.key)"
  echo "stop with: ./starthub.sh stop"
else
  echo "(foreground — Ctrl-C to stop; use --bg to detach)"
  exec "$PY" relay_hub.py --token "$TOKEN" --port "$PORT" --host "$HOST"
fi

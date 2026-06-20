#!/usr/bin/env bash
# cc2cc node setup — one-shot, IDEMPOTENT setup of a cc2cc node for the CURRENT user.
#
# Sets up, in order:
#   1. channel npm deps
#   2. bridge dir + HMAC secret.key + status/
#   3. server files (live = point MCP at the repo, or copied into the bridge)
#   4. the cc2cc MCP server registration in ~/.claude.json   (the "cc2cc mcp")
#   5. (optional) relay.json for the cross-network hub
#   6. (optional) the inbox-watcher user service             (the "push server")
#
# Usage:
#   scripts/setup.sh [options]
#     --repo DIR        cc2cc project root (default: auto-detected from this script)
#     --bridge DIR      bridge/state dir (default: ~/.cc2cc)
#     --live            MCP points at the LIVE repo server.mjs (default; best for dev)
#     --copied          copy server.mjs + deps into the bridge (stable, no live edits)
#     --watcher NAME    install + start the inbox-watcher push service for agent NAME
#     --relay URL TOKEN configure the relay hub (writes relay.json; needs CC2CC_ENCRYPT=1)
#     -h | --help
set -euo pipefail

SELF_SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
REPO="$(dirname "$(dirname "$SELF_SCRIPT")")"     # scripts/.. = project root
BRIDGE="$HOME/.cc2cc"; MODE="live"; WATCHER_NAME=""; RELAY_URL=""; RELAY_TOK=""

while [[ $# -gt 0 ]]; do case "$1" in
  --repo)    REPO="$2"; shift 2;;
  --bridge)  BRIDGE="$2"; shift 2;;
  --live)    MODE="live"; shift;;
  --copied)  MODE="copied"; shift;;
  --watcher) WATCHER_NAME="$2"; shift 2;;
  --relay)   RELAY_URL="$2"; RELAY_TOK="${3:-}"; shift 3;;
  -h|--help) grep '^#' "$SELF_SCRIPT" | sed 's/^# \{0,1\}//'; exit 0;;
  *) echo "unknown arg: $1" >&2; exit 1;;
esac; done

CHAN="$REPO/channel"; SRV_SRC="$CHAN/server.mjs"
log(){ printf '\033[1;36m[cc2cc-setup]\033[0m %s\n' "$*"; }

command -v node    >/dev/null || { echo "node required";    exit 1; }
command -v python3 >/dev/null || { echo "python3 required"; exit 1; }
[ -f "$SRV_SRC" ]  || { echo "server.mjs not found at $SRV_SRC (bad --repo?)"; exit 1; }

# 1. channel npm deps
if [ ! -d "$CHAN/node_modules" ]; then log "npm install (channel)"; (cd "$CHAN" && npm install --silent); else log "channel deps present"; fi

# 2. bridge + secret.key + status
mkdir -p "$BRIDGE/status"
if [ ! -f "$BRIDGE/secret.key" ]; then
  log "generating HMAC secret.key"
  python3 - "$REPO" "$BRIDGE" <<'PY' 2>/dev/null || { head -c 32 /dev/urandom | base64 | tr -d '\n' > "$BRIDGE/secret.key"; }
import sys, pathlib
sys.path.insert(0, sys.argv[1])
from cc2cc.signing import generate_secret
pathlib.Path(sys.argv[2], "secret.key").write_text(generate_secret(), encoding="utf-8")
PY
  chmod 600 "$BRIDGE/secret.key"
else log "secret.key exists"; fi

# 3. server files: live vs copied
if [ "$MODE" = "copied" ]; then
  log "copying server files into bridge (stable mode)"
  cp -f "$CHAN/server.mjs" "$CHAN/names.mjs" "$CHAN/package.json" "$BRIDGE/"
  cp -rf "$CHAN/node_modules" "$BRIDGE/"
  SRV_USE="$BRIDGE/server.mjs"
else
  log "MCP points at LIVE repo server.mjs (dev mode)"
  SRV_USE="$SRV_SRC"
fi

# 4. register the MCP (merge into ~/.claude.json, idempotent)
log "registering mcpServers.cc2cc in ~/.claude.json"
SRV_USE="$SRV_USE" BRIDGE="$BRIDGE" python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.path.expanduser("~/.claude.json"))
cfg = {}
if p.exists():
    try: cfg = json.loads(p.read_text() or "{}")
    except Exception: cfg = {}
cfg.setdefault("mcpServers", {})["cc2cc"] = {
    "command": "node", "args": [os.environ["SRV_USE"]],
    "env": {"CC2CC_BRIDGE_DIR": os.environ["BRIDGE"]},
}
p.write_text(json.dumps(cfg, indent=2))
print("  -> cc2cc:", os.environ["SRV_USE"])
PY

# 5. relay (optional)
if [ -n "$RELAY_URL" ]; then
  log "writing relay.json (hub=$RELAY_URL)"
  python3 - "$BRIDGE" "$RELAY_URL" "$RELAY_TOK" <<'PY'
import json, sys, pathlib, uuid
b, url, tok = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(b, "relay.json")
cfg = json.loads(p.read_text()) if p.exists() else {}
cfg.update({"hub_url": url.rstrip("/"), "token": tok, "enabled": True})
cfg.setdefault("machine_id", "machine-" + uuid.uuid4().hex[:8])
p.write_text(json.dumps(cfg, indent=2)); print("  relay.json ->", url)
PY
  echo "  NOTE: relay requires CC2CC_ENCRYPT=1 in each agent's environment."
fi

# 6. watcher / push service (optional)
if [ -n "$WATCHER_NAME" ]; then
  log "installing inbox-watcher push service for agent '$WATCHER_NAME'"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/cc2cc-watcher@.service" <<EOF
[Unit]
Description=CC2CC Inbox Watcher (%i)
After=network.target
[Service]
Type=simple
Environment=CC2CC_SELF=%i
Environment=CC2CC_BRIDGE_DIR=$BRIDGE
ExecStart=/usr/bin/python3 $REPO/hooks/inbox_watcher.py
Restart=on-failure
RestartSec=10
[Install]
WantedBy=default.target
EOF
  loginctl enable-linger "$(id -un)" 2>/dev/null || true
  systemctl --user daemon-reload 2>/dev/null || true
  if systemctl --user enable --now "cc2cc-watcher@${WATCHER_NAME}" 2>/dev/null; then
    echo "  started cc2cc-watcher@${WATCHER_NAME}"
  else
    echo "  (systemd --user unavailable; run manually:"
    echo "     CC2CC_SELF=${WATCHER_NAME} CC2CC_BRIDGE_DIR=$BRIDGE python3 $REPO/hooks/inbox_watcher.py )"
  fi
fi

log "DONE."
cat <<EOF

  bridge:   $BRIDGE        (secret.key $( [ -f "$BRIDGE/secret.key" ] && echo present || echo MISSING ))
  mcp:      ~/.claude.json  mcpServers.cc2cc -> $SRV_USE
  watcher:  ${WATCHER_NAME:-"(none — pass --watcher NAME to install)"}

  Launch an agent session:
    cc-launch.sh <agent-name> server:cc2cc        # auto-confirms the Claude prompts
    # or: claude --dangerously-load-development-channels server:cc2cc
EOF

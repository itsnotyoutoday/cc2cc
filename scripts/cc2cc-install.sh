#!/usr/bin/env bash
# cc2cc-install.sh — unified, interactive, idempotent installer + uninstaller for cc2cc.
#
# Idempotent — safe to re-run. Local scope needs no root; global scope requires root/sudo.
# Full guide: docs/INSTALL.md (and docs/RELAY.md for cross-machine relay).
#
# Two install SCOPES:
#   local   — per-account. Bridge in ~/.cc2cc, MCP registered in this user's ~/.claude.json.
#             The relay daemon auto-spawns from the MCP (no service needed); a --user systemd
#             unit is optional. No root required.
#   global  — machine-wide. Shared bridge in /var/lib/cc2cc (group: cc2cc, setgid 2770) so
#             multiple accounts share one mailbox + ONE daemon. The daemon and (optionally) the
#             relay hub run as SYSTEM services. Requires root/sudo. Each human account then runs
#             `cc2cc-install.sh register-client --bridge /var/lib/cc2cc` to point its Claude at
#             the shared bridge (we can't edit every user's ~/.claude.json from here).
#
# ACTIONS:
#   install            interactive wizard (or flag-driven; see --non-interactive)
#   register-client    register THIS user's Claude (~/.claude.json) against an existing bridge
#   uninstall          tear down what this installer created (scope-aware, confirms data deletion)
#   status             show what's installed
#
# COMMON FLAGS:
#   --scope local|global        install scope (wizard asks if omitted)
#   --repo DIR                  cc2cc repo root (default: auto-detected from this script's location)
#   --bridge DIR                bridge dir (default: local=~/.cc2cc, global=/var/lib/cc2cc)
#   --relay                     set up the relay client config (connections.json)
#   --hub                       run a relay HUB here (system service in global, --user/bg in local)
#   --hub-port N                hub port (default 10322)
#   --hub-token TOK             hub auth token (default: generated)
#   --venv DIR                  python venv for cc2cc-admin + hub deps (default: <bridge>/venv)
#   --add-user NAME             (global) add NAME to the 'cc2cc' group so it can read the shared
#                               secret.key; repeatable. Re-run global install to add more later.
#   --encrypt                   require CC2CC_ENCRYPT=1 (mandatory if --relay/--hub)
#   --non-interactive           never prompt; use flags + defaults
#   --yes                       assume "yes" to destructive confirms (uninstall)
#   -h | --help
set -euo pipefail

# ─── locate self / repo ──────────────────────────────────────────────────────
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
# When shipped in the repo this lives in scripts/; fall back to CWD if run standalone from /tmp.
REPO_GUESS="$(dirname "$(dirname "$SELF")")"
[ -f "$REPO_GUESS/channel/server.mjs" ] || REPO_GUESS="$(pwd)"

ACTION="${1:-install}"; [[ "$ACTION" =~ ^(install|uninstall|register-client|status)$ ]] && shift || ACTION="install"

SCOPE=""; REPO="$REPO_GUESS"; BRIDGE=""; WANT_RELAY=0; WANT_HUB=0
HUB_PORT=10322; HUB_TOKEN=""; VENV=""; WANT_ENCRYPT=0; INTERACTIVE=1; ASSUME_YES=0
SYS_USER="cc2cc"; SYS_GROUP="cc2cc"; GLOBAL_ROOT="/var/lib/cc2cc"; ETC="/etc/cc2cc"; OPT_ROOT="/opt/cc2cc"; ADD_USERS=""

while [[ $# -gt 0 ]]; do case "$1" in
  --scope) SCOPE="$2"; shift 2;;
  --repo) REPO="$2"; shift 2;;
  --bridge) BRIDGE="$2"; shift 2;;
  --relay) WANT_RELAY=1; shift;;
  --hub) WANT_HUB=1; shift;;
  --hub-port) HUB_PORT="$2"; shift 2;;
  --hub-token) HUB_TOKEN="$2"; shift 2;;
  --venv) VENV="$2"; shift 2;;
  --add-user) ADD_USERS="$ADD_USERS $2"; shift 2;;
  --encrypt) WANT_ENCRYPT=1; shift;;
  --non-interactive) INTERACTIVE=0; shift;;
  --yes) ASSUME_YES=1; shift;;
  -h|--help) grep '^#' "$SELF" | sed 's/^# \{0,1\}//'; exit 0;;
  *) echo "unknown arg: $1" >&2; exit 1;;
esac; done

# ─── helpers ─────────────────────────────────────────────────────────────────
c(){ printf '\033[1;36m[cc2cc]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[cc2cc] WARN:\033[0m %s\n' "$*" >&2; }
die(){ printf '\033[1;31m[cc2cc] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
ask(){ # ask "prompt" "default" -> echoes answer (default when non-interactive)
  local p="$1" d="${2:-}" a; if [ "$INTERACTIVE" = 0 ]; then echo "$d"; return; fi
  read -r -p "$p${d:+ [$d]}: " a < /dev/tty || true; echo "${a:-$d}"; }
askyn(){ local p="$1" d="${2:-y}" a; a="$(ask "$p (y/n)" "$d")"; [[ "$a" =~ ^[Yy] ]]; }
need(){ command -v "$1" >/dev/null || die "$1 required but not found"; }
gen_token(){ head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
# Gate machine-wide actions to privileged users: root, or an actual sudoer (sudo -v fails for
# non-sudo users). A regular user must not be able to install/tear down the global mesh.
require_priv(){ # $1 = action label (for the message)
  [ "$(id -u)" -eq 0 ] && return 0
  command -v sudo >/dev/null && sudo -v 2>/dev/null && return 0
  die "$1 requires root/sudo — run as a privileged user (e.g. sudo cc2cc-install $1)"
}

# Pick sudo only when actually needed (global). Validate node/python early.
preflight(){
  need node
  local nv; nv="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${nv:-0}" -ge 18 ] || die "node >= 18 required (found $(node -v 2>/dev/null))"
  need python3
  [ -f "$REPO/channel/server.mjs" ] || die "server.mjs not found under --repo $REPO"
}

# ─── server-file deps (npm) ──────────────────────────────────────────────────
ensure_npm(){
  if [ ! -d "$REPO/channel/node_modules" ]; then c "npm install (channel)"; ( cd "$REPO/channel" && npm install --silent ); else c "channel deps present"; fi
}

# ─── venv + pip (needed for cc2cc-admin + relay hub) ─────────────────────────
ensure_venv(){ # $1 = venv dir, $2 = "run-as-sudo" flag
  local v="$1" S="${2:-}"
  if [ ! -x "$v/bin/python" ]; then c "creating venv $v"; $S python3 -m venv "$v"; fi
  c "pip install -e . (fastapi/uvicorn/pydantic + cc2cc-admin)"
  $S "$v/bin/pip" install -e "$REPO" -q
  PYBIN="$v/bin/python"; ADMIN="$v/bin/cc2cc-admin"
}

# ─── secret.key ──────────────────────────────────────────────────────────────
# Generate a fresh key for a standalone node, OR import an existing shared key. Joining a relay
# mesh REQUIRES the same byte-identical key on every peer — generating a new one would make peers
# decrypt to garbage. So when no key exists we prompt (interactive) before generating.
ensure_secret(){ # $1 bridge, $2 sudo-flag, $3 group(optional)
  local b="$1" S="${2:-}" grp="${3:-}" src="" mode="generate"
  if [ -f "$b/secret.key" ]; then c "secret.key exists (keeping)"; return 0; fi
  if [ "$INTERACTIVE" = 1 ]; then
    echo "  No secret.key found in $b."
    echo "    • GENERATE a new key — for a standalone node / your own new mesh."
    echo "    • IMPORT an existing shared key — REQUIRED to join an existing relay mesh"
    echo "      (every peer must hold the identical key)."
    src="$(ask 'Path to an existing shared key to import (leave blank to generate a new one)' '')"
    [ -n "$src" ] && mode="import"
  fi
  if [ "$mode" = import ]; then
    [ -f "$src" ] || die "shared key not found: $src"
    c "importing shared secret.key from $src"
    $S cp "$src" "$b/secret.key"
  else
    c "generating new HMAC secret.key"
    if $S "$PYBIN" - "$REPO" "$b" <<'PY' 2>/dev/null
import sys, pathlib; sys.path.insert(0, sys.argv[1])
from cc2cc.signing import generate_secret
pathlib.Path(sys.argv[2], "secret.key").write_text(generate_secret(), encoding="utf-8")
PY
    then :; else $S bash -c "head -c 32 /dev/urandom | base64 | tr -d '\n' > '$b/secret.key'"; fi
  fi
  if [ -n "$grp" ]; then $S chgrp "$grp" "$b/secret.key"; $S chmod 640 "$b/secret.key"; else $S chmod 600 "$b/secret.key"; fi
}

# ─── Claude MCP registration (per-user, ABSOLUTE path — fixes the tilde bug) ──
# Prefer `claude mcp add` (locks the file, preserves the rest, idempotent) over hand-editing
# the large/stateful ~/.claude.json. Server DEFINITIONS live only in ~/.claude.json or .mcp.json
# — never settings.json. Precedence: local(project block) > project(.mcp.json) > user(top-level).
register_mcp(){ # $1 bridge, $2 server.mjs path, $3 encrypt(0/1)
  local b="$1" srv="$2" enc="$3"
  if command -v claude >/dev/null; then
    # Shadow check: a project/.mcp.json 'cc2cc' would override our user-scope entry.
    if claude mcp list 2>/dev/null | grep -qiE '(^|[[:space:]])cc2cc([[:space:]]|:)'; then
      warn "an MCP 'cc2cc' already exists — updating the user-scope entry; a project/.mcp.json definition (higher precedence) would still shadow it."
    fi
    c "registering MCP via 'claude mcp add' (user scope)"
    local ea=( --env "CC2CC_BRIDGE_DIR=$b" ); [ "$enc" = 1 ] && ea+=( --env CC2CC_ENCRYPT=1 )
    claude mcp remove --scope user cc2cc >/dev/null 2>&1 || true   # clean re-add = idempotent
    if claude mcp add --scope user cc2cc "${ea[@]}" -- node "$srv"; then c "  -> cc2cc: $srv"; return 0; fi
    warn "'claude mcp add' failed — falling back to direct (atomic) ~/.claude.json edit"
  else
    warn "'claude' CLI not on PATH — editing ~/.claude.json directly (atomic write)"
  fi
  SRV="$srv" BRG="$b" ENC="$enc" python3 - <<'PY'
import json, os, pathlib, tempfile
p = pathlib.Path(os.path.expanduser("~/.claude.json")); cfg = {}
if p.exists():
    try: cfg = json.loads(p.read_text() or "{}")
    except Exception: cfg = {}
env = {"CC2CC_BRIDGE_DIR": os.environ["BRG"]}
if os.environ["ENC"] == "1": env["CC2CC_ENCRYPT"] = "1"
cfg.setdefault("mcpServers", {})["cc2cc"] = {"command": "node", "args": [os.environ["SRV"]], "env": env}
fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".claude.json.")   # atomic: temp + replace
with os.fdopen(fd, "w") as f: f.write(json.dumps(cfg, indent=2))
os.replace(tmp, p); print("  -> cc2cc (direct):", os.environ["SRV"])
PY
}

# ─── relay client config (canonical connections.json) ────────────────────────
write_connections(){ # $1 bridge, $2 hub-url, $3 token, $4 sudo-flag
  local b="$1" url="$2" tok="$3" S="${4:-}"
  c "writing connections.json (hub=$url)"
  $S env URL="$url" TOK="$tok" python3 - "$b" <<'PY'
import json, os, sys, pathlib, hashlib
b = pathlib.Path(sys.argv[1]); p = b / "connections.json"
cfg = json.loads(p.read_text()) if p.exists() else {}
mid = cfg.get("self", {}).get("id") or "machine-" + hashlib.sha1(str(b).encode()).hexdigest()[:8]
cfg["self"] = {"id": mid, "name": cfg.get("self", {}).get("name", "agent"), "type": "client"}
cfg["enabled"] = True; cfg.setdefault("poll_interval_ms", 3000)
conns = cfg.setdefault("connections", [])
conns[:] = [x for x in conns if x.get("id") != "primary-hub"]
conns.insert(0, {"id": "primary-hub", "type": "server", "url": os.environ["URL"].rstrip("/"),
                 "token": os.environ["TOK"], "enabled": True})
p.write_text(json.dumps(cfg, indent=2)); print("  connections.json ->", os.environ["URL"])
PY
}

# ─── systemd units ───────────────────────────────────────────────────────────
write_daemon_unit_system(){ # global daemon service
  c "installing system service cc2cc-daemon (node daemon.mjs)"
  $SUDO tee /etc/systemd/system/cc2cc-daemon.service >/dev/null <<EOF
[Unit]
Description=cc2cc relay daemon (shared bridge $BRIDGE)
After=network.target
[Service]
Type=simple
User=$SYS_USER
Group=$SYS_GROUP
Environment=CC2CC_BRIDGE_DIR=$BRIDGE
Environment=CC2CC_SERVICE_MODE=1
$( [ "$WANT_ENCRYPT" = 1 ] && echo "Environment=CC2CC_ENCRYPT=1" )
ExecStart=$(command -v node) $REPO/channel/daemon.mjs --service
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
}
write_hub_unit_system(){ # global hub service
  c "installing system service cc2cc-hub (relay_hub.py)"
  $SUDO mkdir -p "$ETC"
  echo "CC2CC_RELAY_TOKEN=$HUB_TOKEN" | $SUDO tee "$ETC/hub.env" >/dev/null
  $SUDO chmod 640 "$ETC/hub.env"; $SUDO chgrp "$SYS_GROUP" "$ETC/hub.env" 2>/dev/null || true
  $SUDO tee /etc/systemd/system/cc2cc-hub.service >/dev/null <<EOF
[Unit]
Description=cc2cc relay hub (cross-machine message queue)
After=network.target
[Service]
Type=simple
User=$SYS_USER
Group=$SYS_GROUP
EnvironmentFile=$ETC/hub.env
ExecStart=$PYBIN $REPO/relay_hub.py --host 127.0.0.1 --port $HUB_PORT
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
}

# ═══════════════════════════════════════════════════════════════════════════════
# INSTALL
# ═══════════════════════════════════════════════════════════════════════════════
do_install(){
  # Auto-route: if a machine-wide install already exists and no --scope was forced, the caller
  # almost certainly wants to JOIN it (register their own ~/.claude.json against the shared
  # bridge), not stand up a second private bridge. A regular user can't re-run the global install
  # anyway. (Detected via $GLOBAL_ROOT/secret.key; REPO auto-resolves to /opt/cc2cc via the
  # /usr/local/bin/cc2cc-install symlink, so they point at the shared code.)
  if [ -z "$SCOPE" ] && [ -e "$GLOBAL_ROOT/secret.key" ]; then
    c "Detected an existing machine-wide cc2cc install at $GLOBAL_ROOT."
    if askyn "Register THIS account ($(id -un)) against the shared bridge?" y; then
      BRIDGE="$GLOBAL_ROOT"; ensure_npm; do_register_client; return 0
    fi
  fi
  if [ -z "$SCOPE" ]; then
    SCOPE="$(ask 'Install scope — local (this account) or global (machine-wide, needs sudo)' local)"
  fi
  [[ "$SCOPE" =~ ^(local|global)$ ]] || die "scope must be local|global"
  preflight; ensure_npm

  if [ "$SCOPE" = local ]; then
    BRIDGE="${BRIDGE:-$HOME/.cc2cc}"
    VENV="${VENV:-$BRIDGE/venv}"
    if [ "$INTERACTIVE" = 1 ]; then
      askyn "Set up the relay client (connect to a hub)?" n && WANT_RELAY=1
      askyn "Run a relay hub on this account too?" n && WANT_HUB=1
    fi
    [ "$WANT_RELAY" = 1 -o "$WANT_HUB" = 1 ] && WANT_ENCRYPT=1
    mkdir -p "$BRIDGE/status" "$BRIDGE/identities"
    # venv only needed for relay/hub/admin; for a pure local mailbox we can skip pip.
    if [ "$WANT_RELAY" = 1 ] || [ "$WANT_HUB" = 1 ] || askyn "Install python tooling (cc2cc-admin)?" y; then
      ensure_venv "$VENV"; else PYBIN="python3"; fi
    ensure_secret "$BRIDGE"
    register_mcp "$BRIDGE" "$REPO/channel/server.mjs" "$WANT_ENCRYPT"
    # Optional PATH convenience: thin symlinks to the console scripts (NOT the code itself).
    if [ -n "${ADMIN:-}" ] && askyn "Symlink cc2cc/cc2cc-admin into ~/bin (PATH convenience)?" n; then
      mkdir -p "$HOME/bin"
      ln -sf "$VENV/bin/cc2cc" "$HOME/bin/cc2cc"; ln -sf "$VENV/bin/cc2cc-admin" "$HOME/bin/cc2cc-admin"
      ln -sf "$REPO/scripts/cc2cc-launch.sh" "$HOME/bin/cc2cc-launch"
      ln -sf "$SELF" "$HOME/bin/cc2cc-install"
      c "symlinked cc2cc, cc2cc-admin, cc2cc-launch, cc2cc-install into ~/bin (ensure ~/bin is on PATH)"
    fi
    if [ "$WANT_RELAY" = 1 ]; then
      local hu; hu="$(ask 'Hub URL to connect to' "http://127.0.0.1:$HUB_PORT")"
      local ht; ht="$(ask 'Hub token' "${HUB_TOKEN:-PEERTEST}")"
      write_connections "$BRIDGE" "$hu" "$ht"
    fi
    if [ "$WANT_HUB" = 1 ]; then
      [ -z "$HUB_TOKEN" ] && HUB_TOKEN="$(gen_token)"
      c "starting a local relay hub (background) on 127.0.0.1:$HUB_PORT"
      CC2CC_PY="$PYBIN" CC2CC_HUB_TOKEN="$HUB_TOKEN" CC2CC_HUB_PORT="$HUB_PORT" \
        "$REPO/starthub.sh" --bg --port "$HUB_PORT" --token "$HUB_TOKEN" || warn "hub start failed"
    fi
    # The daemon auto-spawns from the MCP; no service required for local.
    c "local install complete."
    summary

  else  # ── GLOBAL ──
    require_priv "install --scope global"
    BRIDGE="${BRIDGE:-$GLOBAL_ROOT}"
    # Stage code into a stable shared location (/opt/cc2cc) so services don't reference a homedir.
    if [ "$REPO" != "$OPT_ROOT" ]; then
      c "staging code into $OPT_ROOT"
      $SUDO mkdir -p "$OPT_ROOT"; $SUDO cp -a "$REPO/." "$OPT_ROOT/"; REPO="$OPT_ROOT"
    fi
    VENV="${VENV:-$REPO/venv}"
    if [ "$INTERACTIVE" = 1 ]; then askyn "Run the cross-machine relay hub as a system service?" y && WANT_HUB=1; fi
    WANT_ENCRYPT=1   # shared multi-user bridge → always encrypt over the wire
    c "global install → code $REPO, shared bridge $BRIDGE (group $SYS_GROUP)"
    getent group "$SYS_GROUP" >/dev/null || $SUDO groupadd --system "$SYS_GROUP"
    id "$SYS_USER" >/dev/null 2>&1 || $SUDO useradd --system --no-create-home --gid "$SYS_GROUP" --shell /usr/sbin/nologin "$SYS_USER"
    for u in $ADD_USERS; do
      if id "$u" >/dev/null 2>&1; then c "adding '$u' to group $SYS_GROUP (re-login / newgrp to take effect)"; $SUDO usermod -aG "$SYS_GROUP" "$u" || warn "could not add $u to $SYS_GROUP";
      else warn "--add-user: no such user '$u'"; fi
    done
    $SUDO mkdir -p "$BRIDGE/status" "$BRIDGE/identities"
    $SUDO chgrp -R "$SYS_GROUP" "$BRIDGE"
    $SUDO chmod 2770 "$BRIDGE" "$BRIDGE/status" "$BRIDGE/identities"   # setgid: shared writable
    ensure_venv "$VENV" "$SUDO"
    $SUDO chgrp -R "$SYS_GROUP" "$REPO" 2>/dev/null || true
    # user-facing commands → /usr/local/bin ; operator/admin (governance) → /usr/local/sbin
    $SUDO ln -sf "$VENV/bin/cc2cc" /usr/local/bin/cc2cc
    $SUDO ln -sf "$REPO/scripts/cc2cc-launch.sh" /usr/local/bin/cc2cc-launch
    $SUDO ln -sf "$REPO/scripts/cc2cc-install.sh" /usr/local/bin/cc2cc-install 2>/dev/null || $SUDO ln -sf "$SELF" /usr/local/bin/cc2cc-install
    $SUDO mkdir -p /usr/local/sbin
    $SUDO ln -sf "$VENV/bin/cc2cc-admin" /usr/local/sbin/cc2cc-admin
    ensure_secret "$BRIDGE" "$SUDO" "$SYS_GROUP"
    write_daemon_unit_system
    [ "$WANT_HUB" = 1 ] && { [ -z "$HUB_TOKEN" ] && HUB_TOKEN="$(gen_token)"; write_hub_unit_system; }
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now cc2cc-daemon
    [ "$WANT_HUB" = 1 ] && $SUDO systemctl enable --now cc2cc-hub
    c "global install complete. Each account joins with:"
    echo "    cc2cc-install.sh register-client --bridge $BRIDGE${WANT_ENCRYPT:+ --encrypt}"
    [ "$WANT_HUB" = 1 ] && echo "    (hub on 127.0.0.1:$HUB_PORT, token in $ETC/hub.env)"
    summary
  fi
}

# Register THIS user's Claude against an existing (e.g. global) bridge.
do_register_client(){
  preflight
  BRIDGE="${BRIDGE:-$GLOBAL_ROOT}"
  [ -d "$BRIDGE" ] || die "bridge $BRIDGE does not exist (run install first?)"
  [ -r "$BRIDGE/secret.key" ] || warn "can't read $BRIDGE/secret.key — are you in group $SYS_GROUP? (newgrp $SYS_GROUP / re-login)"
  # Match the bridge: a relay-configured bridge requires CC2CC_ENCRYPT on the client too.
  if [ "$WANT_ENCRYPT" = 0 ] && { [ -f "$BRIDGE/connections.json" ] || [ -f "$BRIDGE/relay.json" ]; }; then WANT_ENCRYPT=1; fi
  register_mcp "$BRIDGE" "$REPO/channel/server.mjs" "$WANT_ENCRYPT"
  c "this account is now wired to $BRIDGE. Launch: cc2cc-launch <identity>"
}

# ═══════════════════════════════════════════════════════════════════════════════
# UNINSTALL (scope-aware; confirms before deleting data)
# ═══════════════════════════════════════════════════════════════════════════════
do_uninstall(){
  if [ -z "$SCOPE" ]; then SCOPE="$(ask 'Uninstall scope (local/global)' local)"; fi
  # Always offer to remove THIS user's MCP entry.
  if askyn "Remove mcpServers.cc2cc from ~/.claude.json?" y; then
    python3 - <<'PY'
import json, pathlib, os
p = pathlib.Path(os.path.expanduser("~/.claude.json"))
if p.exists():
    cfg = json.loads(p.read_text() or "{}")
    if cfg.get("mcpServers", {}).pop("cc2cc", None) is not None:
        p.write_text(json.dumps(cfg, indent=2)); print("  removed mcpServers.cc2cc")
    else: print("  (no cc2cc entry)")
PY
  fi
  if [ "$SCOPE" = local ]; then
    BRIDGE="${BRIDGE:-$HOME/.cc2cc}"
    "$REPO/starthub.sh" stop 2>/dev/null || true
    # stop the auto-spawned per-account daemon (the global daemon is a service, handled below)
    pkill -u "$(id -u)" -f "channel/daemon.mjs" 2>/dev/null || true
    rm -f "$BRIDGE/daemon.sock" 2>/dev/null || true
    systemctl --user disable --now 'cc2cc-watcher@*' 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/cc2cc-watcher@.service" 2>/dev/null || true
    rm -f "$HOME/bin/cc2cc" "$HOME/bin/cc2cc-admin" "$HOME/bin/cc2cc-launch" "$HOME/bin/cc2cc-install" 2>/dev/null || true
    command -v claude >/dev/null && claude mcp remove --scope user cc2cc >/dev/null 2>&1 || true
    if [ -d "$BRIDGE" ] && { [ "$ASSUME_YES" = 1 ] || askyn "Delete bridge data $BRIDGE (mailboxes, secret.key)?" n; }; then
      rm -rf "$BRIDGE"; c "removed $BRIDGE"
    else c "kept bridge $BRIDGE"; fi
  else  # global — tears down system services + shared state; privileged users only
    require_priv "uninstall --scope global"
    for svc in cc2cc-hub cc2cc-daemon; do
      $SUDO systemctl disable --now "$svc" 2>/dev/null || true
      $SUDO rm -f "/etc/systemd/system/$svc.service"
    done
    $SUDO systemctl daemon-reload 2>/dev/null || true
    $SUDO rm -rf "$ETC"
    $SUDO rm -f /usr/local/bin/cc2cc /usr/local/bin/cc2cc-launch /usr/local/bin/cc2cc-install /usr/local/sbin/cc2cc-admin
    BRIDGE="${BRIDGE:-$GLOBAL_ROOT}"
    if [ -d "$BRIDGE" ] && { [ "$ASSUME_YES" = 1 ] || askyn "Delete shared bridge $BRIDGE?" n; }; then
      $SUDO rm -rf "$BRIDGE"; c "removed $BRIDGE"; fi
    if [ -d "$OPT_ROOT" ] && { [ "$ASSUME_YES" = 1 ] || askyn "Delete staged code $OPT_ROOT?" n; }; then
      $SUDO rm -rf "$OPT_ROOT"; c "removed $OPT_ROOT"; fi
    if askyn "Remove system user/group '$SYS_USER'/'$SYS_GROUP'?" n; then
      $SUDO userdel "$SYS_USER" 2>/dev/null || true
      $SUDO groupdel "$SYS_GROUP" 2>/dev/null || true
    fi
  fi
  c "uninstall done."
}

do_status(){
  echo "scope candidates:"
  echo "  local  bridge: $HOME/.cc2cc  $( [ -d "$HOME/.cc2cc" ] && echo present || echo absent )"
  echo "  global bridge: $GLOBAL_ROOT  $( [ -d "$GLOBAL_ROOT" ] && echo present || echo absent )"
  python3 - <<'PY' 2>/dev/null || true
import json, pathlib, os
p = pathlib.Path(os.path.expanduser("~/.claude.json"))
m = (json.loads(p.read_text() or "{}").get("mcpServers", {}) if p.exists() else {}).get("cc2cc")
print("  ~/.claude.json mcpServers.cc2cc:", "registered ->" + m["args"][0] if m else "absent")
PY
  for svc in cc2cc-daemon cc2cc-hub; do
    systemctl is-active "$svc" >/dev/null 2>&1 && echo "  system $svc: active" || true
  done
}

summary(){
  cat <<EOF

  scope:   $SCOPE
  bridge:  $BRIDGE   (secret.key $( [ -e "$BRIDGE/secret.key" ] && echo present || echo MISSING ))
  mcp:     ~/.claude.json  mcpServers.cc2cc -> $REPO/channel/server.mjs
  relay:   $( [ "$WANT_RELAY" = 1 ] && echo "client -> connections.json" || echo "(none)" )
  hub:     $( [ "$WANT_HUB" = 1 ] && echo "running (port $HUB_PORT)" || echo "(none)" )
  encrypt: $( [ "$WANT_ENCRYPT" = 1 ] && echo "CC2CC_ENCRYPT=1 (required)" || echo "off (local plaintext)" )

  Launch an agent:
    cc2cc-launch <identity>          # foreground interactive (cc2cc-launch with no args = pick from a list)
    cc2cc-launch -t <identity>       # in tmux, hands-free (auto-answers the startup menus)
    # provision identities/teams first with: cc2cc-admin team create / member add
EOF
}

case "$ACTION" in
  install)         do_install;;
  register-client) do_register_client;;
  uninstall)       do_uninstall;;
  status)          do_status;;
esac

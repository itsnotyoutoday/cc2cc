#!/usr/bin/env bash
# cc2cc-launch — bring a Claude Code cc2cc agent online under a chosen identity.
#
# The identity determines the team(s) — there is no --team flag; switch teams from inside the
# session if needed. By default this launches a NORMAL interactive Claude Code session in the
# foreground (you answer the startup prompts yourself). Pass -t to run it in tmux instead, where
# the startup menus (trust / dev-channels / bypass-permissions) are auto-answered hands-free.
#
# Usage:
#   cc2cc-launch [identity]            # foreground interactive session as <identity>
#   cc2cc-launch                       # no identity → pick from a list
#   cc2cc-launch --identity tom        # explicit identity flag (same as positional)
#   cc2cc-launch -t tom                # launch in tmux (auto-answers menus), don't steal focus
#
# Options:
#   -t, --tmux            run inside tmux (new window if already in tmux, else new session)
#   -i, --identity NAME   identity to launch as (or give it positionally)
#   -c, --channel NAME    MCP channel (default: server:cc2cc)
#   -e, --encrypt         force CC2CC_ENCRYPT=1 (auto-on when a relay config is present)
#   -h, --help
#
# Env: CC2CC_BRIDGE_DIR (default: global /var/lib/cc2cc if present, else ~/.cc2cc). NON-ROOT user.
set -uo pipefail

# Bridge: an explicit CC2CC_BRIDGE_DIR wins; else auto-detect a machine-wide install
# (/var/lib/cc2cc) before falling back to the per-user local bridge (~/.cc2cc).
if [ -n "${CC2CC_BRIDGE_DIR:-}" ]; then BRIDGE="$CC2CC_BRIDGE_DIR"
# Detect the global install by the DIRECTORY (statable via its world-traversable parent), NOT a
# file inside it — a login without the cc2cc group can't traverse the bridge to see secret.key.
elif [ -d /var/lib/cc2cc ]; then BRIDGE="/var/lib/cc2cc"
else BRIDGE="$HOME/.cc2cc"; fi
CHANNEL="server:cc2cc"; USE_TMUX=0; IDENT=""; ENCRYPT=0; TIMEOUT="${TIMEOUT:-120}"
ORIG_ARGS=("$@")   # preserved for a possible re-exec under the bridge group (see below)

while [[ $# -gt 0 ]]; do case "$1" in
  -t|--tmux)     USE_TMUX=1; shift;;
  -i|--identity) IDENT="$2"; shift 2;;
  -c|--channel)  CHANNEL="$2"; shift 2;;
  -e|--encrypt)  ENCRYPT=1; shift;;
  -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
  -*)            echo "cc2cc-launch: unknown option $1" >&2; exit 1;;
  *)             IDENT="$1"; shift;;
esac; done

# Claude blocks --dangerously-skip-permissions under root. Rather than refuse, launch root sessions
# WITHOUT that flag (normal permission prompts apply); non-root keeps the hands-free bypass.
if [[ "$(id -u)" -eq 0 ]]; then
  SKIP_PERMS=""
  echo "cc2cc-launch: running as root — launching WITHOUT --dangerously-skip-permissions (permission prompts will apply)."
else
  SKIP_PERMS="--dangerously-skip-permissions"
fi
command -v claude >/dev/null || { echo "cc2cc-launch: 'claude' not on PATH"; exit 1; }

# The agent's MCP must have the bridge's group ACTIVE to read/write the shared bridge. A login that
# predates your group membership won't have it — and tmux panes inherit the (groupless) tmux server
# — so the agent would boot with no identity/team. If we're a member, run under the group via `sg`:
# re-exec the launcher (so its own bridge reads + a foreground agent inherit the group) and, for
# tmux, wrap the sent command too. If we're not a member, stop with guidance, not a broken session.
BRIDGE_GROUP="$(stat -c '%G' "$BRIDGE" 2>/dev/null || echo "")"
GROUP_WRAP=0
if [ "$(id -u)" -ne 0 ] && [ -n "$BRIDGE_GROUP" ] && [ "$BRIDGE_GROUP" != "$(id -gn "$(id -un)")" ]; then
  if id -nG "$(id -un)" 2>/dev/null | tr ' ' '\n' | grep -qx "$BRIDGE_GROUP"; then
    GROUP_WRAP=1
    if [ -z "${CC2CC_SG_REEXEC:-}" ] && ! id -nG | tr ' ' '\n' | grep -qx "$BRIDGE_GROUP"; then
      echo "cc2cc-launch: activating group '$BRIDGE_GROUP' for bridge access…"
      export CC2CC_SG_REEXEC=1
      exec sg "$BRIDGE_GROUP" -c "$(printf '%q ' "$0" "${ORIG_ARGS[@]}")"
    fi
  else
    echo "cc2cc-launch: you're not in group '$BRIDGE_GROUP', so the agent can't read/write $BRIDGE" >&2
    echo "  (it would come up with no identity/team). Ask an admin to add you, then re-login:" >&2
    echo "    sudo cc2cc-install install --scope global --add-user $(id -un)" >&2
    exit 1
  fi
fi

# Relay configured? → encryption is mandatory for the daemon, so default it on.
if [ "$ENCRYPT" = 0 ] && { [ -f "$BRIDGE/connections.json" ] || [ -f "$BRIDGE/relay.json" ]; }; then
  ENCRYPT=1
fi

# List provisioned identities (display_name + teams) from the bridge.
list_identities(){ # prints: "<name>\t<team,team>" per line
  python3 - "$BRIDGE" <<'PY'
import json, sys, pathlib
d = pathlib.Path(sys.argv[1], "identities")
for p in sorted(d.glob("identity-*.json")):
    try: o = json.loads(p.read_text())
    except Exception: continue
    name = o.get("display_name") or p.stem.replace("identity-", "")
    print(f"{name}\t{','.join(o.get('teams', [])) or '-'}")
PY
}

# No identity given → interactive picker.
if [ -z "$IDENT" ]; then
  mapfile -t ROWS < <(list_identities)
  [ "${#ROWS[@]}" -gt 0 ] || { echo "cc2cc-launch: no identities found in $BRIDGE/identities/ (provision with cc2cc-admin first)"; exit 1; }
  echo "Identities in $BRIDGE:"
  for i in "${!ROWS[@]}"; do
    printf "  %2d) %-20s teams: %s\n" "$((i+1))" "${ROWS[$i]%%$'\t'*}" "${ROWS[$i]##*$'\t'}"
  done
  read -r -p "Pick [1-${#ROWS[@]}] (or type a name): " pick < /dev/tty || true
  if [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "${#ROWS[@]}" ]; then
    IDENT="${ROWS[$((pick-1))]%%$'\t'*}"
  else
    IDENT="$pick"
  fi
  [ -n "$IDENT" ] || { echo "cc2cc-launch: no identity chosen"; exit 1; }
fi

# Identity names are lowercase letters/digits/hyphens (filesystem-safe + routing-consistent). The
# MCP silently REJECTS anything else and boots DORMANT (no identity/team) — so lowercase a
# capitalized name (e.g. 'John' -> 'john'), and reject anything still invalid with a clear message.
NORM="$(printf '%s' "$IDENT" | tr '[:upper:]' '[:lower:]')"
if [ "$NORM" != "$IDENT" ]; then
  echo "cc2cc-launch: identity names are lowercase — launching '$IDENT' as '$NORM'."
  IDENT="$NORM"
fi
if ! printf '%s' "$IDENT" | grep -qE '^[a-z0-9][a-z0-9-]{0,30}$'; then
  echo "cc2cc-launch: invalid identity '$IDENT' — use lowercase letters/digits/hyphens, start with a letter or digit, max 31 chars." >&2
  exit 1
fi

# ─── foreground (default): a normal interactive session; user answers prompts ──
if [ "$USE_TMUX" = 0 ]; then
  env=( "CC2CC_BRIDGE_DIR=$BRIDGE" "CC2CC_IDENTITY=$IDENT" ); [ "$ENCRYPT" = 1 ] && env+=( "CC2CC_ENCRYPT=1" )
  echo "cc2cc-launch: starting '$IDENT' (channel=$CHANNEL${ENCRYPT:+, encrypted})"
  exec env "${env[@]}" claude $SKIP_PERMS --dangerously-load-development-channels "$CHANNEL"
fi

# ─── tmux (-t): hands-free, auto-answers the startup menus ─────────────────────
command -v tmux >/dev/null || { echo "cc2cc-launch: -t requires tmux"; exit 1; }
NAME="cc2cc-$IDENT"
AFFORD='Enter to confirm|Esc to cancel|❯ *[0-9]\.'
PROMPTS=(
  "trust this folder|Quick safety check|Is this a project you created::Enter"
  "Loading development channels|local development only::Enter"
  "Bypass Permissions mode|accept all responsibility|Yes, I accept::Down Enter"
)
RUNNING='bypass permissions|\? for shortcuts|esc to interrupt|Welcome to Claude Code|│ >'
NEEDS_AUTH='Log ?in|/login|Sign in|Select login|Subscription|Invalid API key|console\.anthropic'
ts(){ date +%H:%M:%S; }; has(){ grep -qiE "$1" <<<"$2"; }

if [[ -n "${TMUX:-}" ]]; then
  tmux list-windows -F '#{window_name}' 2>/dev/null | grep -qx "$NAME" && { echo "window '$NAME' exists. Switch: tmux select-window -t $NAME"; exit 0; }
  TARGET="$(tmux new-window -d -n "$NAME" -c "$PWD" -P -F '#{window_id}')"; VIEW="tmux select-window -t $NAME"
else
  tmux has-session -t "$NAME" 2>/dev/null && { echo "session '$NAME' running. Attach: tmux attach -t $NAME"; exit 0; }
  tmux new-session -d -s "$NAME" -x 200 -y 50 -c "$PWD"; TARGET="$NAME"; VIEW="tmux attach -t $NAME"
fi
pane(){ tmux capture-pane -p -t "$TARGET" 2>/dev/null || true; }
send(){ tmux send-keys -t "$TARGET" "$@"; }

ENVPREFIX="CC2CC_BRIDGE_DIR='$BRIDGE' CC2CC_IDENTITY='$IDENT'"; [ "$ENCRYPT" = 1 ] && ENVPREFIX="$ENVPREFIX CC2CC_ENCRYPT=1"
echo "$(ts) cc2cc-launch: starting '$IDENT' in tmux (channel=$CHANNEL)"
TMUX_CMD="$ENVPREFIX claude $SKIP_PERMS --dangerously-load-development-channels '$CHANNEL'"
# tmux panes run under the tmux SERVER, which may lack the bridge group even if we have it — wrap
# the agent command under the group so its MCP can read/write the bridge.
[ "$GROUP_WRAP" = 1 ] && TMUX_CMD="sg $BRIDGE_GROUP -c $(printf '%q' "$TMUX_CMD")"
send "$TMUX_CMD" Enter

deadline=$((SECONDS+TIMEOUT)); lastsig=""
while (( SECONDS < deadline )); do
  scr="$(pane)"
  if has "$AFFORD" "$scr"; then
    answered=""
    for entry in "${PROMPTS[@]}"; do
      pat="${entry%%::*}"; keys="${entry##*::}"
      if has "$pat" "$scr"; then
        echo "$(ts) prompt (/$pat/) → $keys"
        for k in $keys; do send "$k"; sleep 0.25; done
        answered=1
        for _ in $(seq 1 40); do sleep 0.25; has "$AFFORD" "$(pane)" || break; done
        break
      fi
    done
    if [[ -z "$answered" ]]; then
      sig="$(grep -m1 -iE '❯' <<<"$scr" || true)"
      [[ "$sig" != "$lastsig" ]] && { echo "$(ts) unknown menu (default Enter)"; lastsig="$sig"; }
      send Enter; sleep 0.5
    fi
    continue
  fi
  has "$NEEDS_AUTH" "$scr" && { echo "$(ts) ⚠️ needs AUTH. View: $VIEW → run: claude → /login"; exit 10; }
  has "$RUNNING" "$scr"    && { echo "$(ts) ✅ '$IDENT' is LIVE. View: $VIEW"; exit 0; }
  sleep 0.5
done
echo "$(ts) ⚠️ timed out after ${TIMEOUT}s. View: $VIEW"; exit 2

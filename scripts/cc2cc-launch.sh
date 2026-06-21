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
# Env: CC2CC_BRIDGE_DIR (default ~/.cc2cc). Must run as a NON-ROOT user.
set -uo pipefail

BRIDGE="${CC2CC_BRIDGE_DIR:-$HOME/.cc2cc}"
CHANNEL="server:cc2cc"; USE_TMUX=0; IDENT=""; ENCRYPT=0; TIMEOUT="${TIMEOUT:-120}"

while [[ $# -gt 0 ]]; do case "$1" in
  -t|--tmux)     USE_TMUX=1; shift;;
  -i|--identity) IDENT="$2"; shift 2;;
  -c|--channel)  CHANNEL="$2"; shift 2;;
  -e|--encrypt)  ENCRYPT=1; shift;;
  -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
  -*)            echo "cc2cc-launch: unknown option $1" >&2; exit 1;;
  *)             IDENT="$1"; shift;;
esac; done

[[ "$(id -u)" -eq 0 ]] && { echo "cc2cc-launch: run as a non-root user (--dangerously-skip-permissions is blocked under root)."; exit 1; }
command -v claude >/dev/null || { echo "cc2cc-launch: 'claude' not on PATH"; exit 1; }

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

# ─── foreground (default): a normal interactive session; user answers prompts ──
if [ "$USE_TMUX" = 0 ]; then
  env=( "CC2CC_IDENTITY=$IDENT" ); [ "$ENCRYPT" = 1 ] && env+=( "CC2CC_ENCRYPT=1" )
  echo "cc2cc-launch: starting '$IDENT' (channel=$CHANNEL${ENCRYPT:+, encrypted})"
  exec env "${env[@]}" claude --dangerously-skip-permissions --dangerously-load-development-channels "$CHANNEL"
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

ENVPREFIX="CC2CC_IDENTITY='$IDENT'"; [ "$ENCRYPT" = 1 ] && ENVPREFIX="$ENVPREFIX CC2CC_ENCRYPT=1"
echo "$(ts) cc2cc-launch: starting '$IDENT' in tmux (channel=$CHANNEL)"
send "$ENVPREFIX claude --dangerously-skip-permissions --dangerously-load-development-channels '$CHANNEL'" Enter

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

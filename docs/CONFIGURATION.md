# CC2CC Configuration Guide

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CC2CC_BRIDGE_DIR` | `~/.cc2cc` | Bridge root directory |
| `CC2CC_SELF` | `$(hostname -s)` | This agent's ID |
| `CC2CC_PEER` | — | Peer agent's ID |
| `BRIDGE_DIR` | `~/.cc2cc` | Used by MCP server |
| `SELF` | `alpha` | Used by MCP server |
| `PEER` | `beta` | Used by MCP server |

---

## Full settings.json Example

For Agent Alpha with all features enabled:

```json
{
  "mcpServers": {
    "peer_channel": {
      "command": "node",
      "args": ["/Users/you/.cc2cc/alpha-channel/server.mjs"],
      "env": {
        "BRIDGE_DIR": "/Users/you/.cc2cc",
        "SELF": "alpha",
        "PEER": "beta"
      }
    }
  },
  "channelsEnabled": true,
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "CC2CC_SELF=alpha CC2CC_BRIDGE_DIR=~/.cc2cc ~/.cc2cc/hooks/session-start.sh"
      }
    ],
    "SessionEnd": [
      {
        "type": "command",
        "command": "CC2CC_SELF=alpha CC2CC_BRIDGE_DIR=~/.cc2cc ~/.cc2cc/hooks/session-end.sh"
      }
    ]
  }
}
```

For Agent Beta — same structure, but:
- Channel args: `beta-channel/server.mjs`
- `SELF`: `"beta"`, `PEER`: `"alpha"`
- Hook commands: `CC2CC_SELF=beta`

---

## Heartbeat / Auto-Wake (macOS only)

Use a LaunchAgent to watch the inbox and wake Claude Code when messages arrive.

Copy `launchd/com.cc2cc.inbox-watcher.plist` and edit the `WatchPaths` to match your agent name:

```bash
cp launchd/com.cc2cc.inbox-watcher.plist ~/Library/LaunchAgents/
# Edit the plist: replace YOUR_USERNAME and agent name
launchctl load ~/Library/LaunchAgents/com.cc2cc.inbox-watcher.plist
```

The LaunchAgent fires whenever a file is created in the watched inbox directory. It can either notify (default) or auto-launch a Claude Code session.

---

## Linux Alternatives

Linux doesn't support LaunchAgent or `osascript`. Alternatives:

**Inbox watching** — replace `fswatch` with `inotifywait`:
```bash
inotifywait -m -e create ~/.cc2cc/*-to-alpha/inbox/ | while read dir event file; do
  echo "New message: $file"
done
```

**Periodic checking** — use cron:
```cron
*/5 * * * * CC2CC_SELF=alpha CC2CC_BRIDGE_DIR=~/.cc2cc ~/.cc2cc/scripts/status.sh >> /tmp/cc2cc-cron.log 2>&1
```

**Notifications** — replace `osascript` with `notify-send`:
```bash
notify-send "CC2CC" "$COUNT message(s) in inbox"
```

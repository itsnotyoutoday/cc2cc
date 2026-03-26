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
        "command": "python /Users/you/.cc2cc/hooks/session_start.py",
        "env": { "CC2CC_SELF": "alpha", "CC2CC_BRIDGE_DIR": "/Users/you/.cc2cc" }
      }
    ],
    "SessionEnd": [
      {
        "type": "command",
        "command": "python /Users/you/.cc2cc/hooks/session_end.py",
        "env": { "CC2CC_SELF": "alpha", "CC2CC_BRIDGE_DIR": "/Users/you/.cc2cc" }
      }
    ]
  }
}
```

For Agent Beta — same structure, but:
- Channel args: `beta-channel/server.mjs`
- `SELF`: `"beta"`, `PEER`: `"alpha"`
- Hook env: `"CC2CC_SELF": "beta"`

---

## Auto-Wake Service (Optional)

Install a background service that watches the inbox and notifies when messages arrive.

**macOS (LaunchAgent):**
```bash
cp services/macos/com.cc2cc.inbox-watcher.plist ~/Library/LaunchAgents/
# Edit: replace YOUR_USERNAME and YOUR_AGENT
launchctl load ~/Library/LaunchAgents/com.cc2cc.inbox-watcher.plist
```

**Linux (systemd):**
```bash
cp services/linux/cc2cc-watcher.service ~/.config/systemd/user/
# Edit: replace YOUR_AGENT
systemctl --user enable cc2cc-watcher
systemctl --user start cc2cc-watcher
```

**Windows (Task Scheduler):**
```powershell
# Edit services/windows/cc2cc-watcher.xml: replace YOUR_USERNAME
schtasks /create /tn "CC2CC Watcher" /xml services\windows\cc2cc-watcher.xml
```

**Or run manually:**
```bash
CC2CC_SELF=alpha CC2CC_BRIDGE_DIR=~/.cc2cc python hooks/inbox_watcher.py
```

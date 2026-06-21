# CC2CC Configuration Guide

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CC2CC_BRIDGE_DIR` | `~/.cc2cc` | Bridge root directory |
| `CC2CC_SELF` | — | This agent's name (used by hooks). Optional — if set, the server uses it instead of auto-generating a name. |

> **Note:** `SELF`, `PEER`, and `CC2CC_PEER` are no longer used. The unified MCP server auto-generates agent names and discovers peers dynamically.

---

## MCP Server Configuration

MCP servers are configured in `~/.claude.json` (NOT `~/.claude/settings.json`).

Add the `cc2cc` entry to the `mcpServers` object:

```json
{
  "mcpServers": {
    "cc2cc": {
      "command": "node",
      "args": ["~/.cc2cc/server.mjs"],
      "env": {
        "CC2CC_BRIDGE_DIR": "~/.cc2cc"
      }
    }
  }
}
```

> **Important:** On Windows, use full paths with escaped backslashes: `"C:\\Users\\YOU\\.cc2cc\\server.mjs"`

This same configuration is used by every Claude Code instance. Each instance auto-registers with a unique name (e.g. `brave-fox`, `calm-owl`) on startup.

## Hooks (Optional)

Hooks are configured in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "python ~/.cc2cc/hooks/session_start.py",
            "env": { "CC2CC_BRIDGE_DIR": "~/.cc2cc" }
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "python ~/.cc2cc/hooks/session_end.py",
            "env": { "CC2CC_BRIDGE_DIR": "~/.cc2cc" }
          }
        ]
      }
    ]
  }
}
```

---

## HMAC Secret

Generated automatically by `cc2cc init`. Located at `$CC2CC_BRIDGE_DIR/secret.key`.
Both agents must have access to the same secret file (same filesystem).

To regenerate: delete `secret.key` and run `cc2cc init` again.

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

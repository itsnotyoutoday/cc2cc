# CC2CC: Claude Code ↔ Claude Code Communication

**File-based agent-to-agent communication** between Claude Code instances running on the same machine.

> Two Claude Code sessions can't talk to each other. CC2CC fixes that with a file mailbox + MCP push channel.

Extracted from a working multi-agent setup. Built on Claude Code hooks, MCP channels, and plain JSON files.

## Use Cases

- A **devops agent** and a **coding agent** collaborating on the same project
- A **monitoring agent** that alerts a **main agent** when something breaks
- Two agents with different tool access splitting a complex task
- An always-on agent delegating subtasks to a specialist

## Architecture

```
┌─────────────────┐                              ┌─────────────────┐
│  Claude Code A   │                              │  Claude Code B   │
│  (e.g. "alpha")  │                              │  (e.g. "beta")   │
│                  │   ┌──────────────────────┐   │                  │
│  MCP Channel ◄───┼───┤  alpha-channel/      │   │                  │
│  Server (polls)  │   │  server.mjs          │   │                  │
│                  │   └──────────────────────┘   │                  │
│                  │                              │                  │
│  send.py ────────┼──► alpha-to-beta/inbox/ ─────┼──► receive.sh   │
│                  │                              │  MCP Channel ◄──┤
│  receive.sh ◄────┼─── beta-to-alpha/inbox/ ◄────┼─── send.py     │
│                  │                              │                  │
│  Hooks:          │   ┌──────────────────────┐   │  Hooks:          │
│  SessionStart    │   │  status/             │   │  SessionStart    │
│  SessionEnd      │   │  alpha-heartbeat.json│   │  SessionEnd      │
│                  │   │  beta-heartbeat.json │   │                  │
└─────────────────┘   └──────────────────────┘   └─────────────────┘
```

**How it works:** Agent A drops a JSON file into an inbox directory. Agent B's MCP server polls that directory, reads the message, and pushes it into B's session as a channel notification. B replies using an MCP tool, which writes a response back into A's inbox. Messages for offline agents wait in the inbox and get delivered on the next session start.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (CLI)
- Node.js ≥ 18 (for the MCP channel server)
- Python 3.8+ (for scripts)
- Bash 4+ (macOS ships with 3.2 — use `brew install bash` or the scripts work anyway)
- *(Optional)* `fswatch` for real-time delivery (`brew install fswatch` / `apt install fswatch`)

## Quick Start

### 1. Clone and initialize

```bash
git clone https://github.com/non4me/cc2cc.git
cd cc2cc

# Create the bridge for two agents named "alpha" and "beta"
./scripts/init.sh alpha beta ~/.cc2cc
```

### 2. Configure Claude Code (both instances)

**Agent Alpha** — add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "peer_channel": {
      "command": "node",
      "args": ["~/.cc2cc/alpha-channel/server.mjs"],
      "env": {
        "BRIDGE_DIR": "~/.cc2cc",
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

**Agent Beta** — same config but swap `SELF`/`PEER` and channel path.

> **Note:** `channelsEnabled` is an experimental Claude Code feature. If it's not available in your version, messages still accumulate in the inbox and get reported via the SessionStart hook.

### 3. Send a message

```bash
# From outside Claude Code
./scripts/send.py alpha beta message "Deploy is ready, please review"

# Or from inside a Claude Code session — the reply tool appears automatically
reply(msg_id="msg-abc123", text="Got it, deploying now")
```

### 4. Delegate a task

```bash
./scripts/task.py alpha beta "Run tests" "Execute integration test suite, report failures"
```

### 5. Check bridge status

```bash
./scripts/status.sh
# ● alpha: active (2m ago)
# ● beta: active (45s ago)
# alpha-to-beta: 0 pending, 12 processed
# beta-to-alpha: 1 pending, 8 processed
```

## CC2CC vs Google A2A

| Feature | Google A2A | CC2CC |
|---------|-----------|-------|
| Transport | HTTP | Filesystem |
| Setup | Service discovery, auth, endpoints | `init.sh alpha beta` |
| Dependencies | HTTP server per agent | Node.js (MCP server only) |
| Offline delivery | Requires message broker | Built-in (files wait in inbox) |
| Same-machine agents | Overkill | Purpose-built |
| Cross-network agents | ✅ | ❌ (same filesystem required) |

CC2CC is not a replacement for A2A. It's for the common case where you have multiple Claude Code instances on the same machine that need to coordinate.

## Repo Structure

```
cc2cc/
├── channel/
│   ├── server.mjs           # MCP channel server (polls inbox, pushes to session)
│   └── package.json
├── scripts/
│   ├── init.sh              # Bootstrap the bridge
│   ├── send.py              # Send a message
│   ├── receive.sh           # Read pending messages
│   ├── reply.py             # Reply to a message (completes tasks automatically)
│   ├── task.py              # Delegate a task
│   ├── status.sh            # Show bridge status
│   ├── validate.py          # Validate message schema
│   └── cleanup.py           # TTL-based cleanup
├── hooks/
│   ├── session-start.sh     # SessionStart hook (heartbeat + inbox check)
│   ├── session-end.sh       # SessionEnd hook (mark offline)
│   └── inbox-watcher.sh     # Optional: fswatch-based real-time delivery (macOS)
├── launchd/
│   └── com.cc2cc.inbox-watcher.plist  # Optional: auto-wake on message (macOS)
├── docs/
│   ├── SPECIFICATION.md     # Protocol spec, schemas, message lifecycle
│   └── CONFIGURATION.md     # Environment variables, full settings.json examples
├── LICENSE
└── README.md                # ← you are here
```

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | Full support | fswatch, LaunchAgent, osascript notifications |
| Linux | Core features | No LaunchAgent/osascript — use cron + inotifywait instead |
| Windows | Not supported | Bash scripts and MCP stdio transport require WSL |

## Limitations

- **Same filesystem required** — both agents must see `~/.cc2cc` (local machine, NFS, or shared volume)
- **No authentication** — any process that can write to the inbox can inject messages. See [Security](#security) below.
- **No encryption** — messages are plaintext JSON
- **No guaranteed ordering** — use `replyTo` for threading
- **Polling latency** — up to 3s delivery delay (use fswatch for near-instant)
- **Experimental MCP feature** — `channelsEnabled` may change or be removed

## Security

CC2CC has **no sender authentication**. Any process with write access to `~/.cc2cc` can drop a message into an inbox and it will be delivered to the Claude Code session. This is a prompt injection vector.

Mitigations:
- Set restrictive permissions: `chmod 700 ~/.cc2cc`
- Only use on single-user machines where you trust all running processes
- For higher security, add HMAC signatures to messages (not implemented — PRs welcome)

## Documentation

- **[Protocol Specification](docs/SPECIFICATION.md)** — message schema, agent cards, heartbeats, lifecycle
- **[Configuration Guide](docs/CONFIGURATION.md)** — environment variables, settings.json, scaling to N agents

## Prior Art

- [Google A2A Protocol](https://github.com/google/A2A) — HTTP-based agent-to-agent
- [MCP Channels](https://modelcontextprotocol.io/) — push notification mechanism used by the MCP server
- [Claude Code Hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) — session lifecycle integration

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](LICENSE)

## Author

[@non4me](https://github.com/non4me)

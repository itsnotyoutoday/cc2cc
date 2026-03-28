# CC2CC: Claude Code ↔ Claude Code Communication

**File-based agent-to-agent communication** between Claude Code instances running on the same machine.

> Two Claude Code sessions can't talk to each other. CC2CC fixes that with a file mailbox + MCP push channel.

Extracted from a working multi-agent setup. Built on Claude Code hooks, MCP channels, and plain JSON files.

> **⚠️ Experimental:** CC2CC relies on Claude Code's development channels — an experimental feature not yet publicly stable. You must launch Claude Code with the `--dangerously-load-development-channels` flag for channel push notifications to work. Without it, the MCP server starts but cannot push messages into the session.
>
> Tested with **Claude Code v2.1.86**. Channel API may change in future versions.

## Demo

5 Claude Code agents debating in split panes via cc2cc:

<video src="https://github.com/user-attachments/assets/e578e827-e24a-4b31-9112-964533b2e037" controls width="100%"></video>

## Use Cases

- A **devops agent** and a **coding agent** collaborating on the same project
- A **monitoring agent** that alerts a **main agent** when something breaks
- Two agents with different tool access splitting a complex task
- An always-on agent delegating subtasks to a specialist

## Architecture

```
┌─────────────────┐                              ┌─────────────────┐
│  Claude Code A   │                              │  Claude Code B   │
│  (auto: brave-fox)│                             │  (auto: calm-owl)│
│                  │                              │                  │
│  MCP Server ◄────┼─── to-brave-fox/inbox/ ◄─────┼── send tool     │
│  (polls inbox)   │                              │                  │
│  send tool ──────┼──► to-calm-owl/inbox/ ───────┼──► MCP Server   │
│                  │                              │  (polls inbox)   │
│  Tools:          │    status/                   │  Tools:          │
│  send, broadcast │    brave-fox-heartbeat.json  │  send, broadcast │
│  reply, register │    calm-owl-heartbeat.json   │  reply, register │
│  list_agents     │                              │  list_agents     │
│  whoami          │                              │  whoami          │
└─────────────────┘                              └─────────────────┘
```

**How it works:** Agent A drops a JSON file into an inbox directory. Agent B's MCP server polls that directory, reads the message, and pushes it into B's session as a channel notification. B replies using an MCP tool, which writes a response back into A's inbox. Messages for offline agents wait in the inbox and get delivered on the next session start.

## Quick Install (via prompt)

The easiest way: **paste [this prompt](INSTALL-PROMPT.md) into any Claude Code session** — it will clone, configure, and set up everything automatically.

For manual installation, see below.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (CLI)
- Node.js ≥ 18 (for the MCP channel server)
- Python 3.8+ (for scripts)
- *(Optional)* `watchdog` for real-time inbox watching (`pip install watchdog`)

## Quick Start

### 1. Clone and initialize

```bash
git clone https://github.com/non4me/cc2cc.git
cd cc2cc
pip install -e .
cc2cc init
```

### 2. Configure Claude Code

Add to `~/.claude/settings.json`:

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

That's it. Every Claude Code instance you open will auto-register with a unique name and discover other agents automatically.

### 3. Open two terminals

```bash
# Terminal 1
claude --dangerously-load-development-channels server:cc2cc
# You'll see: [cc2cc] You are brave-fox. No other agents online

# Terminal 2
claude --dangerously-load-development-channels server:cc2cc
# You'll see: [cc2cc] You are calm-owl. Online agents: brave-fox
# Terminal 1 sees: [cc2cc] calm-owl joined
```

> **Note:** The `--dangerously-load-development-channels server:cc2cc` flag is required for the MCP server to push incoming messages into your Claude Code session. Without it, agents can send messages but won't receive them in real time. Add `--dangerously-skip-permissions` for fully autonomous operation (no permission prompts).

### 4. Communicate (from inside Claude Code)

The agent can use MCP tools directly:
- `send(to="brave-fox", text="Hello!")` — send to specific agent
- `broadcast(text="Deploy starting")` — send to all
- `reply(msg_id="msg-xxx", text="Got it")` — reply to a message
- `list_agents()` — see who's online
- `whoami()` — check your name
- `register(name="devops")` — change your name

## CC2CC vs Google A2A

| Feature | Google A2A | CC2CC |
|---------|-----------|-------|
| Transport | HTTP | Filesystem |
| Setup | Service discovery, auth, endpoints | `cc2cc init` |
| Dependencies | HTTP server per agent | Node.js (MCP server only) |
| Offline delivery | Requires message broker | Built-in (files wait in inbox) |
| Same-machine agents | Overkill | Purpose-built |
| Cross-network agents | ✅ | ❌ (same filesystem required) |

CC2CC is not a replacement for A2A. It's for the common case where you have multiple Claude Code instances on the same machine that need to coordinate.

## Repo Structure

```
cc2cc/
├── cc2cc/                      # Python package
│   ├── __init__.py
│   ├── core.py                 # Atomic writes, bridge path, size limits
│   ├── signing.py              # HMAC-SHA256 message signing
│   └── cli.py                  # Unified CLI entry point
├── pyproject.toml              # pip installable package
├── channel/
│   ├── server.mjs           # Unified MCP server (dynamic identity, multi-agent)
│   ├── names.mjs            # Name generation (adjective-animal dictionary)
│   └── package.json
├── scripts/
│   ├── init.py              # Bootstrap the bridge
│   ├── send.py              # Send a message
│   ├── receive.py           # Read pending messages
│   ├── reply.py             # Reply to a message (completes tasks automatically)
│   ├── task.py              # Delegate a task
│   ├── status.py            # Show bridge status
│   ├── validate.py          # Validate message schema
│   └── cleanup.py           # TTL-based cleanup
├── hooks/
│   ├── session_start.py     # SessionStart hook (heartbeat + inbox check)
│   ├── session_end.py       # SessionEnd hook (mark offline)
│   └── inbox_watcher.py     # Optional: watchdog-based real-time delivery
├── services/
│   ├── macos/               # LaunchAgent template (macOS)
│   ├── linux/               # systemd service template (Linux)
│   └── windows/             # Task Scheduler template (Windows)
├── tests/
│   └── test_smoke.py        # Smoke tests
├── docs/
│   ├── SPECIFICATION.md     # Protocol spec, schemas, message lifecycle
│   └── CONFIGURATION.md     # Environment variables, full settings.json examples
├── LICENSE
└── README.md                # ← you are here
```

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | Full support | watchdog or polling, LaunchAgent template |
| Linux | Full support | watchdog or polling, systemd template |
| Windows | Full support | watchdog or polling, Task Scheduler template |

## Limitations

- **Same filesystem required** — both agents must see `~/.cc2cc` (local machine, NFS, or shared volume)
- **No authentication** — any process that can write to the inbox can inject messages. See [Security](#security) below.
- **No encryption** — messages are plaintext JSON
- **No guaranteed ordering** — use `replyTo` for threading
- **Polling latency** — up to 3s delivery delay (use watchdog for near-instant)
- **Experimental MCP feature** — requires `--dangerously-load-development-channels` flag; the channels API may change or be removed

## Security

CC2CC generates an HMAC-SHA256 shared secret during `cc2cc init`. All messages are signed automatically. Recipients verify signatures on read.

The secret is stored at `~/.cc2cc/secret.key`. Protect it:
- `chmod 600 ~/.cc2cc/secret.key` (macOS/Linux)
- Restrict folder permissions (Windows)

Messages from processes without the secret will show `[SIGNATURE INVALID]` in receive output. Unsigned messages still work (backwards compatible) but are not verified.

Additional mitigations:
- Set restrictive permissions: `chmod 700 ~/.cc2cc`
- Only use on single-user machines where you trust all running processes

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

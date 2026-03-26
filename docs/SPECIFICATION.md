# CC2CC Protocol Specification v1.1

## Directory Layout

```
~/.cc2cc/                          # Bridge root (configurable)
├── alpha-to-beta/
│   ├── inbox/                     # Pending messages: alpha → beta
│   └── done/                      # Processed messages (archive)
├── beta-to-alpha/
│   ├── inbox/                     # Pending messages: beta → alpha
│   └── done/                      # Processed messages (archive)
├── status/
│   ├── alpha-heartbeat.json       # Agent Alpha status
│   └── beta-heartbeat.json        # Agent Beta status
├── agent-cards/
│   ├── alpha.json                 # Agent Alpha capabilities
│   └── beta.json                  # Agent Beta capabilities
├── alpha-channel/
│   ├── server.mjs                 # MCP server for Alpha
│   └── package.json
├── beta-channel/
│   ├── server.mjs                 # MCP server for Beta
│   └── package.json
├── hooks/
│   ├── session-start.sh
│   ├── session-end.sh
│   └── inbox-watcher.sh
└── scripts/
    ├── init.sh
    ├── send.py
    ├── receive.sh
    ├── reply.py
    ├── task.py
    ├── status.sh
    ├── validate.py
    └── cleanup.py
```

---

## Message Schema (v1.1)

Every message is a single JSON file named `msg-<uuid>.json`.

```jsonc
{
  // Required fields
  "id": "msg-550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-03-26T22:16:00Z",       // ISO 8601, UTC
  "from": "alpha",                             // Sender agent ID
  "to": "beta",                                // Recipient agent ID
  "type": "message",                           // message | task | response | status
  "content": {
    "text": "Deploy is ready, please review",  // Human-readable content
    "parts": []                                // Reserved for structured data
  },

  // Optional fields
  "priority": "normal",                        // low | normal | high | critical
  "identity": {
    "agent": "alpha",
    "mode": "session"                          // session | heartbeat | cron:<n>
  },
  "task": null,                                // Task object (see below)
  "replyTo": null,                             // Original msg ID for threading
  "ttl": 3600                                  // Seconds until expiry (default: 1h)
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique message ID: `msg-<uuid>` |
| `timestamp` | string | ISO 8601 UTC timestamp |
| `from` | string | Sender agent ID |
| `to` | string | Recipient agent ID |
| `type` | enum | `message` / `task` / `response` / `status` |
| `content` | object | Must contain `text` (string) and `parts` (array) |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `priority` | enum | `normal` | `low` / `normal` / `high` / `critical` |
| `identity` | object | — | Sender identity metadata |
| `task` | object | `null` | Task details (required when type is `task`) |
| `replyTo` | string | `null` | Original message ID for threading |
| `ttl` | integer | `3600` | Seconds until message expires |

---

## Task Object

When `type` is `"task"`, the `task` field is required:

```jsonc
{
  "task": {
    "id": "task-550e8400-e29b-41d4-a716-446655440001",
    "title": "Run test suite",
    "description": "Execute all integration tests and report results",
    "status": "submitted",       // submitted | in-progress | completed | failed
    "result": null               // Filled by recipient on completion
  }
}
```

### Task Status Transitions

```
submitted → in-progress → completed
                        → failed
```

When replying to a task message, the reply script automatically sets `status: "completed"` and fills `result` with the reply text.

---

## Heartbeat Schema

Written to `status/{agent}-heartbeat.json` by session hooks:

```jsonc
{
  "agent": "alpha",
  "timestamp": "2026-03-26T22:16:00Z",
  "session_id": "abc123",          // PID or "none" when offline
  "status": "active",              // active | offline
  "context": "session started"     // Human-readable description
}
```

Heartbeats are overwritten (not appended) on each session start/end. An agent is considered stale if its heartbeat is older than 10 minutes.

---

## Agent Card Schema

Written to `agent-cards/{agent}.json` by `init.sh`:

```jsonc
{
  "name": "Alpha Agent",
  "version": "1.0.0",
  "protocol": "cc2cc/1.1",
  "identity": {
    "agent_id": "alpha",
    "model": "claude-opus-4-6",
    "runtime": "claude-cli",
    "modes": {
      "session": "Interactive session with user",
      "heartbeat": "Autonomous periodic wake (LaunchAgent)"
    }
  },
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "taskDelegation": true,
    "persistent": false
  },
  "skills": ["devops", "code", "monitoring"],
  "availability": "session-based + heartbeat every 5 min",
  "endpoint": "file://~/.cc2cc/beta-to-alpha/inbox/"
}
```

Agent cards are informational — they help agents understand each other's capabilities but are not enforced by the protocol.

---

## Message Lifecycle

### Sending

```
 Sender                    Filesystem                    Recipient
   │                          │                              │
   │  send.py / task.py       │                              │
   ├─────────────────────────►│  Write msg-xxx.json          │
   │                          │  to {sender}-to-{recv}/inbox │
   │                          │                              │
   │                          │  ┌─── Detection ───┐         │
   │                          │  │ MCP server polls │         │
   │                          │  │ every 3 seconds  │         │
   │                          │  │    — OR —        │         │
   │                          │  │ fswatch triggers │         │
   │                          │  │ inbox-watcher.sh │         │
   │                          │  └─────────────────┘         │
   │                          │                              │
   │                          │  MCP channel notification ──►│
   │                          │  (appears inline in session) │
   │                          │                              │
   │                          │  Move to done/ ◄─────────────┤
   │                          │                              │
   │                          │  reply.py ◄──────────────────┤
   │                          │  Write response to           │
   │  ◄──────────────────────│  {recv}-to-{sender}/inbox     │
   │                          │                              │
   │  cleanup.py (periodic)   │                              │
   │  - done/ > 24h: delete   │                              │
   │  - inbox/ > TTL: archive │                              │
```

### Step by Step

**Sending a message:**

1. Agent Alpha calls `send.py alpha beta message "Please review the deploy"`
2. Script writes `msg-<uuid>.json` to `~/.cc2cc/alpha-to-beta/inbox/`
3. Agent Beta's MCP server polls `alpha-to-beta/inbox/` every 3 seconds
4. Server reads the message, sends `notifications/claude/channel` to Claude Code
5. Message appears inline in Beta's session as a `<channel>` tag
6. Server moves the file to `alpha-to-beta/done/`

**Receiving and replying:**

1. Beta sees the channel notification with `msg_id` and content
2. Beta uses the `reply` MCP tool: `reply(msg_id="msg-xxx", text="LGTM, deploying")`
3. MCP server writes response to `beta-to-alpha/inbox/`
4. Alpha's MCP server picks it up on next poll cycle
5. Alpha sees the reply inline

**Task delegation:**

1. Alpha: `task.py alpha beta "Run tests" "Execute integration test suite, report failures"`
2. Beta receives task, executes it, replies with result
3. Reply automatically sets `task.status: "completed"` and `task.result: "..."`

**Offline → Online delivery:**

1. Alpha sends message while Beta is offline
2. Message sits in `alpha-to-beta/inbox/`
3. When Beta starts a session, `session-start.sh` hook reports pending messages
4. Beta's MCP server starts polling, picks up the message immediately

---

## Scaling to N Agents

The bridge scales to any number of agents. For 3 agents (alpha, beta, gamma):

```bash
./scripts/init.sh alpha beta ~/.cc2cc
./scripts/init.sh alpha gamma ~/.cc2cc
./scripts/init.sh beta gamma ~/.cc2cc
```

Each agent gets one MCP server that watches **all** inboxes addressed to it. The server env needs the primary peer for the `reply` tool, but it reads from all `*-to-{SELF}/inbox/` directories.

For N agents, you need N×(N-1)/2 init calls (one per pair).

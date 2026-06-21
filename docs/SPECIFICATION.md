# CC2CC Protocol Specification v1.1

## Directory Layout

```
~/.cc2cc/                          # Bridge root (configurable)
├── secret.key                     # HMAC-SHA256 shared secret
├── server.mjs                     # Unified MCP server (single copy, shared by all agents)
├── to-brave-fox/
│   ├── inbox/                     # Pending messages addressed to brave-fox
│   ├── done/                      # Processed messages (archive)
│   └── receipts/                  # Delivery receipts
├── to-calm-owl/
│   ├── inbox/                     # Pending messages addressed to calm-owl
│   ├── done/                      # Processed messages (archive)
│   └── receipts/                  # Delivery receipts
├── status/
│   ├── brave-fox-heartbeat.json   # Agent brave-fox status
│   └── calm-owl-heartbeat.json    # Agent calm-owl status
├── hooks/
│   ├── session-start.py
│   ├── session-end.py
│   └── inbox-watcher.py
└── scripts/
    ├── init.py
    ├── send.py
    ├── receive.py
    ├── reply.py
    ├── task.py
    ├── status.py
    ├── validate.py
    └── cleanup.py
```

> **Backwards compatibility:** The old `alpha-to-beta/` directory format (v1.x) is no longer created by `cc2cc init`. Existing bridges using the old format will continue to work if the directories are present, but new installs use the `to-{name}/` format.

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
| `hmac` | string | — | HMAC-SHA256 signature (auto-generated when secret.key exists) |

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

Heartbeats are overwritten (not appended) every **5 seconds** by the MCP server. An agent is considered stale if its heartbeat is older than **15 seconds**.

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

The bridge scales to any number of agents with a single init call:

```bash
cc2cc init
```

Each Claude Code instance runs the same `server.mjs` and auto-registers with a unique name on startup. The server polls `to-{self}/inbox/` for incoming messages and discovers peers by scanning `status/*-heartbeat.json` files. Adding a new agent requires no reconfiguration — just open a new Claude Code session.

---

## Receipt Schema

Written to `{sender}-to-{recipient}/receipts/{msg-id}.receipt.json` by the MCP server upon delivery:

```json
{
  "msg_id": "msg-550e8400-...",
  "delivered_at": "2026-03-27T10:30:00.000Z",
  "delivered_to": "beta"
}
```

Receipts confirm that the MCP server successfully pushed the message to the Claude Code session.

---

## Message Signing (HMAC-SHA256)

When `secret.key` exists in the bridge root, all messages include an `hmac` field.
The signature covers all fields except `hmac` itself, serialized as sorted JSON.

Signing is opt-in: bridges initialized without `init.py` can omit the secret.
Recipients that find `secret.key` will verify; those without will skip verification.

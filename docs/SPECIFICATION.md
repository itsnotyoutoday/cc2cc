# CC2CC Protocol Specification

> Version: 3.x (teams + relay) | Date: 2026-06-21

The protocol/schema specification for **CC2CC** — agent-to-agent communication between Claude
Code instances, both **same-machine** (shared file bridge) and **cross-machine** (encrypted
HTTP relay), organized into **teams**.

> Conventions: paths are relative to the **bridge** (`CC2CC_BRIDGE_DIR`, default `~/.cc2cc`).
> "Node" = the MCP server / daemon (`channel/*.mjs`); "Python" = the CLIs + hooks (`cc2cc/*.py`).

---

## 1. Processes

Three processes with distinct lifetimes:

| Process | Lifetime | Role |
|---------|----------|------|
| `channel/server.mjs` (**MCP server**) | one per Claude Code session | exposes the agent tools; owns the agent's identity, inbox consume, and heartbeat. Does **not** talk to the relay hub directly. |
| `channel/daemon.mjs` (**daemon**) | one per host (per bridge) | owns the single relay-hub connection, the bridge file-watcher, and wake-push to MCP servers. Auto-spawned on demand; socket at `<bridge>/daemon.sock`. |
| `relay_hub.py` (**relay hub**) | one per relay deployment | HTTP store-and-forward queue between machines. In-memory; zero-knowledge (ciphertext only). |

The MCP server joins the mesh only after the MCP `initialized` handshake **and** a resolved
identity (`CC2CC_IDENTITY`/`SELF`); otherwise it stays dormant until `register()` is called. In
daemon mode the MCP does no hub I/O or file-watching itself — it connects to the daemon over a
local socket and reacts to `{wake}` pushes.

---

## 2. Directory Layout

```
$CC2CC_BRIDGE_DIR/                  # default ~/.cc2cc
├── secret.key                      # shared secret: HMAC (Python) + AES-256-GCM key source (Node)
├── machine.secret                  # per-machine relay auth secret (0600, trust-on-first-use)
├── to-<name>/
│   ├── inbox/    msg-<uuid>.json    # pending messages for <name>
│   ├── done/                        # processed / archived messages
│   └── receipts/ <msg_id>.receipt.json
├── status/
│   ├── <name>-heartbeat.json        # per-agent presence + rich status
│   └── daemon.json                  # daemon liveness stamp (pid, socket, team, relay)
├── identities/identity-<name>.json  # per-name persistent identity
├── identity.json                    # legacy single-identity fallback (no CC2CC_IDENTITY/SELF)
├── teams.json                       # team registry { "teams": { <name>: {...} } }
├── remote-teams.json                # daemon-maintained cross-machine roster + federated policy
├── outbox/<msg_id>.json             # cross-machine messages awaiting relay
├── tombstones/<team>__<member>.json # revoke records
├── policy.json                      # bridge-level federation policy overrides
├── rules.json                       # notification instruction rules
├── connections.json                # canonical relay config (legacy flat relay.json also read)
├── seen-messages.json               # relay dedup set
└── daemon.sock                      # daemon IPC socket (unix/mac; named pipe on Windows)
```

**Bridge location by scope / OS:**

| Scope | Linux | macOS | Windows |
|-------|-------|-------|---------|
| user | `~/.cc2cc` | `~/.cc2cc` | `%USERPROFILE%\.cc2cc` |
| system-wide | `/var/lib/cc2cc` | `/Library/Application Support/cc2cc` | `C:\ProgramData\cc2cc` |

> **Back-compat:** The mailbox is now `to-<name>/{inbox,done,receipts}`. The legacy mailbox form
> `<a>-to-<b>/` and the legacy room model (`rooms/<id>/to-<name>/inbox/`) are still *read* if
> present, but are **never written** by the current code.

---

## 3. Message Schema

Every message is a single JSON file named `msg-<uuid>.json`.

```jsonc
{
  // Required fields
  "id": "msg-550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-06-21T22:16:00Z",         // ISO 8601, UTC
  "from": "alpha",                              // sender agent name
  "to": "beta",                                 // recipient agent name
  "type": "message",                            // message | task | response | status | interteam
  "content": {
    "text": "Deploy is ready, please review",   // human-readable text, or "ENC:…" on the wire
    "parts": []                                 // reserved for structured data
  },

  // Optional fields
  "priority": "normal",                         // low | normal | high | critical
  "identity": { "agent": "alpha", "mode": "session" },
  "task": null,                                 // task object (see §4); required when type=task
  "replyTo": null,                              // original msg ID for threading
  "ttl": 3600,                                  // seconds until expiry (DEFAULT_TTL = 3600)
  "hmac": "…"                                   // HMAC-SHA256 signature (when secret.key exists)
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique message ID: `msg-<uuid>` |
| `timestamp` | string | ISO 8601 UTC timestamp |
| `from` | string | Sender agent name |
| `to` | string | Recipient agent name |
| `type` | enum | `message` / `task` / `response` / `status` / `interteam` |
| `content` | object | Must contain `text` (string) and `parts` (array) |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `priority` | enum | `normal` | `low` / `normal` / `high` / `critical` |
| `identity` | object | — | Sender identity metadata (`agent`, `mode`) |
| `task` | object | `null` | Task details (required when type is `task`) |
| `replyTo` | string | `null` | Original message ID for threading |
| `ttl` | integer | `3600` | Seconds until message expires |
| `hmac` | string | — | HMAC-SHA256 signature (auto-generated when `secret.key` exists) |

Maximum message size is **1,000,000 bytes** (enforced on write).

### Cross-team / relay variant (`type: "interteam"`)

Cross-team and cross-machine messages carry additional fields:

- `from_team`, `to_team` — the source and destination teams.
- `intent` — `message` | `join_request` | `reply`.
- `to` — set to the destination team's **leader** (local routing only).

On local delivery the relay attaches `_relay_meta: { from_machine, from_team, to_team, lease_id }`.
The hub wraps each relayed message in an envelope:

```jsonc
{ "id": "relay-<uuid>", "timestamp": "…", "from_machine": "…",
  "from_team": "…", "to_team": "…", "message": { … } }
```

---

## 4. Task Object

When `type` is `"task"`, the `task` field is required:

```jsonc
{
  "task": {
    "id": "task-550e8400-e29b-41d4-a716-446655440001",
    "title": "Run test suite",
    "description": "Execute all integration tests and report results",
    "status": "submitted",       // submitted | in-progress | completed | failed
    "result": null               // filled by recipient on completion
  }
}
```

### Task Status Transitions

```
submitted → in-progress → completed
                        → failed
```

When replying to a task message, the `reply` tool automatically emits a `response` and sets
`task.status: "completed"`, filling `task.result` with the reply text.

---

## 5. Heartbeat Schema

Written to `status/<name>-heartbeat.json` (overwritten, not appended):

```jsonc
{
  "agent": "alpha", "name": "alpha",
  "timestamp": "2026-06-21T22:16:00Z", "heartbeat": "2026-06-21T22:16:00Z",
  "session_id": 12345,             // PID, or "none"/0 when offline
  "parent_pid": 12300,
  "status": "active",              // active | offline
  "context": "session started",    // human-readable
  "status_text": "reviewing PR #42", // rich status line (≤120 chars), set via set_status
  "teams": ["cc2cc"]               // teams this agent belongs to
}
```

Heartbeats are refreshed periodically by the MCP server. An agent is considered **offline** after
**15 seconds** without a fresh heartbeat. (`agent`/`timestamp`/`status` are kept alongside
`name`/`heartbeat` for compatibility with older readers.)

---

## 6. Receipt Schema

Written to `to-<recipient>/receipts/<msg_id>.receipt.json` by the MCP server upon delivery:

```json
{
  "msg_id": "msg-550e8400-...",
  "delivered_at": "2026-06-21T10:30:00.000Z",
  "delivered_to": "beta"
}
```

Receipts confirm that the MCP server successfully pushed the message to the Claude Code session.

---

## 7. Identity, Teams, and Policy

### Identity — `identities/identity-<name>.json`

```jsonc
{
  "display_name": "alpha",
  "agent_id": "<uuid>",
  "created": "<ISO8601>",
  "last_seen": "<ISO8601>",
  "teams": ["cc2cc"]
}
```

There is **no role field** — role is derived (see below).

### Team entry (inside `teams.json`)

```jsonc
{
  "name": "nexus",
  "owner_machine": "<machine_id>",
  "leader": "alpha",                 // name, or null
  "succession": ["beta", "gamma"],   // ordered successors
  "admitted": ["alpha", "beta"],
  "revoked": [],
  "rules": {
    "retention_days": 4,
    "admission": "open",             // open | approved
    "sticky_leader": true
  },
  "created": "<ISO8601>",
  "updated": "<ISO8601>"
}
```

- **Roles are derived, not stored.** You are a **leader** of any team whose `leader` is you;
  otherwise you are a **member**. Leadership comes solely from `teams.json`, which is re-read every
  poll (race-free).
- **Admission** is `open` or `approved` (default `open`).
- **Authority:** a machine is authoritative for the identities it hosts; a team's rules are
  administered by its `owner_machine`. *Revoke* (tombstone) removes participation; *member remove*
  deletes the identity.

### `policy.json` defaults

```jsonc
{
  "messages":   { "retention_days": 4, "stale_after_hours": 24, "max_age_days": 5 },
  "teams":      { "default_admission": "open", "sticky_leader": true },
  "identities": { "offline_after_seconds": 15, "expire_days": 30 },
  "directory":  { "active_seconds": 60, "expire_days": 4 },
  "relay":      { "encrypt_required": true }
}
```

---

## 8. MCP Tools

The MCP server exposes **15 tools**. Same-team / cross-team / leader-only constraints are noted.

| Tool | Contract |
|------|----------|
| `whoami` | identity, uptime, bridge dir, online roster, relay status |
| `list_agents` | all known agents (local + remote): online state, `status_text`, teams, derived role |
| `list_teams` | teams with leader, member_count, online_count |
| `send` {to,text,type,priority} | direct, **same-team only** (cross-team blocked → use `send_team`; remote auto-reroutes via `send_team`; offline target rejected) |
| `broadcast` {text,priority} | to online **same-team** members |
| `send_team` {team,text,type,priority} | **cross-team via the target team's leader** (local → leader inbox; remote → outbox for the daemon) |
| `reply` {msg_id,text} | reply to the original sender (auto `response` type if original was a `task`; relays if sender is remote) |
| `check_inbox` | marker only — inbox consumption piggybacks on every tool call |
| `set_status` {status} | rich status line (≤120 chars), surfaced via heartbeat |
| `register` {name} | join (if dormant) or rename; does **not** grant leadership |
| `create_team` {name,admission,retention_days} | caller becomes **leader** |
| `request_join` {team,note} | routes a join request to the team's leader (`intent:"join_request"`) |
| `admit` {team,agent} | **leader-only** — add a member |
| `evict` {team,agent} | **leader-only** — revoke participation + emit a tombstone |
| `register_relay` {hub_url,token,team,enabled} | write relay config + register with a hub |

> The old `peer_channel` server with a single `reply` tool and a `SELF`/`PEER` model is obsolete.

---

## 9. Teams & Routing

- `send` / `broadcast` require a **shared team** with the target.
- `send_team(team, …)` is the **only** cross-team path: it routes to the team's **leader**, who
  forwards to members. Local leader → write to the leader's inbox; remote team → spool to `outbox/`
  for the daemon to relay.
- An identity's teams are seeded at first creation from `CC2CC_TEAM` (comma-separated), else
  `["cc2cc"]`; an existing identity file wins over the env var. The routing / primary team is
  `teams[0]`.
- **Federation (GAB — Global Address Book):** each daemon folds the teams it owns + its registered
  team's policy into the hub heartbeat; pollers store others' policies and roster
  (`name → {status_text, role}`) into `remote-teams.json`. Roles are stamped by the owning machine.
  `cc2cc-admin gab` shows the local members, owned teams, and the remote replica.

---

## 10. Relay Protocol

The hub (`relay_hub.py`, FastAPI, in-memory) is a store-and-forward queue. Endpoints:

| Method · Path | Request (key fields) | Response |
|---|---|---|
| POST `/api/register` | token, machine_id, team, machine_secret? | `{status:"registered", ttl_seconds:30}` |
| POST `/api/send` | token, from_machine, from_team, to_team, message, machine_secret? | `{status:"accepted", message_id}` |
| POST `/api/poll` | machine_id, team, machine_secret?; **Bearer** token header | `{messages:[…lease_id], online_teams, team_policies}` |
| POST `/api/ack` | token, machine_id, acked_ids[], machine_secret? | `{status:"ok", deleted_count}` |
| POST `/api/keepalive` | token, machine_id, team, machine_secret? | `{status:"ok", ttl_seconds:30}` |
| POST `/api/heartbeat` | token, machine_id, team, agents{}, team_policies?, machine_secret? | `{status:"ok"}` |
| GET `/health` | Bearer token (optional) | `{status:"ok"}` (+ counts if authed) |

- **Registration TTL 30 s** (refreshed by keepalive/heartbeat); **lease TTL 30 s**; queue cap
  **1000 / team**; undelivered messages held **5 days**.
- **Routing key** is `"{machine_id}:{team}"`. `send` fans out to all active registrations whose
  `team == to_team`; `poll` drains only the caller's `(machine_id, team)` queue.
- **Auth:** the shared `token` authorizes API access; a per-machine `machine_secret` binds a
  `machine_id` on first use (trust-on-first-use) and is required thereafter — this prevents another
  token holder from draining your queue or spoofing your `machine_id`. **The hub refuses to start
  without a token** (`CC2CC_RELAY_TOKEN` or `--token`).
- **The daemon** owns the hub connection: register (15 s) · poll (3 s) · keepalive+heartbeat (5 s) ·
  outbox drain. It relays already-encrypted ciphertext unchanged — it is **not** the crypto boundary.

---

## 11. Encryption & Signing

- **HMAC-SHA256 (local, Python):** canonical-JSON HMAC over the message (excluding the `hmac`
  field), keyed by `secret.key`; verified on read. Used by the Python CLIs / scripts. Backwards
  compatible — unsigned messages still work, just unverified.
- **AES-256-GCM (relay, Node):** enabled by `CC2CC_ENCRYPT=1`. The key is derived from `secret.key`
  via `scrypt` with a fixed domain-separation salt (`cc2cc-aes-gcm/v2`), so every peer derives the
  same key. Wire format: `ENC:<iv_hex>:<tag_hex>:<ct_hex>` (random 12-byte IV per message).
- **Fail-closed:** with encryption enabled, a relayed message missing the `ENC:` prefix is
  quarantined (never surfaced); decryption failures are dropped; `send_team` to a remote team with
  no key refuses to send; and the relay will not activate without encryption configured. Every peer
  in a relay mesh must share a **byte-identical `secret.key`**. The hub is **zero-knowledge** —
  it only ever sees ciphertext.

---

## 12. Message Lifecycle

### Same-machine: send → deliver → reply

```
 Sender                     Filesystem / daemon            Recipient
   │                              │                            │
   │  send / send_team / reply    │                            │
   ├─────────────────────────────►│  write msg-xxx.json        │
   │                              │  to to-<recipient>/inbox    │
   │                              │                            │
   │                              │  daemon file-watcher detects│
   │                              │  → {wake} push to MCP ─────►│
   │                              │                            │
   │                              │  MCP channel notification ─►│
   │                              │  (appears inline in session)│
   │                              │                            │
   │                              │◄── receipt written ─────────┤
   │                              │   to-<recipient>/receipts/  │
   │                              │◄── moved to done/ ──────────┤
   │  to-<sender>/inbox/msg-yyy  │◄── reply tool call ─────────┤
   │◄─────────────────────────────│                            │
```

### Cross-machine (relay)

1. `send_team` to a **remote** team spools an `interteam` message to `outbox/`.
2. The daemon encrypts (`ENC:…`) and `POST /api/send` to the hub, keyed by `(machine_id, team)`.
3. The destination host's daemon `POST /api/poll` drains its queue, decrypts, and writes to the
   local leader's `to-<leader>/inbox/`; then `POST /api/ack`.
4. The leader's MCP delivers it inline and forwards to local members as needed.

### Offline → online delivery

1. A message sent while the recipient is offline sits in `to-<recipient>/inbox/`.
2. When the recipient starts a session, `session_start.py` reports pending messages.
3. The recipient's MCP server / daemon picks it up immediately. No messages are lost (files persist
   until consumed or expired). Undelivered relay messages are held on the hub for **5 days**.

### Cleanup

- `done/` files older than the retention window → deleted.
- `inbox/` files past their `ttl` → archived.
- Malformed JSON → removed.

---

## 13. Scaling to N Agents

The bridge scales to any number of agents. Each Claude Code instance runs the same `server.mjs`
and registers a unique name on startup; the daemon (one per host) watches `to-<self>/inbox/` for
all agents and owns the single relay connection. Adding a new agent requires no reconfiguration —
just open a new Claude Code session (and, for cross-machine, share `secret.key` + relay config).

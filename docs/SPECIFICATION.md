# CC2CC Specification

The complete, current specification for **CC2CC** — agent-to-agent communication between Claude
Code instances, same-machine (shared file bridge) and cross-machine (encrypted relay), organized
into teams. This is the single source of truth; it supersedes the earlier per-version spec docs.

> Conventions: paths are relative to the **bridge** (`CC2CC_BRIDGE_DIR`, default `~/.cc2cc`).
> "Node" = the MCP server / daemon (`channel/*.mjs`); "Python" = the CLIs + hooks (`cc2cc/*.py`).

---

## 1. Components

Three processes, with distinct lifetimes:

| Process | Lifetime | Role |
|---------|----------|------|
| `channel/server.mjs` (**MCP server**) | one per Claude Code session | exposes the agent tools; owns the agent's identity, inbox consume, and heartbeat. Does **not** talk to the hub directly. |
| `channel/daemon.mjs` (**daemon**) | one per host (per bridge) | owns the single relay-hub connection, the bridge file-watcher, and wake-push to MCPs. Auto-spawned on demand. |
| `relay_hub.py` (**relay hub**) | one per relay deployment | HTTP store-and-forward queue between machines. In-memory; zero-knowledge (ciphertext only). |

The MCP joins the mesh only after the MCP `initialized` handshake **and** a resolved identity
(`CC2CC_IDENTITY`/`SELF`); otherwise it stays dormant until `register()` is called. In daemon mode
the MCP does no hub I/O or file-watching itself — it connects to the daemon over a local socket and
reacts to `{wake}` pushes. `relayActive = daemonMode && relayConfigured`.

---

## 2. Bridge layout

```
$CC2CC_BRIDGE_DIR/                 # default ~/.cc2cc
├── secret.key                     # shared secret: HMAC (Python) + AES-256-GCM key source (Node)
├── machine.secret                 # per-machine relay auth secret (0600, trust-on-first-use)
├── to-<name>/
│   ├── inbox/    msg-<uuid>.json   # pending messages for <name>
│   ├── done/                       # processed/archived messages
│   └── receipts/ <msg_id>.receipt.json
├── status/
│   ├── <name>-heartbeat.json       # per-agent presence + rich status
│   └── daemon.json                 # daemon liveness stamp (pid, socket, team, relay)
├── identities/identity-<name>.json # per-name persistent identity
├── identity.json                   # legacy single-identity fallback (no CC2CC_IDENTITY/SELF)
├── teams.json                      # team registry { "teams": { <name>: {...} } }
├── remote-teams.json               # daemon-maintained cross-machine roster + federated policy
├── outbox/<msg_id>.json            # cross-machine messages awaiting relay
├── tombstones/<team>__<member>.json# revoke records
├── policy.json                     # bridge-level federation policy overrides
├── rules.json                      # notification instruction rules
├── connections.json                # canonical relay config (legacy flat relay.json also read)
├── seen-messages.json              # relay dedup set
└── daemon.sock                     # daemon IPC socket (unix/mac; named pipe on Windows)
```

Bridge location by scope/OS: user → `~/.cc2cc` (Linux/macOS) · `%USERPROFILE%\.cc2cc` (Windows);
system-wide → `/var/lib/cc2cc` (Linux) · `/Library/Application Support/cc2cc` (macOS) ·
`C:\ProgramData\cc2cc` (Windows). The legacy room model (`rooms/<id>/to-<name>/inbox/`) and the
legacy mailbox form `<a>-to-<b>/` are read for back-compat but never written.

---

## 3. Message & heartbeat schemas

**Local message** (`msg-<uuid>.json`):
```jsonc
{
  "id": "msg-<uuid>", "timestamp": "<ISO8601>",
  "from": "<name>", "to": "<name>",
  "type": "message|task|response|status",
  "priority": "low|normal|high|critical",
  "identity": { "agent": "<from>", "mode": "session" },
  "task": null,                       // or { "title": ..., ... } for type=task
  "content": { "text": "<text or ENC:…>", "parts": [] },
  "replyTo": null,                    // or a <msg_id>
  "ttl": 3600                         // seconds (DEFAULT_TTL)
}
```
Max message size is **1,000,000 bytes** (enforced on write).

**Cross-team / relay message** (`type:"interteam"`): adds `from_team`, `to_team`, and
`intent` (`message` | `join_request` | `reply`); `to` is the leader (local only). On delivery the
relay attaches `_relay_meta: { from_machine, from_team, to_team, lease_id }`. The hub wraps each in
`{ id:"relay-<uuid>", timestamp, from_machine, from_team, to_team, message }`.

**Heartbeat** (`status/<name>-heartbeat.json`):
```jsonc
{
  "agent": "<name>", "name": "<name>", "timestamp": "<ISO8601>", "heartbeat": "<ISO8601>",
  "session_id": <pid>, "parent_pid": <pid>,
  "status": "active|offline", "context": "...", "status_text": "<rich status>",
  "teams": ["..."]
}
```
An agent is considered offline after **15 s** without a fresh heartbeat.

---

## 4. Identity, teams, and policy

**`identities/identity-<name>.json`** — `display_name`, `agent_id` (UUID), `created`, `last_seen`,
`teams: []`. There is **no role field**; role is derived.

**Team entry** (inside `teams.json`) — `name`, `owner_machine`, `leader` (name|null),
`succession: []`, `admitted: []`, `revoked: []`, `rules: { retention_days, admission, sticky_leader }`,
`created`, `updated`.

- **Roles** are derived, not stored: you are a **leader** of any team whose `leader` is you,
  otherwise a **member**. Leadership comes solely from `teams.json` (re-read every poll, race-free).
- **Admission** is `open` or `approved` (default `open`).
- **Authority**: a machine is authoritative for the identities it hosts; a team's rules are
  administered by its `owner_machine`. *Revoke* (tombstone) removes participation; *member remove*
  deletes the identity.

**`policy.json`** defaults:
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

## 5. MCP tools

15 tools. Same-team / cross-team / leader-only constraints noted.

| Tool | Contract |
|------|----------|
| `whoami` | identity, uptime, bridge dir, online roster, relay status |
| `list_agents` | all known agents (local + remote): online state, `status_text`, teams, derived role |
| `list_teams` | teams with leader, member_count, online_count |
| `send` {to,text,type,priority} | direct, **same-team only** (cross-team blocked → `send_team`; remote auto-reroutes via `send_team`; offline target rejected) |
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

---

## 6. Teams & routing

- `send` / `broadcast` require a **shared team** with the target.
- `send_team(team, …)` is the **only** cross-team path: it routes to the team's **leader**, who
  forwards to members. Local leader → write to the leader's inbox; remote team → spool to `outbox/`
  for the daemon to relay.
- An identity's teams are seeded at first creation from `CC2CC_TEAM` (comma-separated), else
  `["cc2cc"]`; an existing identity file wins over the env var. The routing/primary team is `teams[0]`.
- **Federation (GAB):** each daemon folds the teams it owns + its registered team's policy into the
  hub heartbeat; pollers store others' policies and roster (`name → {status_text, role}`) into
  `remote-teams.json`. Roles are stamped by the owning machine. `cc2cc-admin gab` shows the local
  members, owned teams, and the remote replica.

---

## 7. Relay protocol

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
  **1000/team**; undelivered messages held **5 days**.
- **Routing key** is `"{machine_id}:{team}"`. `send` fans out to all active registrations whose
  `team == to_team`; `poll` drains only the caller's `(machine_id, team)` queue.
- **Auth:** the shared `token` authorizes API access; a per-machine `machine_secret` binds a
  `machine_id` on first use (trust-on-first-use) and is required thereafter — this prevents another
  token holder from draining your queue or spoofing your `machine_id`. **The hub refuses to start
  without a token** (`CC2CC_RELAY_TOKEN` or `--token`).
- **The daemon** owns the hub connection: register (15 s) · poll (3 s) · keepalive+heartbeat (5 s) ·
  outbox drain. It relays already-encrypted ciphertext unchanged — it is **not** the crypto boundary.

---

## 8. Encryption & signing

- **HMAC-SHA256 (local, Python):** canonical-JSON HMAC over the message (excluding the `hmac` field),
  keyed by `secret.key`; verified on read. Used by the Python CLIs/scripts.
- **AES-256-GCM (relay, Node):** enabled by `CC2CC_ENCRYPT=1`. The key is derived from `secret.key`
  via `scrypt` with a fixed domain-separation salt (`cc2cc-aes-gcm/v2`), so every peer derives the
  same key. Wire format: `ENC:<iv_hex>:<tag_hex>:<ct_hex>` (random 12-byte IV per message).
- **Fail-closed:** with encryption enabled, a relayed message missing the `ENC:` prefix is
  quarantined (never surfaced); decryption failures are dropped; `send_team` to a remote team with
  no key refuses to send; and the relay will not activate without encryption configured. Every peer
  in a relay mesh must share a **byte-identical `secret.key`**.

---

## 9. Configuration (environment variables)

| Variable | Effect |
|----------|--------|
| `CC2CC_BRIDGE_DIR` (alias `BRIDGE_DIR`, Node) | bridge root (default `~/.cc2cc`) |
| `CC2CC_IDENTITY` (aliases `SELF`, `CC2CC_SELF`) | this session's agent name |
| `CC2CC_TEAM` | comma-separated teams seeded into a **new** identity; the daemon's hub-registered team |
| `CC2CC_ENCRYPT` | `=1` enables AES-256-GCM relay encryption (mandatory for relay) |
| `CC2CC_RELAY_TOKEN` | hub auth token (server side) |
| `CC2CC_HUB_TOKEN` · `CC2CC_HUB_PORT` · `CC2CC_HUB_HOST` · `CC2CC_PY` | `starthub.sh` launcher knobs (defaults `PEERTEST` · `10322` · `127.0.0.1` · `python3`) |
| `CC2CC_REMOTE_ACTIVE_MS` · `CC2CC_REMOTE_EXPIRE_MS` | remote-team active/expiry windows (default 60 s / ~4 days) |
| `CC2CC_DEBUG` | log relay poll failures |

> `CC2CC_ROLE` is **not** read by the code — role is derived from `teams.json`, never from the env.

---

## 10. Daemon lifecycle

- Single instance per bridge, enforced by binding `<bridge>/daemon.sock` (named pipe on Windows).
- Spawned on demand by the MCP via `ensureDaemon` (detached, `stdio:"ignore"`). The MCP connects
  with `connectToDaemon`, announces `{hello, agent}`, and reacts to `{wake}` pushes, reconnecting
  with jittered backoff if the daemon restarts.
- The daemon is the **sole** mailbox file-watcher (regex `to-<agent>/inbox/<x>.json`) and the sole
  hub client, so multiple sessions on one host never contend for the relay connection. It can be
  restarted independently of any Claude session; MCPs simply reconnect.

# CC2CC — Full Architecture & Design

> Version: 3.x (teams + relay) | Date: 2026-06-21

## 1. Overview

**CC2CC (Claude Code to Claude Code)** — agent-to-agent communication between multiple Claude
Code instances. It works **same-machine** via a shared file bridge and **cross-machine** via an
encrypted HTTP relay. Agents are organized into **teams**. Messages are JSON files in shared
mailbox directories; cross-machine delivery is a zero-knowledge ciphertext queue.

**Core idea:** Agent A writes a JSON file into a recipient mailbox (`to-<B>/inbox/`). A per-host
**daemon** watching the bridge wakes B's **MCP server**, which pushes the content into B's Claude
Code session as a channel notification. B replies via an MCP tool, which writes a response back
into A's mailbox. For cross-machine peers the daemon encrypts the message and forwards it through
a relay **hub** to the remote host's daemon.

### Key properties
- **Two transports:** local filesystem bridge **and** cross-machine HTTP relay (this is no longer
  same-machine-only).
- **Offline delivery:** messages wait in the inbox until the recipient starts a session; relay
  messages are held on the hub up to 5 days.
- **Atomic writes:** temp file + rename (no partial reads).
- **HMAC-SHA256 signing** for local messages; **AES-256-GCM end-to-end encryption** for relay
  traffic (fail-closed; the hub is zero-knowledge).
- **Teams & derived roles:** agents are scoped to teams; leadership is derived from `teams.json`.
- **Cross-platform:** macOS, Linux, Windows.

### Three-process model

| Process | Lifetime | Role |
|---------|----------|------|
| `channel/server.mjs` (**MCP server**) | one per Claude Code session | exposes the agent tools; owns the agent's identity, inbox consume, and heartbeat. Does **not** talk to the hub directly. |
| `channel/daemon.mjs` (**daemon**) | one per host (per bridge) | owns the single relay-hub connection, the bridge file-watcher, and wake-push to MCP servers. Auto-spawned on demand; socket at `<bridge>/daemon.sock`. |
| `relay_hub.py` (**relay hub**) | one per relay deployment | HTTP store-and-forward queue between machines. In-memory; zero-knowledge (ciphertext only). |

In daemon mode the MCP server does no hub I/O or file-watching itself — it connects to the daemon
over a local socket and reacts to `{wake}` pushes. Multiple sessions on one host therefore never
contend for the relay connection.

---

## 2. Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Python package | `cc2cc/` (Python 3.8+) | Core lib: atomic writes, signing, CLIs (`cc2cc`, `cc2cc-admin`) |
| MCP Server | `channel/server.mjs` (Node.js 18+) | Per-session tool host; consumes inbox, pushes to Claude Code |
| Daemon | `channel/daemon.mjs` (Node.js 18+) | Per-host file-watcher + relay client + wake-push |
| Relay client | `channel/relay.mjs` | Hub HTTP client + AES-256-GCM encrypt/decrypt |
| Relay hub | `relay_hub.py` (FastAPI) | Cross-machine ciphertext queue |
| Scripts | `scripts/*.py` | send, receive, reply, task, status, validate, cleanup, init |
| Hooks | `hooks/*.py` | Claude Code lifecycle integration (SessionStart/End, inbox watcher) |
| Services | `services/` | OS-level daemon templates (launchd, systemd, Task Scheduler) |
| Tests | `tests/` (pytest) | Unit + integration + smoke tests |
| Package | `pyproject.toml` | pip-installable, entry points `cc2cc` + `cc2cc-admin` |

---

## 3. Directory Layout

### Bridge Runtime

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
├── identity.json                    # legacy single-identity fallback
├── teams.json                       # team registry
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

> The mailbox layout is `to-<name>/{inbox,done,receipts}`. The legacy `<a>-to-<b>/` mailbox form
> and per-agent `*-channel/` directories are obsolete — they are read for back-compat but never
> written.

### Repository Layout (Source)

```
cc2cc-teams/                          # Git repo root
├── cc2cc/                            # Python package
│   ├── __init__.py                   # __version__
│   ├── core.py                       # atomic_write(), bridge_path(), MAX_MESSAGE_SIZE
│   ├── signing.py                    # HMAC: generate_secret(), sign_message(), verify_message()
│   ├── cli.py                        # `cc2cc` CLI (init/send/receive/reply/task/status/...)
│   └── admin.py                      # `cc2cc-admin` CLI (members, teams, gab, policy)
├── channel/
│   ├── server.mjs                    # MCP server (per session)
│   ├── daemon.mjs                    # per-host daemon (file-watcher + relay client + wake-push)
│   ├── daemon-client.mjs             # MCP↔daemon socket client
│   ├── relay.mjs                     # hub HTTP client + AES-256-GCM
│   ├── names.mjs                     # name generation
│   ├── templates.mjs                 # channel/instruction templates
│   ├── rules.default.json            # default notification rules
│   └── package.json                  # @modelcontextprotocol/sdk
├── relay_hub.py                      # FastAPI relay hub
├── starthub.sh                       # relay hub launcher
├── scripts/
│   ├── init.py, send.py, receive.py, reply.py, task.py
│   ├── status.py, validate.py, cleanup.py, send_to_room.py
│   ├── cc2cc-install.sh, cc2cc-launch.sh, setup.sh   # install / launch helpers
│   └── default-policy.json
├── hooks/
│   ├── session_start.py, session_end.py, inbox_watcher.py
├── services/
│   ├── macos/com.cc2cc.inbox-watcher.plist
│   ├── linux/cc2cc-watcher.service
│   └── windows/cc2cc-watcher.xml
├── tests/                            # pytest suite
├── conftest.py
├── pyproject.toml
├── connections.example.json
├── docs/
│   ├── SPECIFICATION.md              # Protocol / schema spec
│   ├── CONFIGURATION.md              # Config + setup guide
│   └── ARCHITECTURE.md               # ← This file
├── README.md, CONTRIBUTING.md, LICENSE
```

---

## 4. Python Package (`cc2cc/`)

### 4.1 `core.py` — Atomic Writes & Config

```python
MAX_MESSAGE_SIZE = 1_000_000  # 1 MB hard limit
```

**`bridge_path() -> Path`**
- Reads `CC2CC_BRIDGE_DIR` env var, defaults to `~/.cc2cc`; expands `~`.

**`atomic_write(target: Path, data: dict) -> None`**
- Serializes `data` to JSON (indent=2, ensure_ascii=False).
- Validates size ≤ `MAX_MESSAGE_SIZE` (raises `ValueError` if exceeded).
- Creates parent directories if needed.
- Writes to a temp file (same directory), then `os.replace()` for an atomic rename.
- On any error: deletes the temp file and re-raises. Guarantees: no partial files ever written.

### 4.2 `signing.py` — HMAC-SHA256

**`generate_secret() -> str`** — 32 random bytes → 64-char hex string.

**`sign_message(msg, secret) -> dict`** — returns a **new** dict; canonical form is all fields
except `hmac`, sorted JSON, UTF-8 encoded; HMAC-SHA256 with the secret decoded from hex; adds the
`hmac` field.

**`verify_message(msg, secret) -> bool`** — `False` if `hmac` missing; recomputes the HMAC over the
canonical form and compares with `hmac.compare_digest()` (timing-safe). Detects tampered content,
extra injected fields, and wrong secret.

> `secret.key` does double duty: the Python side uses it directly as the HMAC key, and the Node
> side derives the AES-256-GCM relay key from it via `scrypt`.

### 4.3 CLIs — `cc2cc` and `cc2cc-admin`

Two entry points (via `pyproject.toml` `[project.scripts]`):

- **`cc2cc`** (`cli.py`) — operational commands: `init`, `send`, `receive`, `reply`, `task`,
  `status`, `validate`, `cleanup`.
- **`cc2cc-admin`** (`admin.py`, note the hyphen) — provisioning / administration:
  - `member add|list|remove|revoke` — local member identities (this machine's authority).
  - `team create|list|show|set|leader|succession|admit` — teams this machine owns.
  - `gab` (alias `directory`) — show the federated Global Address Book (local members, owned
    teams, remote replica).
  - `policy show` — show effective federation policy (defaults + `policy.json`).

---

## 5. Message Protocol (summary)

> Full schemas live in `SPECIFICATION.md`. Highlights:

- Every message is a single file `msg-<uuid>.json` written to `to-<recipient>/inbox/`.
- Required: `id`, `timestamp` (ISO 8601 UTC), `from`, `to`, `type`, `content {text, parts}`.
- `type` ∈ `message | task | response | status | interteam`.
- `type:"task"` carries a `task` object (`id`, `title`, `description`, `status`, `result`).
- `type:"interteam"` (cross-team / relay) adds `from_team`, `to_team`, `intent`; `to` is the
  destination team's leader.
- Heartbeats (`status/<name>-heartbeat.json`) carry presence + `status_text` + `teams[]`; an agent
  is offline after **15 s** without a fresh heartbeat.
- Receipts (`to-<recipient>/receipts/<msg_id>.receipt.json`) confirm MCP delivery.

---

## 6. Scripts (`scripts/`)

### 6.1 `init.py` — Bridge Bootstrap
Creates the bridge skeleton (`to-<name>/{inbox,done,receipts}`, `status/`, identity/team files) and
generates `secret.key` if absent. (The modern, end-to-end setup path is `scripts/cc2cc-install.sh`;
see CONFIGURATION.md.)

### 6.2 `send.py` — Send Message
Builds a message (UUID, timestamp, fields from args), signs it with HMAC if `secret.key` exists,
and atomic-writes to `to-<to>/inbox/msg-<uuid>.json`.

### 6.3 `receive.py` — Read Inbox
Scans `to-<agent>/inbox/*.json`; parses JSON, verifies HMAC, prints a summary; without `--peek`
moves the file to `done/` (consume), with `--peek` leaves it.

### 6.4 `reply.py` — Reply to Message
Finds the original message by ID across inbox/done, auto-detects `from`/`to`, completes the task if
the original was a task (`status:"completed"`, `result=text`), signs, and atomic-writes the
response to the sender's `to-<sender>/inbox/`.

### 6.5 `task.py` — Delegate Task
Creates a `type:"task"` message with a task object (`status:"submitted"`), signs, and writes to the
recipient inbox.

### 6.6 `status.py` — Bridge Status
Shows heartbeats (active/stale + age) and mailbox counts per recipient.

### 6.7 `validate.py` — Message Validation
Checks JSON parseable, size ≤ 1 MB, required fields, valid `type`/`priority`, `content.text`
present, task structure, and HMAC validity (when signed). `--fix` removes invalid files.

### 6.8 `cleanup.py` — TTL-Based Cleanup
`done/` files older than the retention window → deleted; `inbox/` files past their `ttl` → archived;
malformed JSON removed. `--dry-run` counts only.

---

## 7. MCP Channel Server (`channel/server.mjs`)

### Technology
- Node.js ES module; `@modelcontextprotocol/sdk`; stdio transport (StdioServerTransport).

### Identity & joining
- One MCP server per Claude Code session. It joins the mesh only after the MCP `initialized`
  handshake **and** a resolved identity (`CC2CC_IDENTITY`/`SELF`); otherwise it stays dormant until
  `register()` is called.
- Identity is persisted in `identities/identity-<name>.json`; teams are seeded from `CC2CC_TEAM`
  (else `["cc2cc"]`) on first creation, with an existing identity file winning over the env var.

### Capabilities & tools
- `experimental: {"claude/channel": {}}` — channel push notifications.
- Exposes the **15 tools** documented in SPECIFICATION.md (`whoami`, `list_agents`, `list_teams`,
  `send`, `broadcast`, `send_team`, `reply`, `check_inbox`, `set_status`, `register`, `create_team`,
  `request_join`, `admit`, `evict`, `register_relay`).

### Delivery & inbox consume
- In daemon mode the MCP does **not** poll the filesystem; it connects to the daemon
  (`connectToDaemon`), announces `{hello, agent}`, and reacts to `{wake}` pushes, reconnecting with
  jittered backoff if the daemon restarts.
- Inbox consumption piggybacks on every tool call (and on wake): the server reads
  `to-<self>/inbox/`, pushes each message as a `notifications/claude/channel`, writes a receipt to
  `to-<self>/receipts/`, and moves the file to `done/`.
- Roles are recomputed from `teams.json` on every poll (race-free), so leadership/membership are
  always current.

### Self-wake, presence, robustness
- **Self-wake:** a fast channel push plus a fallback self-inbox system message boot the agent ~1 s
  after session start so it autonomously checks its inbox.
- **Silent presence:** online/offline events are reflected in the statusline (from heartbeat files),
  not pushed to chat.
- **Orphan cleanup:** stale/`parent_pid`-orphaned heartbeats and their mailbox dirs are removed on
  startup.
- **Cross-platform (Windows):** retry-on-EPERM rename wrapper; synchronous offline heartbeat on
  exit; `os.homedir()` fallback.
- **Logging:** structured JSON to stderr (stdout is the MCP transport).

---

## 8. Daemon (`channel/daemon.mjs`)

- **Single instance per bridge**, enforced by binding `<bridge>/daemon.sock` (named pipe on
  Windows). Spawned on demand by the MCP via `ensureDaemon` (detached, `stdio:"ignore"`).
- **Sole mailbox file-watcher** (regex `to-<agent>/inbox/<x>.json`): on a new file it pushes a
  `{wake}` to the relevant MCP over the socket.
- **Sole hub client:** owns the relay-hub connection so sessions never contend. Loop: register
  (every 15 s) · poll (every 3 s) · keepalive + heartbeat (every 5 s) · outbox drain.
- **Relay boundary:** it forwards already-encrypted ciphertext unchanged; encryption/decryption
  happens via `relay.mjs`. `relayActive = daemonMode && relayConfigured`.
- Writes `status/daemon.json` (pid, socket, team, relay) as a liveness stamp; can be restarted
  independently of any Claude session (MCPs simply reconnect).

### Two modes

- **Ad-hoc** (default; a bare `node channel/daemon.mjs`, auto-spawned by an MCP) — **idle-exits**
  after `CC2CC_DAEMON_IDLE_MS` (default 600000 ms = 10 min) with no MCP connections.
- **Service** (`CC2CC_SERVICE_MODE=1` or `--service`) — **always-on**, no idle-exit. Required for a
  relay / always-reachable node. The installer's `cc2cc-daemon` systemd unit runs in service mode.

> **The hub cannot wake a daemon.** The relay hub is passive store-and-forward — it never initiates
> a connection to a node. So an always-reachable node *must* keep its daemon alive (service mode);
> while a node's daemon is down, inbound messages simply queue on the hub (held ~5 days) until the
> daemon comes back and polls.

### Control

`cc2cc-admin daemon <status|start [--service]|restart|stop>` (thin wrapper over
`node channel/daemon.mjs --status|--start [--service]|--restart|--stop`). On a host without
systemd, `cc2cc-admin daemon start --service` is the always-on equivalent of a service manager.

---

## 9. Relay Hub (`relay_hub.py`)

- FastAPI, in-memory store-and-forward queue; **zero-knowledge** (sees only ciphertext).
- Endpoints: `POST /api/register|send|poll|ack|keepalive|heartbeat`, `GET /health`
  (full request/response contract in SPECIFICATION.md §10).
- Registration TTL **30 s**; lease TTL **30 s**; queue cap **1000/team**; undelivered messages held
  **5 days**. Routing key `"{machine_id}:{team}"`.
- **Auth:** a shared `token` authorizes the API; a per-machine `machine_secret` binds a `machine_id`
  on first use (trust-on-first-use) and is required thereafter. The hub **refuses to start without a
  token** (`CC2CC_RELAY_TOKEN` or `--token`). Launch via `starthub.sh`.

---

## 10. Hooks (`hooks/`)

### `session_start.py`
On session start: drains stdin, resolves the agent name, writes an `active` heartbeat
(`status/<self>-heartbeat.json`), scans `to-<self>/inbox/*.json`, and prints a summary of pending
messages.

### `session_end.py`
Writes an `offline` heartbeat (`session_id:"none"`).

### `inbox_watcher.py`
Optional desktop notifications on new messages. Watchdog mode (event-driven) if `watchdog` is
installed, else 3 s polling. Cross-platform notifications (`osascript`/`notify-send`/`plyer`); a
lock file prevents duplicates.

---

## 11. Message Lifecycle

### 11.1 Same-machine send → deliver → reply
```
Sender                    Filesystem / daemon              Recipient
  │  send / send_team / reply   │                              │
  ├────────────────────────────►│  to-<recipient>/inbox/msg-X  │
  │                             │  daemon watcher → {wake} ────►│
  │                             │  channel notification ──────►│  (inline in session)
  │                             │◄── receipt written ──────────┤  to-<recipient>/receipts/
  │                             │◄── moved to done/ ───────────┤
  │  to-<sender>/inbox/msg-Y    │◄── reply tool call ──────────┤
  │◄────────────────────────────│                              │
```

### 11.2 Cross-machine (relay)
1. `send_team` to a remote team spools an `interteam` message to `outbox/`.
2. The local daemon encrypts (`ENC:…`) and `POST /api/send` to the hub, keyed by `(machine_id, team)`.
3. The remote daemon `POST /api/poll` drains, decrypts, writes to the leader's
   `to-<leader>/inbox/`, then `POST /api/ack`.
4. The leader's MCP delivers inline and forwards to local members.

### 11.3 Offline delivery
Messages sit in `to-<recipient>/inbox/` until the recipient starts a session (`session_start.py`
reports them; the MCP/daemon picks them up immediately). Relay messages are held on the hub for up
to 5 days.

### 11.4 Task lifecycle
`task` (status=submitted) → recipient executes → `reply` sets status=completed + result. (`in-progress`
and `failed` are also valid statuses.)

---

## 12. Security Model

### Local — HMAC-SHA256 signing
- Secret generated at setup: 32 random bytes → hex at `{bridge}/secret.key`.
- All Python scripts sign automatically; the canonical form is sorted JSON of all fields except
  `hmac`; verification uses timing-safe comparison. Unsigned messages still work (just unverified).

### Relay — AES-256-GCM end-to-end encryption
- Enabled by `CC2CC_ENCRYPT=1` (**mandatory for relay**). Key derived from `secret.key` via `scrypt`
  with a fixed domain-separation salt (`cc2cc-aes-gcm/v2`); every peer derives the same key. Wire
  format `ENC:<iv_hex>:<tag_hex>:<ct_hex>` with a random 12-byte IV per message.
- **Fail-closed:** relayed messages missing the `ENC:` prefix are quarantined; decryption failures
  are dropped; `send_team` to a keyless remote team refuses to send; the relay won't activate
  without encryption configured. The hub is **zero-knowledge**.
- Every peer in a relay mesh must share a **byte-identical `secret.key`**.

### Trust & authority
- A machine is authoritative for the identities it hosts; a team's rules are administered by its
  `owner_machine`. Relay API access requires the shared token plus a per-machine `machine_secret`
  (trust-on-first-use) that prevents queue-draining / `machine_id` spoofing.

### Recommended mitigations
- `chmod 600 secret.key machine.secret`, `chmod 700 ~/.cc2cc`. Use relay only over trusted networks
  / TLS-terminated endpoints, with encryption enabled.

---

## 13. Configuration

Environment variables (see CONFIGURATION.md for the full table and setup):
`CC2CC_BRIDGE_DIR` (alias `BRIDGE_DIR`), `CC2CC_IDENTITY` (aliases `SELF`, `CC2CC_SELF`),
`CC2CC_TEAM`, `CC2CC_ENCRYPT`, `CC2CC_RELAY_TOKEN`, `CC2CC_HUB_TOKEN`/`PORT`/`HOST`, `CC2CC_PY`,
`CC2CC_REMOTE_ACTIVE_MS`/`EXPIRE_MS`, `CC2CC_DEBUG`.

> `CC2CC_ROLE` and `PEER` are **not** used: roles are derived from `teams.json`, and there is no
> single peer. The old `SELF`/`PEER`/`peer_channel` model is gone.

MCP config lives in `~/.claude.json` (not `~/.claude/settings.json`). Launch via
`claude --dangerously-load-development-channels server:cc2cc`, or use
`scripts/cc2cc-install.sh` / `cc2cc-launch.sh`. The daemon auto-spawns from the MCP on demand.

---

## 14. Testing

| File | Type | Description |
|------|------|-------------|
| `tests/test_core.py` | Unit | `atomic_write`, `bridge_path`, size limits |
| `tests/test_signing.py` | Unit | secret generation, sign/verify roundtrip, tampering |
| `tests/test_unit.py` | Unit | edge cases, schema validation, Unicode, signing details |
| `tests/test_smoke.py` | Integration | full script execution via subprocess |

Key scenarios: atomic writes (no partial files, dir creation, Unicode), signing (roundtrip,
tampering, wrong secret), message schema validation, send/receive (peek vs consume), reply
(threading + task auto-completion), size limits, hooks (heartbeat + pending reporting), status, and
cleanup. CI runs the pytest suite + lint across an OS × Python matrix.

---

## 15. OS Service Templates

- **macOS — LaunchAgent** (`com.cc2cc.inbox-watcher.plist`): `WatchPaths` on the bridge +
  `ThrottleInterval`.
- **Linux — systemd user service** (`cc2cc-watcher.service`): simple, restart-on-failure.
- **Windows — Task Scheduler** (`cc2cc-watcher.xml`): logon trigger, restart on failure.

> These templates cover the optional inbox watcher. The relay **daemon** normally auto-spawns from
> the MCP and does not require a separate service; `cc2cc-install.sh` can optionally install it as a
> `--user` systemd unit (local scope) or a system service (global scope).

---

## 16. Dependencies

### Runtime
| Dependency | Version | Required | Purpose |
|-----------|---------|----------|---------|
| Python | ≥ 3.8 | Yes | scripts, hooks, CLIs |
| Node.js | ≥ 18 | Yes | MCP server + daemon |
| `@modelcontextprotocol/sdk` | recent | Yes | MCP protocol implementation |
| FastAPI + an ASGI server | recent | Relay only | `relay_hub.py` |
| `watchdog` | any | Optional | real-time inbox watching |
| `plyer` | any | Optional | Windows desktop notifications |

### Development
`pytest` (test runner), `setuptools` ≥ 64 (build backend).

---

## 17. Known Limitations & Design Decisions

1. **Two transports, one secret** — `secret.key` keys both local HMAC and the derived relay AES key;
   all relay peers must share a byte-identical copy.
2. **Relay is fail-closed** — no plaintext is ever placed on the wire or surfaced from it; this
   trades graceful degradation for confidentiality.
3. **Hub is in-memory** — undelivered messages live ≤ 5 days and do not survive a hub restart.
4. **One daemon per host** — enforced by the socket lock; the hub connection is shared across all
   local sessions.
5. **Roles are derived, never stored** — recomputed from `teams.json` each poll; there is no
   `role` field in identities.
6. **`check_inbox` is a marker** — inbox consumption piggybacks on every tool call rather than a
   dedicated poll.
7. **Cross-team only via leaders** — `send_team` always routes through the target team's leader; it
   is the sole cross-team / cross-machine path.
8. **`channelsEnabled` is experimental** — the underlying Claude Code channel feature may change.

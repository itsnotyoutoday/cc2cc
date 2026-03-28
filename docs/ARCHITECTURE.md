# CC2CC — Full Architecture & Specification

> Version: 2.0.0 | Protocol: v1.1 | Date: 2026-03-27

## 1. Overview

**CC2CC (Claude Code to Claude Code)** — file-based agent-to-agent communication system for multiple Claude Code instances on one machine. Messages are plain JSON files in shared directories; delivery is via MCP channel push or polling.

**Core idea:** Agent A writes a JSON file into a shared mailbox directory. Agent B's MCP server detects the file, reads it, and pushes content into B's Claude Code session as a channel notification. B replies via MCP tool, which writes a response back into A's mailbox.

### Key properties
- **Transport:** Filesystem (no HTTP, no network)
- **Same-machine only:** Both agents must see the bridge directory
- **Offline delivery:** Messages wait in inbox until recipient starts a session
- **Atomic writes:** temp file + rename (no partial reads)
- **HMAC-SHA256 signing:** Optional integrity verification
- **Cross-platform:** macOS, Linux, Windows

---

## 2. Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Python package | `cc2cc/` (Python 3.8+) | Core lib: atomic writes, signing, CLI |
| MCP Server | `channel/server.mjs` (Node.js 18+) | Polls inbox, pushes to Claude Code session |
| Scripts | `scripts/*.py` | Send, receive, reply, task, status, validate, cleanup |
| Hooks | `hooks/*.py` | Claude Code lifecycle integration (SessionStart/End) |
| Services | `services/` | OS-level daemon templates (launchd, systemd, Task Scheduler) |
| Tests | `tests/` (pytest) | Unit + integration + smoke tests |
| CI | GitHub Actions | Matrix: {ubuntu, macos, windows} × {Python 3.9, 3.12} |
| Package | `pyproject.toml` | pip-installable, entry point `cc2cc` CLI |

---

## 3. Directory Layout (Bridge Runtime)

After `cc2cc init alpha beta ~/.cc2cc`:

```
~/.cc2cc/                              # Bridge root ($CC2CC_BRIDGE_DIR)
├── secret.key                         # HMAC-SHA256 shared secret (32 bytes hex)
├── alpha-to-beta/
│   ├── inbox/                         # Pending messages: alpha → beta
│   │   └── msg-<uuid>.json
│   ├── done/                          # Processed messages (archive)
│   │   └── msg-<uuid>.json
│   └── receipts/                      # Delivery receipts from MCP server
│       └── msg-<uuid>.receipt.json
├── beta-to-alpha/
│   ├── inbox/                         # Pending messages: beta → alpha
│   ├── done/
│   └── receipts/
├── status/
│   ├── alpha-heartbeat.json           # Agent Alpha heartbeat
│   └── beta-heartbeat.json            # Agent Beta heartbeat
├── alpha-channel/
│   ├── server.mjs                     # MCP server copy for Alpha
│   ├── package.json
│   └── node_modules/                  # npm dependencies
├── beta-channel/
│   ├── server.mjs                     # MCP server copy for Beta
│   ├── package.json
│   └── node_modules/
├── hooks/                             # Copied hook scripts
│   ├── session_start.py
│   ├── session_end.py
│   └── inbox_watcher.py
└── scripts/                           # Copied operational scripts
    ├── send.py, receive.py, reply.py, task.py
    ├── status.py, validate.py, cleanup.py
```

### Repository Layout (Source)

```
cc2cc/                                 # Git repo root
├── cc2cc/                             # Python package
│   ├── __init__.py                    # __version__ = "2.0.0"
│   ├── core.py                        # atomic_write(), bridge_path(), MAX_MESSAGE_SIZE
│   ├── signing.py                     # HMAC: generate_secret(), sign_message(), verify_message()
│   └── cli.py                         # Unified CLI: cc2cc <command>
├── channel/
│   ├── server.mjs                     # MCP channel server (Node.js)
│   └── package.json                   # @modelcontextprotocol/sdk ^1.12.0
├── scripts/
│   ├── init.py                        # Bootstrap bridge
│   ├── send.py                        # Send message
│   ├── receive.py                     # Read pending messages
│   ├── reply.py                       # Reply (auto-completes tasks)
│   ├── task.py                        # Delegate task
│   ├── status.py                      # Show bridge status
│   ├── validate.py                    # Validate message JSON files
│   └── cleanup.py                     # TTL-based cleanup
├── hooks/
│   ├── session_start.py               # SessionStart hook
│   ├── session_end.py                 # SessionEnd hook
│   └── inbox_watcher.py              # Background watcher (watchdog or polling)
├── services/
│   ├── macos/com.cc2cc.inbox-watcher.plist
│   ├── linux/cc2cc-watcher.service
│   └── windows/cc2cc-watcher.xml
├── tests/
│   ├── test_core.py                   # Unit tests for core module
│   ├── test_signing.py                # Unit tests for signing module
│   ├── test_unit.py                   # Extended unit tests + schema validation
│   └── test_smoke.py                  # Integration tests (subprocess-based)
├── conftest.py                        # pytest PYTHONPATH setup
├── pyproject.toml                     # Package config
├── .github/workflows/ci.yml           # CI pipeline
├── docs/
│   ├── SPECIFICATION.md               # Protocol spec
│   ├── CONFIGURATION.md               # Config guide
│   └── ARCHITECTURE.md                # ← This file
├── README.md
├── CONTRIBUTING.md
└── LICENSE                            # MIT
```

---

## 4. Python Package (`cc2cc/`)

### 4.1 `core.py` — Atomic Writes & Config

```python
MAX_MESSAGE_SIZE = 1_000_000  # 1 MB hard limit
```

**`bridge_path() -> Path`**
- Reads `CC2CC_BRIDGE_DIR` env var, defaults to `~/.cc2cc`
- Expands `~` to home directory

**`atomic_write(target: Path, data: dict) -> None`**
- Serializes `data` to JSON (indent=2, ensure_ascii=False)
- Validates size ≤ `MAX_MESSAGE_SIZE` (raises `ValueError` if exceeded)
- Creates parent directories if needed
- Writes to temp file (same directory), then `os.replace()` for atomic rename
- On any error: deletes temp file, re-raises exception
- Guarantees: no partial files ever written

### 4.2 `signing.py` — HMAC-SHA256

**`generate_secret() -> str`**
- 32 random bytes → 64-char hex string

**`sign_message(msg: dict, secret: str) -> dict`**
- Returns a **new** dict (does not mutate original)
- Canonical form: all fields except `hmac`, sorted JSON, UTF-8 encoded
- HMAC-SHA256 with secret decoded from hex
- Adds `hmac` field to the new dict

**`verify_message(msg: dict, secret: str) -> bool`**
- Returns `False` if `hmac` field missing
- Recomputes HMAC over canonical form, uses `hmac.compare_digest()` (timing-safe)
- Detects: tampered content, extra injected fields, wrong secret

### 4.3 `cli.py` — Unified CLI

Entry point: `cc2cc` (via `pyproject.toml` `[project.scripts]`).

Subcommands:
| Command | Delegates to | Description |
|---------|-------------|-------------|
| `cc2cc init <a> <b> [dir]` | `scripts/init.py` | Bootstrap bridge |
| `cc2cc send <from> <to> <type> <text>` | `scripts/send.py` | Send message |
| `cc2cc task <from> <to> <title> <desc>` | `scripts/task.py` | Delegate task |
| `cc2cc reply <msg-id> <text>` | `scripts/reply.py` | Reply to message |
| `cc2cc receive <agent> [--peek]` | `scripts/receive.py` | Read inbox |
| `cc2cc status` | `scripts/status.py` | Bridge status |
| `cc2cc validate [--fix]` | `scripts/validate.py` | Validate messages |
| `cc2cc cleanup [--max-age-hours N] [--dry-run]` | `scripts/cleanup.py` | TTL cleanup |

Implementation: rewrites `sys.argv` and calls each script's `main()` function directly (in-process). `validate` and `cleanup` use `subprocess.run()` instead.

---

## 5. Message Protocol (v1.1)

### 5.1 Message Schema

Every message is a single file: `msg-<uuid>.json`.

```json
{
  "id":        "msg-<uuid>",                    // Required. Unique ID
  "timestamp": "2026-03-27T10:30:00Z",          // Required. ISO 8601 UTC
  "from":      "alpha",                          // Required. Sender agent ID
  "to":        "beta",                           // Required. Recipient agent ID
  "type":      "message",                        // Required. message|task|response|status
  "content":   { "text": "...", "parts": [] },   // Required. text + structured parts
  "priority":  "normal",                         // Optional. low|normal|high|critical
  "identity":  { "agent": "alpha", "mode": "session" }, // Optional
  "task":      null,                             // Optional. Required if type=task
  "replyTo":   null,                             // Optional. Parent msg ID for threading
  "ttl":       3600,                             // Optional. Seconds until expiry
  "hmac":      "..."                             // Optional. HMAC-SHA256 signature
}
```

### 5.2 Required Fields

| Field | Type | Validation |
|-------|------|------------|
| `id` | string | Must start with `msg-` |
| `timestamp` | string | ISO 8601, ends with `Z` (UTC) |
| `from` | string | Sender agent ID |
| `to` | string | Recipient agent ID |
| `type` | enum | `message` / `task` / `response` / `status` |
| `content` | object | Must contain `text` (string) and `parts` (array) |

### 5.3 Task Object

Required when `type == "task"`:

```json
{
  "id":          "task-<uuid>",
  "title":       "Run test suite",
  "description": "Execute all integration tests",
  "status":      "submitted",     // submitted → in-progress → completed|failed
  "result":      null             // Filled on completion
}
```

### 5.4 Heartbeat Schema

File: `status/{agent}-heartbeat.json`. Overwritten (not appended).

```json
{
  "agent":      "alpha",
  "timestamp":  "2026-03-27T10:30:00Z",
  "session_id": "12345",           // PID or "none"
  "status":     "active",          // active | offline
  "context":    "session started"  // Human-readable
}
```

Agent considered stale if heartbeat > **15 seconds** old (server writes every 5s).

### 5.5 Receipt Schema

File: `{sender}-to-{recipient}/receipts/{msg-id}.receipt.json`.

```json
{
  "msg_id":       "msg-<uuid>",
  "delivered_at": "2026-03-27T10:30:00.000Z",
  "delivered_to": "beta"
}
```

Written by MCP server after successful push to Claude Code session.

---

## 6. Scripts (`scripts/`)

### 6.1 `init.py` — Bridge Bootstrap

**Input:** `<agent-a> <agent-b> [bridge-dir]`

**Actions:**
1. Creates mailbox directories for both directions: `{a}-to-{b}/{inbox,done}` and reverse
2. Creates `status/` directory
3. Generates HMAC secret → `secret.key` (skips if already exists)
4. For each agent: copies `server.mjs`, creates `package.json`, runs `npm install`
5. Copies hooks and scripts into bridge directory

### 6.2 `send.py` — Send Message

**Input:** `<from> <to> <type> <content> [priority] [mode]`

**Actions:**
1. Builds message object with UUID, timestamp, fields from args
2. Loads `secret.key` → signs message with HMAC (if secret exists)
3. Atomic-writes to `{from}-to-{to}/inbox/msg-<uuid>.json`

### 6.3 `receive.py` — Read Inbox

**Input:** `<agent> [--peek]`

**Actions:**
1. Scans all `*-to-{agent}/inbox/*.json` directories
2. For each message: parses JSON, verifies HMAC signature, prints summary
3. Without `--peek`: moves file to `done/` (consume mode)
4. With `--peek`: leaves file in inbox (read-only)

### 6.4 `reply.py` — Reply to Message

**Input:** `<msg-id> <text> [from] [mode]`

**Actions:**
1. Searches all `*/inbox/` and `*/done/` for original message by ID
2. Auto-detects `from` and `to` from original message
3. If original was a task: sets `task.status = "completed"`, `task.result = reply_text`
4. Signs and atomic-writes response to `{sender}-to-{recipient}/inbox/`

### 6.5 `task.py` — Delegate Task

**Input:** `<from> <to> <title> <description> [priority] [mode]`

**Actions:**
1. Creates message with `type: "task"` and task object (`status: "submitted"`)
2. Sets `content.text = "Task: {title} — {description}"`
3. Signs and atomic-writes to inbox

### 6.6 `status.py` — Bridge Status

**Input:** (none)

**Output:**
- Heartbeats: `●` (active <10min) / `○` (stale) for each agent, with age
- Mailboxes: pending count + processed count for each direction

### 6.7 `validate.py` — Message Validation

**Input:** `[--fix]`

**Checks:**
- JSON parseable
- Size ≤ 1MB
- Required fields present: `{id, timestamp, from, to, type, content}`
- `type` ∈ `{message, task, response, status}`
- `priority` ∈ `{low, normal, high, critical}` (if present)
- `content` has `text` field
- Task messages have `task` object with `{id, title, status}`
- HMAC signature valid (if secret exists and message is signed)
- `--fix`: removes invalid files

### 6.8 `cleanup.py` — TTL-Based Cleanup

**Input:** `[--max-age-hours N] [--dry-run]`

**Actions:**
1. `done/` directories: removes files older than `max_age_hours` (default: 24h)
2. `inbox/` directories: moves files past their `ttl` field to `done/`
3. Removes malformed JSON files unconditionally
4. `--dry-run`: counts but doesn't delete

---

## 7. MCP Channel Server (`channel/server.mjs`)

### Technology
- Node.js ES module
- `@modelcontextprotocol/sdk ^1.12.0`
- Communicates with Claude Code via stdio (StdioServerTransport)

### Configuration (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_DIR` | `~/.cc2cc` | Bridge root |
| `SELF` | `alpha` | This agent's ID |
| `PEER` | `beta` | Primary peer agent's ID |

### Behavior

**Server Identity:**
- Name: `peer_channel`, version `2.0.0`
- Instructions sent to Claude Code: how to handle channel tags and reply tool

**Capabilities:**
- `experimental: {"claude/channel": {}}` — channel push notifications
- `tools: {}` — exposes reply tool

**Polling Loop (every 3 seconds):**
1. Reads `{PEER}-to-{SELF}/inbox/` directory
2. For each new `.json` file (tracked by `seenFiles` Set):
   - Parses JSON
   - Sends `notifications/claude/channel` with content and metadata (`msg_id`, `priority`, `type`, `from`)
   - Writes delivery receipt to `{PEER}-to-{SELF}/receipts/`
   - Moves file from `inbox/` to `done/`
3. Clears `seenFiles` when size > 500 (memory leak prevention)

**Reply Tool:**
- Name: `reply`
- Input: `{ msg_id: string, text: string, type?: string, priority?: string }`
- Lookup: searches agent's **inbox first**, then **done/** (fixes race where channel push arrives before consumeInbox moves the file)
- Action: builds response message, atomic-writes to `{SELF}-to-{PEER}/inbox/`
- Returns: `"Sent {id} to {PEER}"` or error

**Self-Wake (init step 11):**
- Two-stage mechanism to activate the LLM without user input
- **Fast path (500ms):** direct `server.notification()` channel push
- **Fallback (3000ms):** writes system message to own inbox (skipped if agent already active)
- Result: agent boots ~1s after session start, autonomously calls `check_inbox` / `whoami`

**Silent Agent Status:**
- Agent online/offline events are **not** pushed to chat
- Presence is reflected only in the statusline (reads heartbeat files from disk)

**Orphan Cleanup (parent_pid-based):**
- On startup, `cleanupStaleMailboxes()` scans all heartbeat files
- Heartbeats sharing the same `parent_pid` as the current process are orphans from MCP reconnects (same Claude Code session spawned a new server)
- Orphan heartbeats and their mailbox directories are removed even if not yet stale by time
- Also cleans up stale heartbeats (>15s old) and orphan mailbox dirs with no heartbeat

**Cross-Platform (Windows):**
- `retryRename()` wrapper handles EPERM/EACCES from antivirus file locking (5 retries, 50ms backoff)
- `process.on("exit")` writes offline heartbeat synchronously when SIGTERM is not emitted
- `os.homedir()` fallback when HOME/USERPROFILE are both undefined

**Logging:**
- Structured JSON to stderr (stdout is MCP transport)
- Fields: `ts`, `level`, `server`, `msg`, plus contextual data

---

## 8. Hooks (`hooks/`)

### 8.1 `session_start.py` — SessionStart Hook

**Trigger:** Claude Code session begins.

**Actions:**
1. Drains stdin (hook protocol requirement)
2. Reads `CC2CC_SELF` env (fallback: hostname)
3. Writes heartbeat: `status/{self}-heartbeat.json` with `status: "active"`
4. Scans all `*-to-{self}/inbox/*.json` for pending messages
5. Prints summary: count + preview of each pending message (type, from, first 80 chars)

### 8.2 `session_end.py` — SessionEnd Hook

**Trigger:** Claude Code session ends.

**Actions:**
1. Drains stdin
2. Writes heartbeat with `status: "offline"`, `session_id: "none"`

### 8.3 `inbox_watcher.py` — Background Watcher

**Purpose:** Desktop notifications when messages arrive.

**Modes:**
1. **Watchdog mode** (if `watchdog` package installed): filesystem event-driven, near-instant
2. **Polling mode** (fallback): checks every 3 seconds

**Features:**
- Cross-platform notifications: `osascript` (macOS), `notify-send` (Linux), `plyer` (Windows)
- Lock file in temp directory prevents duplicate notifications (5-minute stale timeout)
- Debounce: 0.3s delay in watchdog mode

---

## 9. Message Lifecycle

### 9.1 Send → Deliver → Reply

```
Alpha                         Filesystem                         Beta
  │                              │                                 │
  │  send.py / task.py           │                                 │
  ├─────────────────────────────►│  alpha-to-beta/inbox/msg-X.json │
  │                              │                                 │
  │                              │◄──── MCP server polls (3s) ─────┤
  │                              │                                 │
  │                              │  channel notification ─────────►│
  │                              │  (inline in Claude Code session) │
  │                              │                                 │
  │                              │◄──── receipt written ───────────┤
  │                              │  alpha-to-beta/receipts/        │
  │                              │                                 │
  │                              │◄──── moved to done/ ────────────┤
  │                              │  alpha-to-beta/done/msg-X.json  │
  │                              │                                 │
  │                              │  reply tool call ───────────────┤
  │  beta-to-alpha/inbox/msg-Y  │◄────────────────────────────────┤
  │◄─────────────────────────────│                                 │
```

### 9.2 Offline Delivery

1. Alpha sends while Beta is offline → message sits in `alpha-to-beta/inbox/`
2. Beta starts session → `session_start.py` reports pending messages
3. Beta's MCP server starts polling → picks up message immediately
4. No messages lost (files persist until consumed or expired)

### 9.3 Task Lifecycle

```
Alpha                              Beta
  │                                  │
  │  task.py (status=submitted)      │
  ├─────────────────────────────────►│
  │                                  │  Receives task
  │                                  │  Executes work
  │                                  │
  │  ◄──────────────────────────────┤  reply.py (status=completed, result="...")
  │                                  │
  │  Sees task completion            │
```

### 9.4 Cleanup Lifecycle

- `done/` files older than 24h (configurable) → deleted
- `inbox/` files past their `ttl` → moved to `done/`
- Malformed JSON → deleted immediately

---

## 10. Security Model

### HMAC Signing
- Secret generated during `cc2cc init`: 32 bytes random → hex
- Stored at `{bridge}/secret.key`
- All scripts load secret and sign messages automatically
- Canonical form for signing: sorted JSON of all fields except `hmac`
- Verification uses `hmac.compare_digest()` (timing-safe comparison)
- Backwards compatible: unsigned messages still work, just not verified

### Limitations
- **No authentication:** Any process with filesystem access can write to inbox
- **No encryption:** Messages are plaintext JSON
- **No access control:** Relies on OS filesystem permissions
- **Single trust domain:** Designed for single-user, single-machine use

### Recommended Mitigations
- `chmod 600 secret.key`, `chmod 700 ~/.cc2cc`
- Only use on trusted single-user machines

---

## 11. Configuration

### Environment Variables

| Variable | Used by | Default | Description |
|----------|---------|---------|-------------|
| `CC2CC_BRIDGE_DIR` | Python scripts, hooks | `~/.cc2cc` | Bridge root |
| `CC2CC_SELF` | Hooks | `$(hostname -s)` | Agent ID |
| `BRIDGE_DIR` | MCP server | `~/.cc2cc` | Bridge root (Node.js) |
| `SELF` | MCP server | `alpha` | Agent ID (Node.js) |
| `PEER` | MCP server | `beta` | Peer agent ID (Node.js) |

### Claude Code Integration (`~/.claude/settings.json`)

Each agent needs:
1. **MCP server:** `peer_channel` pointing to `{agent}-channel/server.mjs`
2. **channelsEnabled:** `true` (experimental feature)
3. **Hooks:** `SessionStart` → `session_start.py`, `SessionEnd` → `session_end.py`

### Scaling to N Agents

For N agents: N×(N-1)/2 init calls (one per pair). Each agent gets one MCP server that watches all its inboxes (`*-to-{SELF}/inbox/`).

---

## 12. Testing

### Test Structure

| File | Type | Count | Description |
|------|------|-------|-------------|
| `test_core.py` | Unit | 5 | `atomic_write`, `bridge_path`, size limits |
| `test_signing.py` | Unit | 5 | Secret generation, sign/verify roundtrip, tampering |
| `test_unit.py` | Unit | ~20 | Edge cases, schema validation, Unicode, signing details |
| `test_smoke.py` | Integration | ~20 | Full script execution via subprocess |
| **Total** | | **~50** | |

### Key Test Scenarios

- **Atomic writes:** no partial files on error, parent dir creation, overwrite, Unicode
- **Signing:** roundtrip, tampering detection, wrong secret, extra fields, nested changes
- **Message schema:** required fields, valid types/priorities, task structure
- **Send/Receive:** file creation, field validation, peek vs consume, move to done
- **Reply:** threading (replyTo), task auto-completion
- **Task:** creation with status=submitted, completion on reply
- **HMAC integration:** signed when secret exists, unsigned without, verified/invalid display
- **Size limit:** oversized rejection (1MB+)
- **Hooks:** heartbeat writing, pending message reporting, offline marking
- **Status:** displays agents and mailbox counts
- **Cleanup:** expired message removal
- **Validate:** all-valid detection

### CI Pipeline

GitHub Actions matrix:
- OS: `ubuntu-latest`, `macos-latest`, `windows-latest`
- Python: `3.9`, `3.12`
- Jobs: `test` (pytest -v) + `lint` (py_compile all scripts)

---

## 13. OS Service Templates

### macOS — LaunchAgent
- File: `com.cc2cc.inbox-watcher.plist`
- Trigger: `WatchPaths` on bridge directory + `ThrottleInterval: 30s`
- Runs: `python3 inbox_watcher.py`

### Linux — systemd user service
- File: `cc2cc-watcher.service`
- Type: simple, restart on failure (10s delay)
- Runs: `python3 inbox_watcher.py`

### Windows — Task Scheduler
- File: `cc2cc-watcher.xml`
- Trigger: user logon
- Runs: `python inbox_watcher.py`
- Restart on failure: 3 attempts, 1-minute interval

---

## 14. Dependencies

### Runtime
| Dependency | Version | Required | Purpose |
|-----------|---------|----------|---------|
| Python | ≥ 3.8 | Yes | Scripts, hooks, CLI |
| Node.js | ≥ 18 | Yes | MCP channel server |
| `@modelcontextprotocol/sdk` | ^1.12.0 | Yes | MCP protocol implementation |
| `watchdog` | any | Optional | Real-time filesystem watching |
| `plyer` | any | Optional | Windows desktop notifications |

### Development
| Dependency | Purpose |
|-----------|---------|
| `pytest` | Test runner |
| `setuptools` ≥ 64 | Build backend |

---

## 15. Known Limitations & Design Decisions

1. **Filesystem-only transport** — no network support by design (same-machine optimization)
2. **No message ordering guarantee** — use `replyTo` field for threading
3. **Polling latency** — up to 3s delay; watchdog reduces to near-instant
4. **`channelsEnabled` is experimental** — Claude Code feature that may change
5. **CLI delegates via `sys.argv` rewrite** — `cli.py` rewrites argv and calls script `main()` functions; `validate` and `cleanup` use subprocess instead (likely for isolation)
6. **MCP server tracks one peer** — reply tool sends to `PEER`, but inbox polling reads from all senders
7. **`seenFiles` Set has cap at 500** — cleared entirely to prevent memory leak in long sessions
8. **No retry mechanism** — if MCP push fails, message stays in inbox but is marked as seen
9. **Receipts are write-only** — no script currently reads or acts on receipt files

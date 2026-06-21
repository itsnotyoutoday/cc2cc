# CC2CC Multiplatform Design Spec

## Goal

Make CC2CC work natively on macOS, Linux, and Windows without requiring bash. All shell scripts → Python. Single code path, zero platform-specific branches in core logic.

## Current State

- 5 Python scripts (send, reply, task, validate, cleanup) — already cross-platform
- 5 bash scripts (init, receive, status, session-start, session-end) — macOS/Linux only
- 1 bash watcher (inbox-watcher.sh) — requires fswatch
- 1 Node.js MCP server (server.mjs) — uses `process.env.HOME` (broken on Windows)
- 1 macOS-only LaunchAgent plist
- 1 bash smoke test
- Docs reference bash-only hook syntax

## Changes

### 1. Delete bash scripts

Remove:
- `scripts/init.sh`
- `scripts/receive.sh`
- `scripts/status.sh`
- `hooks/session-start.sh`
- `hooks/session-end.sh`
- `hooks/inbox-watcher.sh`
- `launchd/com.cc2cc.inbox-watcher.plist`
- `tests/smoke.sh`

Remove `launchd/` directory entirely.

### 2. New Python scripts

#### `scripts/init.py`

Replaces `init.sh`. Same interface: `init.py <agent-a> <agent-b> [bridge-dir]`.

Behavior:
- Create mailbox dirs: `{a}-to-{b}/inbox`, `{a}-to-{b}/done`, reverse
- Create `status/`, `agent-cards/`
- Write agent card JSON for each agent
- Copy `channel/server.mjs` + generate `package.json` for each agent's channel dir
- Run `npm install --silent` in each channel dir (subprocess)
- Copy hooks and scripts into bridge dir
- Print next-steps instructions

No `chmod +x` — unnecessary on Windows, Python files run via `python` command.

#### `scripts/receive.py`

Replaces `receive.sh`. Interface: `receive.py <agent> [--peek]`.

Behavior:
- Glob `{bridge}/*-to-{agent}/inbox/*.json`
- Parse and print summary (from, type, priority, timestamp, content[:200])
- Unless `--peek`: move to `done/`
- Uses `pathlib` for all path operations

#### `scripts/status.py`

Replaces `status.sh`. Interface: `status.py`.

Behavior:
- Read all `status/*-heartbeat.json`, compute age, print status line
- Count files in each `*/inbox/` and `*/done/` directory
- Pure Python, no subprocess calls

#### `hooks/session_start.py`

Replaces `session-start.sh`. Underscore in filename (Python module convention).

Behavior:
- Read and discard stdin (`sys.stdin.read()`) — hook protocol
- Write heartbeat JSON to `status/{self}-heartbeat.json`
- Glob inbox for pending messages, print summary
- Env vars: `CC2CC_SELF`, `CC2CC_BRIDGE_DIR`

#### `hooks/session_end.py`

Replaces `session-end.sh`.

Behavior:
- Read and discard stdin
- Write offline heartbeat JSON
- Env vars: `CC2CC_SELF`, `CC2CC_BRIDGE_DIR`

#### `hooks/inbox_watcher.py`

Replaces `inbox-watcher.sh`. Cross-platform file watcher.

Strategy:
1. Try `watchdog` library (pip install watchdog) — near-instant, cross-platform
2. Fallback: polling loop every 3 seconds (no extra deps)

Notifications (all optional, graceful fallback to stdout):
- macOS: `osascript` via subprocess
- Linux: `notify-send` via subprocess
- Windows: `plyer.notification` if available, else stdout

Lock mechanism: `mkdir` lock dir (atomic on all platforms), 5min staleness check.

### 3. Fix server.mjs

Line 23: `process.env.HOME` → `process.env.HOME || process.env.USERPROFILE`

This is the only change needed — Node.js `path.join` already uses OS-correct separators.

### 4. Tests: `tests/test_smoke.py`

Replaces `tests/smoke.sh`. pytest-compatible.

Structure:
- `@pytest.fixture` creates temp bridge dir, cleans up after
- One test function per original test block (send, receive peek, receive consume, reply, task, task reply, validate, session-start, session-end, status, cleanup)
- Uses `subprocess.run()` to invoke scripts (tests them as CLI tools)
- Uses `tempfile.mkdtemp()` for bridge dir
- Sets `CC2CC_BRIDGE_DIR` env var

### 5. Service templates: `services/`

Replace `launchd/` with `services/` containing templates for all platforms:

- `services/macos/com.cc2cc.inbox-watcher.plist` — LaunchAgent (same as before, updated paths)
- `services/linux/cc2cc-watcher.service` — systemd user unit, calls `inbox_watcher.py`
- `services/windows/cc2cc-watcher.xml` — Task Scheduler XML, calls `inbox_watcher.py`

All templates have `YOUR_USERNAME` / `YOUR_AGENT` placeholders.

### 6. Documentation updates

#### `README.md`
- Platform Support table: all three platforms → "Full support"
- Quick Start: `python scripts/init.py alpha beta` instead of `./scripts/init.sh`
- All command examples use `python` prefix
- Remove "Windows: Not supported" note
- Requirements: remove "Bash 4+" and "fswatch"

#### `docs/CONFIGURATION.md`
- Hook examples use `env` field instead of bash env syntax:
  ```json
  {
    "type": "command",
    "command": "python ~/.cc2cc/hooks/session_start.py",
    "env": { "CC2CC_SELF": "alpha", "CC2CC_BRIDGE_DIR": "~/.cc2cc" }
  }
  ```
- Add Windows-specific notes (USERPROFILE, Task Scheduler)
- Replace Linux Alternatives section with cross-platform watcher docs

### 7. CI update

`.github/workflows/ci.yml` — update to run `pytest tests/` instead of `bash tests/smoke.sh`. Add matrix for `os: [ubuntu-latest, macos-latest, windows-latest]`.

## Dependencies

**Required (unchanged):**
- Python 3.8+
- Node.js ≥ 18

**Optional (new):**
- `watchdog` — cross-platform filesystem watcher (faster than polling)
- `plyer` — Windows desktop notifications

No new required dependencies.

## Non-goals

- Network transport (stays file-based)
- Authentication / encryption
- GUI installer
- pip package / PyPI distribution

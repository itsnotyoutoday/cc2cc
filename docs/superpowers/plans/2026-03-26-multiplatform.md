# CC2CC Multiplatform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all bash scripts with Python so CC2CC works natively on macOS, Linux, and Windows.

**Architecture:** Every `.sh` script becomes a `.py` equivalent with identical CLI interface. Uses `pathlib` for paths, `json` stdlib for I/O, `subprocess` only for npm and notifications. Zero new required dependencies.

**Tech Stack:** Python 3.8+ (stdlib only for core), Node.js ≥ 18 (MCP server), pytest (tests). Optional: watchdog, plyer.

**Working directory:** `D:\github\cc2cc`

---

### Task 1: Core scripts — init.py, receive.py, status.py

**Files:**
- Create: `scripts/init.py`
- Create: `scripts/receive.py`
- Create: `scripts/status.py`
- Delete: `scripts/init.sh`
- Delete: `scripts/receive.sh`
- Delete: `scripts/status.sh`

- [ ] **Step 1: Write `scripts/init.py`**

```python
#!/usr/bin/env python3
"""Initialize CC2CC bridge between two agents."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def main():
    if len(sys.argv) < 3:
        print("Usage: init.py <agent-a> <agent-b> [bridge-dir]", file=sys.stderr)
        sys.exit(1)

    agent_a = sys.argv[1]
    agent_b = sys.argv[2]
    bridge = Path(sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser("~/.cc2cc"))
    repo_dir = Path(__file__).resolve().parent.parent

    print(f"Initializing CC2CC bridge: {agent_a} ↔ {agent_b} at {bridge}")

    # Mailboxes
    for a, b in [(agent_a, agent_b), (agent_b, agent_a)]:
        (bridge / f"{a}-to-{b}" / "inbox").mkdir(parents=True, exist_ok=True)
        (bridge / f"{a}-to-{b}" / "done").mkdir(parents=True, exist_ok=True)

    # Status & agent cards
    (bridge / "status").mkdir(parents=True, exist_ok=True)
    (bridge / "agent-cards").mkdir(parents=True, exist_ok=True)

    for agent in [agent_a, agent_b]:
        peer = agent_b if agent == agent_a else agent_a
        card = {
            "name": agent,
            "version": "1.0.0",
            "protocol": "cc2cc/1.1",
            "identity": {
                "agent_id": agent,
                "runtime": "claude-cli",
                "modes": {
                    "session": "Interactive session with user",
                    "heartbeat": "Autonomous periodic wake",
                },
            },
            "capabilities": {"taskDelegation": True, "persistent": False},
            "endpoint": f"file://{bridge}/{peer}-to-{agent}/inbox/",
        }
        (bridge / "agent-cards" / f"{agent}.json").write_text(
            json.dumps(card, indent=2), encoding="utf-8"
        )

    # MCP channel servers
    for agent in [agent_a, agent_b]:
        ch_dir = bridge / f"{agent}-channel"
        ch_dir.mkdir(parents=True, exist_ok=True)

        server_src = repo_dir / "channel" / "server.mjs"
        if server_src.exists():
            shutil.copy2(server_src, ch_dir / "server.mjs")
        else:
            print(f"Warning: channel/server.mjs not found, skipping MCP server for {agent}")

        pkg = {
            "name": f"cc2cc-channel-{agent}",
            "version": "1.1.0",
            "type": "module",
            "dependencies": {"@modelcontextprotocol/sdk": "^1.12.0"},
        }
        (ch_dir / "package.json").write_text(
            json.dumps(pkg, indent=2), encoding="utf-8"
        )

        print(f"Installing MCP dependencies for {agent}...")
        try:
            subprocess.run(
                ["npm", "install", "--silent"],
                cwd=str(ch_dir),
                check=True,
                capture_output=True,
            )
        except (subprocess.CalledProcessError, FileNotFoundError):
            print(f"Warning: npm install failed for {agent} (is Node.js installed?)")

    # Copy hooks
    hooks_dst = bridge / "hooks"
    hooks_dst.mkdir(parents=True, exist_ok=True)
    for hook in ["session_start.py", "session_end.py", "inbox_watcher.py"]:
        src = repo_dir / "hooks" / hook
        if src.exists():
            shutil.copy2(src, hooks_dst / hook)

    # Copy scripts
    scripts_dst = bridge / "scripts"
    scripts_dst.mkdir(parents=True, exist_ok=True)
    for script in ["send.py", "receive.py", "reply.py", "task.py", "status.py", "validate.py", "cleanup.py"]:
        src = repo_dir / "scripts" / script
        if src.exists():
            shutil.copy2(src, scripts_dst / script)

    print(f"\nBridge initialized at {bridge}\n")
    print("Next steps:")
    print("  1. Add MCP server + hooks to each agent's ~/.claude/settings.json")
    print("  2. See docs/CONFIGURATION.md for full settings.json examples")
    print("  3. (Optional) Set up service for auto-wake: see services/")
    print(f"\nQuick test:")
    print(f"  python {bridge}/scripts/send.py {agent_a} {agent_b} message \"Hello from {agent_a}\"")
    print(f"  python {bridge}/scripts/status.py")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write `scripts/receive.py`**

```python
#!/usr/bin/env python3
"""Read pending messages from the CC2CC inbox."""

import json
import os
import shutil
import sys
from pathlib import Path


def main():
    if len(sys.argv) < 2:
        print("Usage: receive.py <agent> [--peek]", file=sys.stderr)
        sys.exit(1)

    agent = sys.argv[1]
    peek = "--peek" in sys.argv
    bridge = Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))

    for inbox in bridge.glob(f"*-to-{agent}/inbox"):
        for fp in sorted(inbox.glob("*.json")):
            try:
                msg = json.loads(fp.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue

            print(f"From: {msg['from']}  Type: {msg['type']}  Priority: {msg.get('priority', 'normal')}")
            print(f"Time: {msg['timestamp']}")
            print(f"Content: {msg['content']['text'][:200]}")
            if msg.get("task"):
                print(f"Task: {msg['task']['title']} [{msg['task']['status']}]")
            print("---")

            if not peek:
                done_dir = inbox.parent / "done"
                done_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(fp), str(done_dir / fp.name))


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Write `scripts/status.py`**

```python
#!/usr/bin/env python3
"""Show CC2CC bridge status."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path


def format_age(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.0f}s ago"
    if seconds < 3600:
        return f"{seconds / 60:.0f}m ago"
    if seconds < 86400:
        return f"{seconds / 3600:.1f}h ago"
    return f"{seconds / 86400:.1f}d ago"


def main():
    bridge = Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))

    print("=== CC2CC Bridge Status ===\n")

    # Heartbeats
    status_dir = bridge / "status"
    if status_dir.exists():
        for hb_path in sorted(status_dir.glob("*-heartbeat.json")):
            try:
                hb = json.loads(hb_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue

            ts = datetime.fromisoformat(hb["timestamp"].replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - ts).total_seconds()
            indicator = "\u25cf" if age < 600 else "\u25cb"
            print(f"{indicator} {hb['agent']}: {hb['status']} ({format_age(age)})")
            if hb.get("context"):
                print(f"  Context: {hb['context']}")

    print()

    # Mailboxes
    for inbox in sorted(bridge.glob("*/inbox")):
        if not inbox.is_dir():
            continue
        name = inbox.parent.name
        inbox_count = len(list(inbox.glob("*.json")))
        done_dir = inbox.parent / "done"
        done_count = len(list(done_dir.glob("*.json"))) if done_dir.exists() else 0
        print(f"{name}: {inbox_count} pending, {done_count} processed")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Delete old bash scripts**

```bash
cd D:/github/cc2cc
git rm scripts/init.sh scripts/receive.sh scripts/status.sh
```

- [ ] **Step 5: Run quick sanity check**

```bash
cd D:/github/cc2cc
python scripts/init.py --help 2>&1 || true
python scripts/receive.py --help 2>&1 || true
python scripts/status.py --help 2>&1 || true
python -m py_compile scripts/init.py
python -m py_compile scripts/receive.py
python -m py_compile scripts/status.py
```

Expected: each prints usage, no syntax errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/init.py scripts/receive.py scripts/status.py
git commit -m "feat: rewrite init, receive, status scripts in Python"
git push
```

---

### Task 2: Hooks — session_start.py, session_end.py, inbox_watcher.py

**Files:**
- Create: `hooks/session_start.py`
- Create: `hooks/session_end.py`
- Create: `hooks/inbox_watcher.py`
- Delete: `hooks/session-start.sh`
- Delete: `hooks/session-end.sh`
- Delete: `hooks/inbox-watcher.sh`

- [ ] **Step 1: Write `hooks/session_start.py`**

```python
#!/usr/bin/env python3
"""CC2CC SessionStart hook — write heartbeat, check inbox."""

import json
import os
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path


def main():
    # Drain stdin (hook protocol)
    sys.stdin.read()

    self_id = os.environ.get("CC2CC_SELF", socket.gethostname().split(".")[0])
    bridge = Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))

    # Write heartbeat
    status_dir = bridge / "status"
    status_dir.mkdir(parents=True, exist_ok=True)
    heartbeat = {
        "agent": self_id,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "session_id": str(os.getpid()),
        "status": "active",
        "context": "session started",
    }
    (status_dir / f"{self_id}-heartbeat.json").write_text(
        json.dumps(heartbeat, indent=2), encoding="utf-8"
    )

    # Check inbox
    pending = 0
    output_lines = []
    for fp in bridge.glob(f"*-to-{self_id}/inbox/*.json"):
        pending += 1
        try:
            msg = json.loads(fp.read_text(encoding="utf-8"))
            sender = msg["from"]
            mtype = msg["type"]
            text = msg["content"]["text"][:80]
            output_lines.append(f"  - [{mtype}] from {sender}: {text}")
        except (json.JSONDecodeError, KeyError, OSError):
            output_lines.append("  - [unknown] unreadable message")

    if pending > 0:
        print(f"CC2CC: {pending} pending message(s) in inbox:")
        print("\n".join(output_lines))
    else:
        print("CC2CC: No pending messages. Bridge active.")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write `hooks/session_end.py`**

```python
#!/usr/bin/env python3
"""CC2CC SessionEnd hook — mark agent offline."""

import json
import os
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path


def main():
    # Drain stdin (hook protocol)
    sys.stdin.read()

    self_id = os.environ.get("CC2CC_SELF", socket.gethostname().split(".")[0])
    bridge = Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))

    status_dir = bridge / "status"
    status_dir.mkdir(parents=True, exist_ok=True)
    heartbeat = {
        "agent": self_id,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "session_id": "none",
        "status": "offline",
        "context": "session ended",
    }
    (status_dir / f"{self_id}-heartbeat.json").write_text(
        json.dumps(heartbeat, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Write `hooks/inbox_watcher.py`**

```python
#!/usr/bin/env python3
"""CC2CC cross-platform inbox watcher with optional watchdog support."""

import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

POLL_INTERVAL = 3  # seconds


def get_inbox_dirs(bridge: Path, self_id: str) -> list:
    return [d for d in bridge.glob(f"*-to-{self_id}/inbox") if d.is_dir()]


def count_messages(dirs: list) -> int:
    return sum(len(list(d.glob("*.json"))) for d in dirs)


def notify(count: int):
    """Send desktop notification. Best-effort, never raises."""
    msg = f"{count} message(s) in CC2CC inbox"
    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.run(
                ["osascript", "-e", f'display notification "{msg}" with title "CC2CC" sound name "Submarine"'],
                capture_output=True, timeout=5,
            )
        elif system == "Linux":
            subprocess.run(["notify-send", "CC2CC", msg], capture_output=True, timeout=5)
        elif system == "Windows":
            try:
                from plyer import notification
                notification.notify(title="CC2CC", message=msg, timeout=5)
            except ImportError:
                print(f"CC2CC: {msg}")
        else:
            print(f"CC2CC: {msg}")
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        print(f"CC2CC: {msg}")


def acquire_lock(self_id: str) -> bool:
    lock_dir = Path(tempfile.gettempdir()) / f"cc2cc-watcher-{self_id}.lock"
    if lock_dir.exists():
        age = time.time() - lock_dir.stat().st_mtime
        if age < 300:
            return False
        shutil.rmtree(lock_dir, ignore_errors=True)
    try:
        lock_dir.mkdir()
        return True
    except OSError:
        return False


def release_lock(self_id: str):
    lock_dir = Path(tempfile.gettempdir()) / f"cc2cc-watcher-{self_id}.lock"
    shutil.rmtree(lock_dir, ignore_errors=True)


def poll_loop(bridge: Path, self_id: str):
    """Fallback polling loop."""
    dirs = get_inbox_dirs(bridge, self_id)
    if not dirs:
        print(f"No inbox dirs found for {self_id}", file=sys.stderr)
        sys.exit(1)

    print(f"Watching {len(dirs)} inbox(es) for {self_id} (polling every {POLL_INTERVAL}s)")
    prev_count = 0

    while True:
        count = count_messages(dirs)
        if count > 0 and count != prev_count:
            if acquire_lock(self_id):
                try:
                    notify(count)
                finally:
                    release_lock(self_id)
        prev_count = count
        time.sleep(POLL_INTERVAL)


def watchdog_loop(bridge: Path, self_id: str):
    """Use watchdog library for near-instant detection."""
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler

    dirs = get_inbox_dirs(bridge, self_id)
    if not dirs:
        print(f"No inbox dirs found for {self_id}", file=sys.stderr)
        sys.exit(1)

    class InboxHandler(FileSystemEventHandler):
        def on_created(self, event):
            if event.src_path.endswith(".json"):
                time.sleep(0.3)  # debounce
                if acquire_lock(self_id):
                    try:
                        count = count_messages(dirs)
                        if count > 0:
                            notify(count)
                    finally:
                        release_lock(self_id)

    observer = Observer()
    handler = InboxHandler()
    for d in dirs:
        observer.schedule(handler, str(d), recursive=False)

    print(f"Watching {len(dirs)} inbox(es) for {self_id} (watchdog)")
    observer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


def main():
    self_id = os.environ.get("CC2CC_SELF")
    if not self_id:
        print("Error: set CC2CC_SELF environment variable", file=sys.stderr)
        sys.exit(1)

    bridge = Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))

    try:
        import watchdog
        watchdog_loop(bridge, self_id)
    except ImportError:
        poll_loop(bridge, self_id)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Delete old bash hooks and launchd/**

```bash
cd D:/github/cc2cc
git rm hooks/session-start.sh hooks/session-end.sh hooks/inbox-watcher.sh
git rm -r launchd/
```

- [ ] **Step 5: Compile check**

```bash
cd D:/github/cc2cc
python -m py_compile hooks/session_start.py
python -m py_compile hooks/session_end.py
python -m py_compile hooks/inbox_watcher.py
```

- [ ] **Step 6: Commit**

```bash
git add hooks/session_start.py hooks/session_end.py hooks/inbox_watcher.py
git commit -m "feat: rewrite hooks in Python, remove launchd"
git push
```

---

### Task 3: Fix server.mjs + service templates

**Files:**
- Modify: `channel/server.mjs:23`
- Create: `services/macos/com.cc2cc.inbox-watcher.plist`
- Create: `services/linux/cc2cc-watcher.service`
- Create: `services/windows/cc2cc-watcher.xml`

- [ ] **Step 1: Fix `channel/server.mjs` HOME path**

Change line 23 from:
```js
const BRIDGE_DIR = process.env.BRIDGE_DIR || `${process.env.HOME}/.cc2cc`;
```
to:
```js
const BRIDGE_DIR = process.env.BRIDGE_DIR || `${process.env.HOME || process.env.USERPROFILE}/.cc2cc`;
```

- [ ] **Step 2: Create `services/macos/com.cc2cc.inbox-watcher.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cc2cc.inbox-watcher</string>
    <key>ProgramArguments</key>
    <array>
        <string>python3</string>
        <string>/Users/YOUR_USERNAME/.cc2cc/hooks/inbox_watcher.py</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CC2CC_SELF</key>
        <string>YOUR_AGENT</string>
        <key>CC2CC_BRIDGE_DIR</key>
        <string>/Users/YOUR_USERNAME/.cc2cc</string>
    </dict>
    <key>WatchPaths</key>
    <array>
        <string>/Users/YOUR_USERNAME/.cc2cc</string>
    </array>
    <key>ThrottleInterval</key>
    <integer>30</integer>
</dict>
</plist>
```

- [ ] **Step 3: Create `services/linux/cc2cc-watcher.service`**

```ini
[Unit]
Description=CC2CC Inbox Watcher
After=network.target

[Service]
Type=simple
Environment=CC2CC_SELF=YOUR_AGENT
Environment=CC2CC_BRIDGE_DIR=%h/.cc2cc
ExecStart=/usr/bin/python3 %h/.cc2cc/hooks/inbox_watcher.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

- [ ] **Step 4: Create `services/windows/cc2cc-watcher.xml`**

```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>CC2CC Inbox Watcher</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Actions>
    <Exec>
      <Command>python</Command>
      <Arguments>C:\Users\YOUR_USERNAME\.cc2cc\hooks\inbox_watcher.py</Arguments>
    </Exec>
  </Actions>
  <Settings>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
</Task>
```

- [ ] **Step 5: Commit**

```bash
git add channel/server.mjs services/
git commit -m "fix: server.mjs Windows HOME, add cross-platform service templates"
git push
```

---

### Task 4: Tests — test_smoke.py

**Files:**
- Create: `tests/test_smoke.py`
- Delete: `tests/smoke.sh`

- [ ] **Step 1: Write `tests/test_smoke.py`**

```python
#!/usr/bin/env python3
"""CC2CC smoke tests — cross-platform, pytest-compatible."""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

REPO_DIR = Path(__file__).resolve().parent.parent


@pytest.fixture
def bridge(tmp_path):
    """Create a temporary bridge directory with basic structure."""
    for pair in [("alpha", "beta"), ("beta", "alpha")]:
        (tmp_path / f"{pair[0]}-to-{pair[1]}" / "inbox").mkdir(parents=True)
        (tmp_path / f"{pair[0]}-to-{pair[1]}" / "done").mkdir(parents=True)
    (tmp_path / "status").mkdir()
    (tmp_path / "agent-cards").mkdir()
    return tmp_path


def run_script(name: str, args: list, bridge_dir: Path, env_extra: dict = None) -> subprocess.CompletedProcess:
    """Run a script from the repo."""
    script = REPO_DIR / name
    cmd = [sys.executable, str(script)] + args
    env = {**os.environ, "CC2CC_BRIDGE_DIR": str(bridge_dir)}
    if env_extra:
        env.update(env_extra)
    return subprocess.run(cmd, capture_output=True, text=True, env=env)


class TestSend:
    def test_creates_message_file(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello from alpha"], bridge)
        files = list((bridge / "alpha-to-beta" / "inbox").glob("msg-*.json"))
        assert len(files) == 1

    def test_message_fields(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello from alpha"], bridge)
        fp = next((bridge / "alpha-to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        assert msg["from"] == "alpha"
        assert msg["to"] == "beta"
        assert msg["type"] == "message"
        assert msg["content"]["text"] == "Hello from alpha"


class TestReceive:
    def test_peek_preserves_file(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello"], bridge)
        result = run_script("scripts/receive.py", ["beta", "--peek"], bridge)
        assert "alpha" in result.stdout
        assert len(list((bridge / "alpha-to-beta" / "inbox").glob("*.json"))) == 1

    def test_consume_moves_to_done(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello"], bridge)
        run_script("scripts/receive.py", ["beta"], bridge)
        assert len(list((bridge / "alpha-to-beta" / "inbox").glob("*.json"))) == 0
        assert len(list((bridge / "alpha-to-beta" / "done").glob("*.json"))) == 1


class TestReply:
    def test_reply_creates_response(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello"], bridge)
        msg_file = next((bridge / "alpha-to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(msg_file.read_text(encoding="utf-8"))
        msg_id = msg["id"]
        run_script("scripts/reply.py", [msg_id, "Got it!", "beta"], bridge)
        replies = list((bridge / "beta-to-alpha" / "inbox").glob("msg-*.json"))
        assert len(replies) == 1
        reply = json.loads(replies[0].read_text(encoding="utf-8"))
        assert reply["replyTo"] == msg_id
        assert reply["type"] == "response"


class TestTask:
    def test_task_creation(self, bridge):
        run_script("scripts/task.py", ["alpha", "beta", "Run tests", "Execute integration tests"], bridge)
        files = list((bridge / "alpha-to-beta" / "inbox").glob("msg-*.json"))
        assert len(files) == 1
        msg = json.loads(files[0].read_text(encoding="utf-8"))
        assert msg["type"] == "task"
        assert msg["task"]["status"] == "submitted"
        assert msg["task"]["title"] == "Run tests"

    def test_task_reply_completes(self, bridge):
        run_script("scripts/task.py", ["alpha", "beta", "Run tests", "Execute tests"], bridge)
        task_file = next((bridge / "alpha-to-beta" / "inbox").glob("msg-*.json"))
        task_msg = json.loads(task_file.read_text(encoding="utf-8"))
        # Move to done so reply can find it
        done_dir = bridge / "alpha-to-beta" / "done"
        task_file.rename(done_dir / task_file.name)
        run_script("scripts/reply.py", [task_msg["id"], "All 42 tests passed", "beta"], bridge)
        replies = list((bridge / "beta-to-alpha" / "inbox").glob("msg-*.json"))
        assert len(replies) == 1
        reply = json.loads(replies[0].read_text(encoding="utf-8"))
        assert reply["task"]["status"] == "completed"
        assert reply["task"]["result"] == "All 42 tests passed"


class TestValidate:
    def test_all_valid(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Test"], bridge)
        result = run_script("scripts/validate.py", [], bridge)
        assert "Invalid: 0" in result.stdout


class TestHooks:
    def test_session_start_heartbeat(self, bridge):
        run_script("hooks/session_start.py", [], bridge, env_extra={"CC2CC_SELF": "alpha"})
        hb_file = bridge / "status" / "alpha-heartbeat.json"
        assert hb_file.exists()
        hb = json.loads(hb_file.read_text(encoding="utf-8"))
        assert hb["status"] == "active"

    def test_session_start_reports_pending(self, bridge):
        run_script("scripts/send.py", ["beta", "alpha", "message", "Hey alpha"], bridge)
        result = run_script("hooks/session_start.py", [], bridge, env_extra={"CC2CC_SELF": "alpha"})
        assert "1 pending" in result.stdout

    def test_session_end_offline(self, bridge):
        run_script("hooks/session_end.py", [], bridge, env_extra={"CC2CC_SELF": "alpha"})
        hb = json.loads((bridge / "status" / "alpha-heartbeat.json").read_text(encoding="utf-8"))
        assert hb["status"] == "offline"


class TestStatus:
    def test_shows_agents_and_mailboxes(self, bridge):
        run_script("hooks/session_start.py", [], bridge, env_extra={"CC2CC_SELF": "alpha"})
        run_script("scripts/send.py", ["alpha", "beta", "message", "Test"], bridge)
        result = run_script("scripts/status.py", [], bridge)
        assert "alpha" in result.stdout
        assert "pending" in result.stdout


class TestCleanup:
    def test_removes_expired(self, bridge):
        expired = {
            "id": "msg-expired",
            "timestamp": "2020-01-01T00:00:00Z",
            "from": "alpha", "to": "beta", "type": "message",
            "content": {"text": "old", "parts": []},
            "ttl": 3600,
        }
        done_dir = bridge / "alpha-to-beta" / "done"
        (done_dir / "msg-expired.json").write_text(json.dumps(expired), encoding="utf-8")
        before = len(list(done_dir.glob("*.json")))
        run_script("scripts/cleanup.py", ["--max-age-hours", "1"], bridge)
        after = len(list(done_dir.glob("*.json")))
        assert after < before
```

- [ ] **Step 2: Delete old smoke test**

```bash
cd D:/github/cc2cc
git rm tests/smoke.sh
```

- [ ] **Step 3: Run tests**

```bash
cd D:/github/cc2cc
python -m pytest tests/test_smoke.py -v
```

Expected: all 13 tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/test_smoke.py
git commit -m "test: rewrite smoke tests in pytest (cross-platform)"
git push
```

---

### Task 5: Update CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Rewrite `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        python-version: ['3.9', '3.12']

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python ${{ matrix.python-version }}
        uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}

      - name: Install pytest
        run: pip install pytest

      - name: Run tests
        run: python -m pytest tests/ -v

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Python syntax check
        run: |
          python3 -m py_compile scripts/send.py
          python3 -m py_compile scripts/reply.py
          python3 -m py_compile scripts/task.py
          python3 -m py_compile scripts/validate.py
          python3 -m py_compile scripts/cleanup.py
          python3 -m py_compile scripts/init.py
          python3 -m py_compile scripts/receive.py
          python3 -m py_compile scripts/status.py
          python3 -m py_compile hooks/session_start.py
          python3 -m py_compile hooks/session_end.py
          python3 -m py_compile hooks/inbox_watcher.py
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add Windows to matrix, switch to pytest"
git push
```

---

### Task 6: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/CONFIGURATION.md`

- [ ] **Step 1: Update `README.md`**

Key changes:
- Requirements: remove "Bash 4+" and "fswatch", keep Python 3.8+ and Node.js ≥ 18
- Quick Start: `python scripts/init.py alpha beta ~/.cc2cc`
- All command examples: `python scripts/send.py`, `python scripts/status.py`, etc.
- Platform Support table: all three → "Full support"
- Repo Structure: update filenames (`.sh` → `.py`, `launchd/` → `services/`)
- Limitations: remove "Bash scripts require WSL"

- [ ] **Step 2: Update `docs/CONFIGURATION.md`**

Key changes:
- Hook examples use `env` field:
  ```json
  {
    "type": "command",
    "command": "python ~/.cc2cc/hooks/session_start.py",
    "env": { "CC2CC_SELF": "alpha", "CC2CC_BRIDGE_DIR": "~/.cc2cc" }
  }
  ```
- Replace "Heartbeat / Auto-Wake (macOS only)" with cross-platform section referencing `services/`
- Replace "Linux Alternatives" with cross-platform watcher section
- Add Windows notes

- [ ] **Step 3: Commit**

```bash
git add README.md docs/CONFIGURATION.md
git commit -m "docs: update for cross-platform Python scripts"
git push
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full test suite**

```bash
cd D:/github/cc2cc
python -m pytest tests/ -v
```

Expected: all tests pass.

- [ ] **Step 2: Verify no bash scripts remain**

```bash
cd D:/github/cc2cc
find . -name "*.sh" -not -path "./.git/*"
```

Expected: no output (no .sh files left).

- [ ] **Step 3: Verify all Python scripts compile**

```bash
cd D:/github/cc2cc
python -m py_compile scripts/init.py && python -m py_compile scripts/receive.py && python -m py_compile scripts/status.py && python -m py_compile hooks/session_start.py && python -m py_compile hooks/session_end.py && python -m py_compile hooks/inbox_watcher.py
```

- [ ] **Step 4: Final commit if needed, push**

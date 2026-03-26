# CC2CC Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden CC2CC with atomic writes, HMAC signing, error logging, unified CLI, delivery receipts, and pip packaging.

**Architecture:** Extract shared logic into `cc2cc/` package with `core.py` (atomic write, bridge path), `signing.py` (HMAC), `cli.py` (argparse unified entry). Existing scripts become thin wrappers calling package functions. server.mjs gets logging + atomic writes + public SDK API.

**Tech Stack:** Python 3.8+ stdlib (hmac, tempfile, argparse), Node.js MCP SDK v1.12+ (constructor instructions), pytest.

**Working directory:** `D:\github\cc2cc`

---

## File Structure

```
cc2cc/                      # NEW — Python package
├── __init__.py             # Package init, version
├── core.py                 # atomic_write(), bridge_path(), MAX_MESSAGE_SIZE
├── signing.py              # sign_message(), verify_message(), generate_secret()
└── cli.py                  # Unified CLI entry point with argparse subcommands

scripts/
├── send.py                 # MODIFY — use core.atomic_write() + signing
├── reply.py                # MODIFY — use core.atomic_write() + signing
├── task.py                 # MODIFY — use core.atomic_write() + signing
├── validate.py             # MODIFY — add HMAC + size validation
├── cleanup.py              # unchanged
├── init.py                 # MODIFY — generate HMAC secret
├── receive.py              # MODIFY — verify HMAC on read
├── status.py               # MODIFY — show receipt counts

channel/
└── server.mjs              # MODIFY — public SDK API, logging, atomic write, receipts

hooks/
├── session_start.py        # unchanged
├── session_end.py          # unchanged
└── inbox_watcher.py        # unchanged

tests/
├── test_smoke.py           # MODIFY — add HMAC + atomic write + size + receipt tests
└── test_signing.py         # NEW — unit tests for signing module

pyproject.toml              # NEW — pip installable package
```

---

### Task 1: Core module — atomic writes + bridge path + size limit

**Files:**
- Create: `cc2cc/__init__.py`
- Create: `cc2cc/core.py`
- Create: `tests/test_core.py`

- [ ] **Step 1: Write `tests/test_core.py`**

```python
#!/usr/bin/env python3
"""Tests for cc2cc.core module."""

import json
import os
from pathlib import Path

import pytest

# Will be importable after Step 3
from cc2cc.core import atomic_write, bridge_path, MAX_MESSAGE_SIZE


class TestAtomicWrite:
    def test_writes_valid_json(self, tmp_path):
        target = tmp_path / "msg.json"
        data = {"id": "msg-123", "content": {"text": "hello"}}
        atomic_write(target, data)
        assert target.exists()
        assert json.loads(target.read_text(encoding="utf-8")) == data

    def test_no_partial_file_on_error(self, tmp_path):
        target = tmp_path / "msg.json"
        # Non-serializable object
        with pytest.raises(TypeError):
            atomic_write(target, {"bad": object()})
        assert not target.exists()

    def test_temp_file_in_same_dir(self, tmp_path):
        target = tmp_path / "msg.json"
        data = {"id": "msg-456"}
        atomic_write(target, data)
        # No temp files left behind
        files = list(tmp_path.glob("*"))
        assert len(files) == 1
        assert files[0].name == "msg.json"


class TestBridgePath:
    def test_env_override(self, tmp_path, monkeypatch):
        monkeypatch.setenv("CC2CC_BRIDGE_DIR", str(tmp_path))
        assert bridge_path() == tmp_path

    def test_default_home(self, monkeypatch):
        monkeypatch.delenv("CC2CC_BRIDGE_DIR", raising=False)
        result = bridge_path()
        assert result.name == ".cc2cc"


class TestSizeLimit:
    def test_rejects_oversized(self, tmp_path):
        target = tmp_path / "big.json"
        data = {"content": {"text": "x" * (MAX_MESSAGE_SIZE + 1)}}
        with pytest.raises(ValueError, match="exceeds maximum"):
            atomic_write(target, data)
        assert not target.exists()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/github/cc2cc
python -m pytest tests/test_core.py -v
```

Expected: ModuleNotFoundError — `cc2cc` doesn't exist yet.

- [ ] **Step 3: Create `cc2cc/__init__.py`**

```python
"""CC2CC — Claude Code to Claude Code communication."""

__version__ = "2.0.0"
```

- [ ] **Step 4: Create `cc2cc/core.py`**

```python
"""Core utilities: atomic writes, bridge path resolution, size limits."""

import json
import os
import tempfile
from pathlib import Path

MAX_MESSAGE_SIZE = 1_000_000  # 1 MB


def bridge_path() -> Path:
    """Resolve the bridge directory from env or default."""
    return Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))


def atomic_write(target: Path, data: dict) -> None:
    """Write JSON atomically: serialize to temp file, then rename.

    If serialization fails, no file is created.
    If the file exceeds MAX_MESSAGE_SIZE, raises ValueError.
    """
    raw = json.dumps(data, indent=2, ensure_ascii=False)
    if len(raw.encode("utf-8")) > MAX_MESSAGE_SIZE:
        raise ValueError(f"Message size {len(raw)} exceeds maximum {MAX_MESSAGE_SIZE}")

    target.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp = tempfile.mkstemp(dir=str(target.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(raw)
        # Atomic rename (same filesystem guaranteed — same dir)
        os.replace(tmp, str(target))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
```

- [ ] **Step 5: Run tests**

```bash
cd D:/github/cc2cc
python -m pytest tests/test_core.py -v
```

Expected: all 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add cc2cc/__init__.py cc2cc/core.py tests/test_core.py
git commit -m "feat: add cc2cc.core module — atomic writes, bridge path, size limit"
git push
```

---

### Task 2: HMAC signing module

**Files:**
- Create: `cc2cc/signing.py`
- Create: `tests/test_signing.py`

- [ ] **Step 1: Write `tests/test_signing.py`**

```python
#!/usr/bin/env python3
"""Tests for cc2cc.signing module."""

import json
from pathlib import Path

import pytest

from cc2cc.signing import generate_secret, sign_message, verify_message


class TestGenerateSecret:
    def test_returns_hex_string(self):
        secret = generate_secret()
        assert isinstance(secret, str)
        assert len(secret) == 64  # 32 bytes hex-encoded
        bytes.fromhex(secret)  # must be valid hex

    def test_unique_per_call(self):
        assert generate_secret() != generate_secret()


class TestSignAndVerify:
    def test_roundtrip(self):
        secret = generate_secret()
        msg = {"id": "msg-123", "from": "alpha", "content": {"text": "hello"}}
        signed = sign_message(msg, secret)
        assert "hmac" in signed
        assert signed["hmac"] != ""
        assert verify_message(signed, secret)

    def test_tampered_content_fails(self):
        secret = generate_secret()
        msg = {"id": "msg-123", "content": {"text": "hello"}}
        signed = sign_message(msg, secret)
        signed["content"]["text"] = "TAMPERED"
        assert not verify_message(signed, secret)

    def test_wrong_secret_fails(self):
        secret1 = generate_secret()
        secret2 = generate_secret()
        msg = {"id": "msg-123", "content": {"text": "hello"}}
        signed = sign_message(msg, secret1)
        assert not verify_message(signed, secret2)

    def test_unsigned_message_fails(self):
        secret = generate_secret()
        msg = {"id": "msg-123", "content": {"text": "hello"}}
        assert not verify_message(msg, secret)

    def test_sign_preserves_all_fields(self):
        secret = generate_secret()
        msg = {"id": "msg-1", "from": "a", "to": "b", "type": "message",
               "content": {"text": "hi"}, "priority": "high"}
        signed = sign_message(msg, secret)
        for key in msg:
            assert signed[key] == msg[key]
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/github/cc2cc
python -m pytest tests/test_signing.py -v
```

Expected: ImportError.

- [ ] **Step 3: Create `cc2cc/signing.py`**

```python
"""HMAC message signing and verification.

Signs the canonical JSON representation of the message (all fields except 'hmac').
Uses HMAC-SHA256 with a shared secret generated during bridge init.
"""

import hashlib
import hmac
import json
import os


def generate_secret() -> str:
    """Generate a 32-byte random hex secret."""
    return os.urandom(32).hex()


def _canonical(msg: dict) -> bytes:
    """Canonical representation for signing: sorted JSON without 'hmac' field."""
    cleaned = {k: v for k, v in msg.items() if k != "hmac"}
    return json.dumps(cleaned, sort_keys=True, ensure_ascii=False).encode("utf-8")


def sign_message(msg: dict, secret: str) -> dict:
    """Add HMAC-SHA256 signature to message. Returns new dict with 'hmac' field."""
    signed = dict(msg)
    sig = hmac.new(bytes.fromhex(secret), _canonical(signed), hashlib.sha256).hexdigest()
    signed["hmac"] = sig
    return signed


def verify_message(msg: dict, secret: str) -> bool:
    """Verify HMAC signature. Returns False if missing or invalid."""
    if "hmac" not in msg:
        return False
    expected = hmac.new(bytes.fromhex(secret), _canonical(msg), hashlib.sha256).hexdigest()
    return hmac.compare_digest(msg["hmac"], expected)
```

- [ ] **Step 4: Run tests**

```bash
cd D:/github/cc2cc
python -m pytest tests/test_signing.py -v
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add cc2cc/signing.py tests/test_signing.py
git commit -m "feat: add HMAC message signing module"
git push
```

---

### Task 3: Wire atomic writes + HMAC into existing scripts

**Files:**
- Modify: `scripts/send.py`
- Modify: `scripts/reply.py`
- Modify: `scripts/task.py`
- Modify: `scripts/init.py`
- Modify: `scripts/receive.py`
- Modify: `scripts/validate.py`

- [ ] **Step 1: Update `scripts/send.py` to use atomic_write + signing**

Replace the file write section (lines 47-49) and add imports. Full updated file:

```python
#!/usr/bin/env python3
"""Send a message through the CC2CC bridge."""

import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cc2cc.core import atomic_write, bridge_path
from cc2cc.signing import sign_message


def _load_secret(bridge: Path) -> str | None:
    secret_file = bridge / "secret.key"
    if secret_file.exists():
        return secret_file.read_text(encoding="utf-8").strip()
    return None


def main():
    if len(sys.argv) < 5:
        print(
            "Usage: send.py <from> <to> <type> <content> [priority] [mode]",
            file=sys.stderr,
        )
        print("Types: message, task, status, response", file=sys.stderr)
        print("Priority: low, normal, high, critical", file=sys.stderr)
        sys.exit(1)

    sender = sys.argv[1]
    recipient = sys.argv[2]
    msg_type = sys.argv[3]
    content = sys.argv[4]
    priority = sys.argv[5] if len(sys.argv) > 5 else "normal"
    mode = sys.argv[6] if len(sys.argv) > 6 else "session"

    bridge = bridge_path()
    inbox = bridge / f"{sender}-to-{recipient}" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)

    msg_id = f"msg-{uuid.uuid4()}"
    msg = {
        "id": msg_id,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "from": sender,
        "to": recipient,
        "type": msg_type,
        "priority": priority,
        "identity": {"agent": sender, "mode": mode},
        "task": None,
        "content": {"text": content, "parts": []},
        "replyTo": None,
        "ttl": 3600,
    }

    secret = _load_secret(bridge)
    if secret:
        msg = sign_message(msg, secret)

    atomic_write(inbox / f"{msg_id}.json", msg)
    print(f"Sent {msg_id} → {recipient}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Update `scripts/reply.py` to use atomic_write + signing**

Full updated file:

```python
#!/usr/bin/env python3
"""Reply to a message, completing tasks if applicable."""

import glob
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cc2cc.core import atomic_write, bridge_path
from cc2cc.signing import sign_message


def _load_secret(bridge: Path) -> str | None:
    secret_file = bridge / "secret.key"
    if secret_file.exists():
        return secret_file.read_text(encoding="utf-8").strip()
    return None


def find_original(bridge, msg_id):
    """Search all dirs for the original message."""
    for pattern in [f"*/inbox/{msg_id}.json", f"*/done/{msg_id}.json"]:
        matches = glob.glob(os.path.join(str(bridge), pattern))
        if matches:
            with open(matches[0], encoding="utf-8") as f:
                return json.load(f)
    return None


def main():
    if len(sys.argv) < 3:
        print(
            "Usage: reply.py <original-msg-id> <reply-text> [from] [mode]",
            file=sys.stderr,
        )
        sys.exit(1)

    original_id = sys.argv[1]
    reply_text = sys.argv[2]
    sender = sys.argv[3] if len(sys.argv) > 3 else None
    mode = sys.argv[4] if len(sys.argv) > 4 else "session"

    bridge = bridge_path()
    original = find_original(bridge, original_id)

    if original:
        recipient = original["from"]
        if not sender:
            sender = original["to"]
    else:
        print(
            f"Warning: original message {original_id} not found", file=sys.stderr
        )
        recipient = sender
        if not sender:
            print(
                "Error: must specify <from> when original not found", file=sys.stderr
            )
            sys.exit(1)

    # Build task object if replying to a task
    task = None
    if original and original.get("type") == "task" and original.get("task"):
        task = dict(original["task"])
        task["status"] = "completed"
        task["result"] = reply_text

    msg_id = f"msg-{uuid.uuid4()}"
    msg = {
        "id": msg_id,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "from": sender,
        "to": recipient,
        "type": "response",
        "priority": original.get("priority", "normal") if original else "normal",
        "identity": {"agent": sender, "mode": mode},
        "task": task,
        "content": {"text": reply_text, "parts": []},
        "replyTo": original_id,
        "ttl": 3600,
    }

    secret = _load_secret(bridge)
    if secret:
        msg = sign_message(msg, secret)

    inbox = bridge / f"{sender}-to-{recipient}" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    atomic_write(inbox / f"{msg_id}.json", msg)

    print(
        f"Replied {msg_id} → {recipient}" + (" [task completed]" if task else "")
    )


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Update `scripts/task.py` to use atomic_write + signing**

Full updated file:

```python
#!/usr/bin/env python3
"""Delegate a task to a peer agent."""

import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cc2cc.core import atomic_write, bridge_path
from cc2cc.signing import sign_message


def _load_secret(bridge: Path) -> str | None:
    secret_file = bridge / "secret.key"
    if secret_file.exists():
        return secret_file.read_text(encoding="utf-8").strip()
    return None


def main():
    if len(sys.argv) < 5:
        print(
            "Usage: task.py <from> <to> <title> <description> [priority] [mode]",
            file=sys.stderr,
        )
        sys.exit(1)

    sender = sys.argv[1]
    recipient = sys.argv[2]
    title = sys.argv[3]
    description = sys.argv[4]
    priority = sys.argv[5] if len(sys.argv) > 5 else "normal"
    mode = sys.argv[6] if len(sys.argv) > 6 else "session"

    bridge = bridge_path()
    inbox = bridge / f"{sender}-to-{recipient}" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)

    msg_id = f"msg-{uuid.uuid4()}"
    task_id = f"task-{uuid.uuid4()}"
    msg = {
        "id": msg_id,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "from": sender,
        "to": recipient,
        "type": "task",
        "priority": priority,
        "identity": {"agent": sender, "mode": mode},
        "task": {
            "id": task_id,
            "title": title,
            "description": description,
            "status": "submitted",
            "result": None,
        },
        "content": {"text": f"Task: {title} — {description}", "parts": []},
        "replyTo": None,
        "ttl": 3600,
    }

    secret = _load_secret(bridge)
    if secret:
        msg = sign_message(msg, secret)

    atomic_write(inbox / f"{msg_id}.json", msg)
    print(f"Delegated {task_id} → {recipient}: {title}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Update `scripts/init.py` — generate HMAC secret, remove agent-cards**

Add secret generation after mailbox creation. Remove agent-cards section entirely (dead code). Full updated file:

```python
#!/usr/bin/env python3
"""Initialize CC2CC bridge between two agents."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from cc2cc.signing import generate_secret


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

    # Status
    (bridge / "status").mkdir(parents=True, exist_ok=True)

    # HMAC secret — generate only if not exists (don't overwrite on re-init)
    secret_file = bridge / "secret.key"
    if not secret_file.exists():
        secret_file.write_text(generate_secret(), encoding="utf-8")
        print(f"Generated HMAC secret: {secret_file}")
    else:
        print(f"HMAC secret exists: {secret_file}")

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

- [ ] **Step 5: Update `scripts/receive.py` — verify HMAC**

```python
#!/usr/bin/env python3
"""Read pending messages from the CC2CC inbox."""

import json
import os
import shutil
import sys
from pathlib import Path

from cc2cc.signing import verify_message


def _load_secret(bridge: Path) -> str | None:
    secret_file = bridge / "secret.key"
    if secret_file.exists():
        return secret_file.read_text(encoding="utf-8").strip()
    return None


def main():
    if len(sys.argv) < 2:
        print("Usage: receive.py <agent> [--peek]", file=sys.stderr)
        sys.exit(1)

    agent = sys.argv[1]
    peek = "--peek" in sys.argv
    bridge = Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))
    secret = _load_secret(bridge)

    for inbox in bridge.glob(f"*-to-{agent}/inbox"):
        for fp in sorted(inbox.glob("*.json")):
            try:
                msg = json.loads(fp.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue

            # HMAC verification
            sig_status = ""
            if secret:
                if verify_message(msg, secret):
                    sig_status = " [verified]"
                else:
                    sig_status = " [SIGNATURE INVALID]"

            print(f"From: {msg['from']}  Type: {msg['type']}  Priority: {msg.get('priority', 'normal')}{sig_status}")
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

- [ ] **Step 6: Update `scripts/validate.py` — add HMAC + size validation**

```python
#!/usr/bin/env python3
"""Validate all message JSON files in the bridge."""

import glob
import json
import os
import sys
from pathlib import Path

from cc2cc.core import MAX_MESSAGE_SIZE
from cc2cc.signing import verify_message

bridge_dir = Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))
fix = "--fix" in sys.argv

# Load secret if available
secret = None
secret_file = bridge_dir / "secret.key"
if secret_file.exists():
    secret = secret_file.read_text(encoding="utf-8").strip()

REQUIRED = {"id", "timestamp", "from", "to", "type", "content"}
VALID_TYPES = {"message", "task", "response", "status"}
VALID_PRIORITIES = {"low", "normal", "high", "critical"}

total = valid = invalid = 0

for path in glob.glob(os.path.join(str(bridge_dir), "*/*/*.json")):
    total += 1
    try:
        raw = open(path, encoding="utf-8").read()

        # Size check
        if len(raw.encode("utf-8")) > MAX_MESSAGE_SIZE:
            invalid += 1
            print(f"OVERSIZED {os.path.basename(path)}: {len(raw)} bytes (max {MAX_MESSAGE_SIZE})")
            if fix:
                os.remove(path)
                print("  REMOVED")
            continue

        msg = json.loads(raw)

        errors = []
        missing = REQUIRED - set(msg.keys())
        if missing:
            errors.append(f"missing fields: {missing}")
        if msg.get("type") not in VALID_TYPES:
            errors.append(f"invalid type: {msg.get('type')}")
        if msg.get("priority") and msg["priority"] not in VALID_PRIORITIES:
            errors.append(f"invalid priority: {msg['priority']}")
        if not isinstance(msg.get("content"), dict) or "text" not in msg.get(
            "content", {}
        ):
            errors.append("content must have 'text' field")
        if msg.get("type") == "task":
            task = msg.get("task")
            if not task or not all(k in task for k in ("id", "title", "status")):
                errors.append(
                    "task messages must have task object with id, title, status"
                )

        # HMAC check
        if secret and "hmac" in msg:
            if not verify_message(msg, secret):
                errors.append("HMAC signature invalid")

        if errors:
            invalid += 1
            print(f"INVALID {os.path.basename(path)}: {'; '.join(errors)}")
            if fix:
                os.remove(path)
                print("  REMOVED")
        else:
            valid += 1

    except json.JSONDecodeError:
        invalid += 1
        print(f"MALFORMED {os.path.basename(path)}: invalid JSON")
        if fix:
            os.remove(path)

print(f"\nTotal: {total}, Valid: {valid}, Invalid: {invalid}")
```

- [ ] **Step 7: Run all tests**

```bash
cd D:/github/cc2cc
python -m pytest tests/ -v
```

Expected: all existing + new tests pass. The existing smoke tests should still pass because HMAC signing is opt-in (only when secret.key exists).

- [ ] **Step 8: Commit**

```bash
git add scripts/send.py scripts/reply.py scripts/task.py scripts/init.py scripts/receive.py scripts/validate.py
git commit -m "feat: wire atomic writes + HMAC signing into all scripts"
git push
```

---

### Task 4: Fix server.mjs — public SDK API, logging, atomic writes, delivery receipts

**Files:**
- Modify: `channel/server.mjs`

- [ ] **Step 1: Rewrite `channel/server.mjs`**

```js
#!/usr/bin/env node

/**
 * CC2CC MCP Channel Server
 *
 * Polls the inbox for messages from a peer agent and pushes them
 * into the Claude Code session as channel notifications.
 *
 * Exposes a "reply" tool so the agent can respond.
 *
 * Environment:
 *   BRIDGE_DIR — path to bridge root (default: ~/.cc2cc)
 *   SELF       — this agent's ID (default: alpha)
 *   PEER       — peer agent's ID (default: beta)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readdir, readFile, rename, mkdir, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";

const BRIDGE_DIR = process.env.BRIDGE_DIR || `${process.env.HOME || process.env.USERPROFILE}/.cc2cc`;
const SELF = process.env.SELF || "alpha";
const PEER = process.env.PEER || "beta";
const POLL_MS = 3000;

const INBOX = join(BRIDGE_DIR, `${PEER}-to-${SELF}`, "inbox");
const DONE = join(BRIDGE_DIR, `${PEER}-to-${SELF}`, "done");
const OUTBOX = join(BRIDGE_DIR, `${SELF}-to-${PEER}`, "inbox");

// Logging helper — writes to stderr (stdout is MCP transport)
function log(level, msg, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    server: SELF,
    msg,
    ...data,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

// --- Server setup with PUBLIC instructions API ---
const server = new Server(
  {
    name: "peer_channel",
    version: "2.0.0",
    instructions: [
      `Messages from your peer agent "${PEER}" arrive as <channel> tags.`,
      `Reply using the "reply" tool, passing the msg_id from the tag.`,
      `If the message is a task (type=task), execute it and send the result.`,
      `Always show A2A dialog to the user.`,
    ].join(" "),
  },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
  }
);

// Atomic write helper — write to temp, then rename
async function atomicWrite(targetPath, data) {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}.json`);
  await writeFile(tmpPath, JSON.stringify(data, null, 2));
  await rename(tmpPath, targetPath);
}

// Reply tool — the only tool exposed
server.setRequestHandler({ method: "tools/list" }, async () => ({
  tools: [
    {
      name: "reply",
      description: `Reply to ${PEER} through the A2A bridge`,
      inputSchema: {
        type: "object",
        properties: {
          msg_id: {
            type: "string",
            description: "Message ID from <channel> tag (for threading)",
          },
          text: { type: "string", description: "Reply content" },
          type: {
            type: "string",
            enum: ["message", "response", "task"],
            default: "response",
          },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "critical"],
            default: "normal",
          },
        },
        required: ["msg_id", "text"],
      },
    },
  ],
}));

// Handle reply tool calls
server.setRequestHandler({ method: "tools/call" }, async ({ params }) => {
  if (params.name !== "reply") {
    return { content: [{ type: "text", text: "Unknown tool" }] };
  }

  const {
    msg_id,
    text,
    type = "response",
    priority = "normal",
  } = params.arguments;

  const id = `msg-${randomUUID()}`;
  const msg = {
    id,
    timestamp: new Date().toISOString(),
    from: SELF,
    to: PEER,
    type,
    priority,
    identity: { agent: SELF, mode: "session" },
    task: null,
    content: { text, parts: [] },
    replyTo: msg_id || null,
    ttl: 3600,
  };

  try {
    await atomicWrite(join(OUTBOX, `${id}.json`), msg);
    log("info", "reply sent", { id, to: PEER });
    return {
      content: [{ type: "text", text: `Sent ${id} to ${PEER}` }],
    };
  } catch (err) {
    log("error", "reply failed", { id, error: err.message });
    return {
      content: [{ type: "text", text: `Failed to send: ${err.message}` }],
      isError: true,
    };
  }
});

// --- Polling loop: watch inbox, push to channel, write receipts ---

const seenFiles = new Set();

async function drainInbox() {
  await mkdir(INBOX, { recursive: true });
  await mkdir(DONE, { recursive: true });

  let files;
  try {
    files = (await readdir(INBOX)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    log("warn", "inbox read failed", { error: err.message });
    return;
  }

  for (const file of files) {
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);

    try {
      const raw = await readFile(join(INBOX, file), "utf8");
      const msg = JSON.parse(raw);

      const taskTitle = msg.task?.title ? `[${msg.task.title}] ` : "";
      const content = `${taskTitle}${msg.content?.text || ""}`;

      // Push channel notification to Claude Code
      await server.notification({
        method: "notifications/claude/channel",
        params: {
          content,
          meta: {
            msg_id: msg.id,
            priority: msg.priority || "normal",
            type: msg.type || "message",
            from: msg.from,
          },
        },
      });

      log("info", "message delivered", { id: msg.id, from: msg.from, type: msg.type });

      // Write delivery receipt
      const receiptDir = join(BRIDGE_DIR, `${msg.from}-to-${SELF}`, "receipts");
      await mkdir(receiptDir, { recursive: true });
      const receipt = {
        msg_id: msg.id,
        delivered_at: new Date().toISOString(),
        delivered_to: SELF,
      };
      await atomicWrite(join(receiptDir, `${msg.id}.receipt.json`), receipt);

      // Move to done/
      await rename(join(INBOX, file), join(DONE, file));
    } catch (err) {
      log("error", "message processing failed", { file, error: err.message });
    }
  }

  // Prevent memory leak on long-running sessions
  if (seenFiles.size > 500) seenFiles.clear();
}

// Start polling
setInterval(drainInbox, POLL_MS);
drainInbox();
log("info", "server started", { self: SELF, peer: PEER, poll_ms: POLL_MS });

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Commit**

```bash
git add channel/server.mjs
git commit -m "fix: server.mjs — public SDK API, structured logging, atomic writes, delivery receipts"
git push
```

---

### Task 5: Unified CLI

**Files:**
- Create: `cc2cc/cli.py`
- Create: `pyproject.toml`

- [ ] **Step 1: Write `cc2cc/cli.py`**

```python
#!/usr/bin/env python3
"""Unified CC2CC command-line interface.

Usage:
    cc2cc init <agent-a> <agent-b> [bridge-dir]
    cc2cc send <from> <to> <type> <content> [--priority P] [--mode M]
    cc2cc task <from> <to> <title> <description> [--priority P]
    cc2cc reply <msg-id> <text> [--from AGENT]
    cc2cc receive <agent> [--peek]
    cc2cc status
    cc2cc validate [--fix]
    cc2cc cleanup [--max-age-hours N] [--dry-run]
"""

import argparse
import sys


def cmd_init(args):
    from scripts.init import main as _init_main
    sys.argv = ["init.py", args.agent_a, args.agent_b] + ([args.bridge_dir] if args.bridge_dir else [])
    _init_main()


def cmd_send(args):
    from scripts.send import main as _send_main
    sys.argv = ["send.py", args.sender, args.recipient, args.type, args.content]
    if args.priority:
        sys.argv.append(args.priority)
    if args.mode:
        sys.argv.append(args.mode)
    _send_main()


def cmd_task(args):
    from scripts.task import main as _task_main
    sys.argv = ["task.py", args.sender, args.recipient, args.title, args.description]
    if args.priority:
        sys.argv.append(args.priority)
    _task_main()


def cmd_reply(args):
    from scripts.reply import main as _reply_main
    sys.argv = ["reply.py", args.msg_id, args.text]
    if args.sender:
        sys.argv.append(args.sender)
    _reply_main()


def cmd_receive(args):
    from scripts.receive import main as _receive_main
    sys.argv = ["receive.py", args.agent]
    if args.peek:
        sys.argv.append("--peek")
    _receive_main()


def cmd_status(args):
    from scripts.status import main as _status_main
    sys.argv = ["status.py"]
    _status_main()


def cmd_validate(args):
    # validate.py uses module-level code, so we run it as subprocess
    import subprocess
    from pathlib import Path
    script = Path(__file__).resolve().parent.parent / "scripts" / "validate.py"
    cmd = [sys.executable, str(script)]
    if args.fix:
        cmd.append("--fix")
    sys.exit(subprocess.run(cmd).returncode)


def cmd_cleanup(args):
    import subprocess
    from pathlib import Path
    script = Path(__file__).resolve().parent.parent / "scripts" / "cleanup.py"
    cmd = [sys.executable, str(script)]
    if args.max_age_hours:
        cmd.extend(["--max-age-hours", str(args.max_age_hours)])
    if args.dry_run:
        cmd.append("--dry-run")
    sys.exit(subprocess.run(cmd).returncode)


def main():
    parser = argparse.ArgumentParser(
        prog="cc2cc",
        description="CC2CC — Claude Code to Claude Code communication",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # init
    p = sub.add_parser("init", help="Initialize bridge between two agents")
    p.add_argument("agent_a")
    p.add_argument("agent_b")
    p.add_argument("bridge_dir", nargs="?", default=None)
    p.set_defaults(func=cmd_init)

    # send
    p = sub.add_parser("send", help="Send a message")
    p.add_argument("sender")
    p.add_argument("recipient")
    p.add_argument("type", choices=["message", "task", "status", "response"])
    p.add_argument("content")
    p.add_argument("--priority", choices=["low", "normal", "high", "critical"])
    p.add_argument("--mode", default=None)
    p.set_defaults(func=cmd_send)

    # task
    p = sub.add_parser("task", help="Delegate a task")
    p.add_argument("sender")
    p.add_argument("recipient")
    p.add_argument("title")
    p.add_argument("description")
    p.add_argument("--priority", choices=["low", "normal", "high", "critical"])
    p.set_defaults(func=cmd_task)

    # reply
    p = sub.add_parser("reply", help="Reply to a message")
    p.add_argument("msg_id")
    p.add_argument("text")
    p.add_argument("--from", dest="sender", default=None)
    p.set_defaults(func=cmd_reply)

    # receive
    p = sub.add_parser("receive", help="Read pending messages")
    p.add_argument("agent")
    p.add_argument("--peek", action="store_true")
    p.set_defaults(func=cmd_receive)

    # status
    p = sub.add_parser("status", help="Show bridge status")
    p.set_defaults(func=cmd_status)

    # validate
    p = sub.add_parser("validate", help="Validate message files")
    p.add_argument("--fix", action="store_true")
    p.set_defaults(func=cmd_validate)

    # cleanup
    p = sub.add_parser("cleanup", help="TTL-based message cleanup")
    p.add_argument("--max-age-hours", type=int)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_cleanup)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write `pyproject.toml`**

```toml
[build-system]
requires = ["setuptools>=64"]
build-backend = "setuptools.backends._legacy:_Backend"

[project]
name = "cc2cc"
version = "2.0.0"
description = "Claude Code to Claude Code communication — file-based agent-to-agent messaging"
readme = "README.md"
license = "MIT"
requires-python = ">=3.8"
authors = [
    { name = "Vladimir Trojanenko", email = "vladimir.trojanenko@gmail.com" },
]
keywords = ["claude-code", "mcp", "agent-communication", "a2a"]
classifiers = [
    "Development Status :: 4 - Beta",
    "Intended Audience :: Developers",
    "License :: OSI Approved :: MIT License",
    "Programming Language :: Python :: 3",
]

[project.scripts]
cc2cc = "cc2cc.cli:main"

[project.optional-dependencies]
watch = ["watchdog"]

[tool.setuptools.packages.find]
include = ["cc2cc*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 3: Verify CLI works**

```bash
cd D:/github/cc2cc
pip install -e .
cc2cc --help
cc2cc send --help
cc2cc status --help
```

Expected: help text for all subcommands.

- [ ] **Step 4: Commit**

```bash
git add cc2cc/cli.py pyproject.toml
git commit -m "feat: unified CLI entry point + pyproject.toml for pip install"
git push
```

---

### Task 6: Update tests for new features

**Files:**
- Modify: `tests/test_smoke.py`

- [ ] **Step 1: Add HMAC, atomic write, size limit, and receipt tests to `tests/test_smoke.py`**

Append the following test classes to the existing file:

```python
class TestAtomicWriteIntegration:
    """Verify scripts use atomic writes (no partial files)."""

    def test_send_creates_complete_json(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Atomic test"], bridge)
        fp = next((bridge / "alpha-to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        # All required fields present — proves no partial write
        assert all(k in msg for k in ("id", "timestamp", "from", "to", "type", "content"))


class TestHMACSigning:
    """Verify HMAC signing when secret.key exists."""

    def test_signed_message_has_hmac(self, bridge):
        # Create secret
        (bridge / "secret.key").write_text("a" * 64, encoding="utf-8")
        run_script("scripts/send.py", ["alpha", "beta", "message", "Signed msg"], bridge)
        fp = next((bridge / "alpha-to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        assert "hmac" in msg
        assert len(msg["hmac"]) == 64  # SHA256 hex

    def test_unsigned_when_no_secret(self, bridge):
        # No secret.key — messages should work without HMAC
        run_script("scripts/send.py", ["alpha", "beta", "message", "Unsigned"], bridge)
        fp = next((bridge / "alpha-to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        assert "hmac" not in msg

    def test_receive_shows_verified(self, bridge):
        (bridge / "secret.key").write_text("b" * 64, encoding="utf-8")
        run_script("scripts/send.py", ["alpha", "beta", "message", "Check sig"], bridge)
        result = run_script("scripts/receive.py", ["beta", "--peek"], bridge)
        assert "verified" in result.stdout.lower()


class TestSizeLimit:
    """Verify oversized messages are rejected."""

    def test_oversized_message_rejected(self, bridge):
        huge_text = "x" * 1_100_000  # > 1MB
        result = run_script("scripts/send.py", ["alpha", "beta", "message", huge_text], bridge)
        # Should fail — no file created
        files = list((bridge / "alpha-to-beta" / "inbox").glob("msg-*.json"))
        assert len(files) == 0
```

- [ ] **Step 2: Run all tests**

```bash
cd D:/github/cc2cc
python -m pytest tests/ -v
```

Expected: all tests pass (old + new).

- [ ] **Step 3: Commit**

```bash
git add tests/test_smoke.py
git commit -m "test: add HMAC, atomic write, and size limit integration tests"
git push
```

---

### Task 7: Update documentation + remove dead agent-cards

**Files:**
- Modify: `README.md`
- Modify: `docs/SPECIFICATION.md`
- Modify: `docs/CONFIGURATION.md`
- Delete: agent-cards references from init.py (already done in Task 3)

- [ ] **Step 1: Update `README.md`**

Key changes:
- Add `pip install` to Quick Start:
  ```bash
  pip install -e .
  cc2cc init alpha beta ~/.cc2cc
  cc2cc send alpha beta message "Hello"
  cc2cc status
  ```
- Add Security section about HMAC:
  ```
  ## Security

  CC2CC generates an HMAC-SHA256 shared secret during `init`. All messages
  are signed automatically. Recipients verify signatures on read.

  The secret is stored at `~/.cc2cc/secret.key`. Protect it:
  - `chmod 600 ~/.cc2cc/secret.key` (macOS/Linux)
  - Restrict folder permissions (Windows)

  Messages from processes without the secret will show [SIGNATURE INVALID].
  ```
- Update Repo Structure to include `cc2cc/` package and `pyproject.toml`
- Remove "agent-cards" from directory layout and spec references
- Add delivery receipts mention in Architecture section

- [ ] **Step 2: Update `docs/SPECIFICATION.md`**

Key changes:
- Remove Agent Card Schema section entirely
- Remove `agent-cards/` from directory layout
- Add `receipts/` directory to layout:
  ```
  ├── alpha-to-beta/
  │   ├── inbox/
  │   ├── done/
  │   └── receipts/          # Delivery receipts (written by MCP server)
  ```
- Add Receipt Schema section:
  ```
  ## Receipt Schema

  Written to `{sender}-to-{recipient}/receipts/{msg-id}.receipt.json` by the MCP server upon delivery:

  {
    "msg_id": "msg-550e8400-...",
    "delivered_at": "2026-03-27T...",
    "delivered_to": "beta"
  }
  ```
- Add HMAC section:
  ```
  ## Message Signing (HMAC-SHA256)

  When `secret.key` exists in the bridge root, all messages include an `hmac` field.
  The signature covers all fields except `hmac` itself, serialized as sorted JSON.

  Signing is opt-in: bridges initialized without `init.py` can omit the secret.
  Recipients that find `secret.key` will verify; those without will skip verification.
  ```
- Add `"hmac"` to Optional Fields table

- [ ] **Step 3: Update `docs/CONFIGURATION.md`**

Add note about `secret.key`:
```
## HMAC Secret

Generated automatically by `cc2cc init`. Located at `$CC2CC_BRIDGE_DIR/secret.key`.
Both agents must have access to the same secret file (same filesystem).

To regenerate: delete `secret.key` and run `cc2cc init` again.
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/SPECIFICATION.md docs/CONFIGURATION.md
git commit -m "docs: update for HMAC, receipts, CLI, remove agent-cards"
git push
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

```bash
cd D:/github/cc2cc
python -m pytest tests/ -v
```

Expected: all tests pass.

- [ ] **Step 2: Verify CLI works end-to-end**

```bash
cd D:/github/cc2cc
pip install -e .
export CC2CC_BRIDGE_DIR=$(mktemp -d)
cc2cc init alpha beta "$CC2CC_BRIDGE_DIR"
cc2cc send alpha beta message "Hello from CLI"
cc2cc receive beta --peek
cc2cc status
cc2cc validate
cc2cc cleanup --dry-run
```

- [ ] **Step 3: Verify all Python files compile**

```bash
cd D:/github/cc2cc
python -m py_compile cc2cc/__init__.py
python -m py_compile cc2cc/core.py
python -m py_compile cc2cc/signing.py
python -m py_compile cc2cc/cli.py
python -m py_compile scripts/send.py
python -m py_compile scripts/reply.py
python -m py_compile scripts/task.py
python -m py_compile scripts/init.py
python -m py_compile scripts/receive.py
python -m py_compile scripts/validate.py
```

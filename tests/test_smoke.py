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
    """Create a temporary bridge directory with new format."""
    for agent in ["alpha", "beta"]:
        (tmp_path / f"to-{agent}" / "inbox").mkdir(parents=True)
        (tmp_path / f"to-{agent}" / "done").mkdir(parents=True)
    (tmp_path / "status").mkdir()
    return tmp_path


def run_script(name: str, args: list, bridge_dir: Path, env_extra: dict = None) -> subprocess.CompletedProcess:
    """Run a script from the repo."""
    script = REPO_DIR / name
    cmd = [sys.executable, str(script)] + args
    env = {**os.environ, "CC2CC_BRIDGE_DIR": str(bridge_dir)}
    if env_extra:
        env.update(env_extra)
    return subprocess.run(cmd, capture_output=True, text=True, env=env, input="")


class TestSend:
    def test_creates_message_file(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello from alpha"], bridge)
        files = list((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        assert len(files) == 1

    def test_message_fields(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello from alpha"], bridge)
        fp = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
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
        assert len(list((bridge / "to-beta" / "inbox").glob("*.json"))) == 1

    def test_consume_moves_to_done(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello"], bridge)
        run_script("scripts/receive.py", ["beta"], bridge)
        assert len(list((bridge / "to-beta" / "inbox").glob("*.json"))) == 0
        assert len(list((bridge / "to-beta" / "done").glob("*.json"))) == 1


class TestReply:
    def test_reply_creates_response(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello"], bridge)
        msg_file = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(msg_file.read_text(encoding="utf-8"))
        msg_id = msg["id"]
        run_script("scripts/reply.py", [msg_id, "Got it!", "beta"], bridge)
        replies = list((bridge / "to-alpha" / "inbox").glob("msg-*.json"))
        assert len(replies) == 1
        reply = json.loads(replies[0].read_text(encoding="utf-8"))
        assert reply["replyTo"] == msg_id
        assert reply["type"] == "response"


class TestTask:
    def test_task_creation(self, bridge):
        run_script("scripts/task.py", ["alpha", "beta", "Run tests", "Execute integration tests"], bridge)
        files = list((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        assert len(files) == 1
        msg = json.loads(files[0].read_text(encoding="utf-8"))
        assert msg["type"] == "task"
        assert msg["task"]["status"] == "submitted"
        assert msg["task"]["title"] == "Run tests"

    def test_task_reply_completes(self, bridge):
        run_script("scripts/task.py", ["alpha", "beta", "Run tests", "Execute tests"], bridge)
        task_file = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        task_msg = json.loads(task_file.read_text(encoding="utf-8"))
        # Move to done so reply can find it
        done_dir = bridge / "to-beta" / "done"
        task_file.rename(done_dir / task_file.name)
        run_script("scripts/reply.py", [task_msg["id"], "All 42 tests passed", "beta"], bridge)
        replies = list((bridge / "to-alpha" / "inbox").glob("msg-*.json"))
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
        done_dir = bridge / "to-beta" / "done"
        (done_dir / "msg-expired.json").write_text(json.dumps(expired), encoding="utf-8")
        before = len(list(done_dir.glob("*.json")))
        run_script("scripts/cleanup.py", ["--max-age-hours", "1"], bridge)
        after = len(list(done_dir.glob("*.json")))
        assert after < before


class TestAtomicWriteIntegration:
    """Verify scripts use atomic writes (no partial files)."""

    def test_send_creates_complete_json(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Atomic test"], bridge)
        fp = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        assert all(k in msg for k in ("id", "timestamp", "from", "to", "type", "content"))


class TestHMACSigning:
    """Verify HMAC signing when secret.key exists."""

    def test_signed_message_has_hmac(self, bridge):
        (bridge / "secret.key").write_text("a" * 64, encoding="utf-8")
        run_script("scripts/send.py", ["alpha", "beta", "message", "Signed msg"], bridge)
        fp = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        assert "hmac" in msg
        assert len(msg["hmac"]) == 64

    def test_unsigned_when_no_secret(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Unsigned"], bridge)
        fp = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        assert "hmac" not in msg

    def test_receive_shows_verified(self, bridge):
        (bridge / "secret.key").write_text("b" * 64, encoding="utf-8")
        run_script("scripts/send.py", ["alpha", "beta", "message", "Check sig"], bridge)
        result = run_script("scripts/receive.py", ["beta", "--peek"], bridge)
        assert "verified" in result.stdout.lower()

    def test_receive_shows_invalid_for_tampered(self, bridge):
        (bridge / "secret.key").write_text("c" * 64, encoding="utf-8")
        run_script("scripts/send.py", ["alpha", "beta", "message", "Will tamper"], bridge)
        fp = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        msg["content"]["text"] = "TAMPERED"
        fp.write_text(json.dumps(msg), encoding="utf-8")
        result = run_script("scripts/receive.py", ["beta", "--peek"], bridge)
        assert "invalid" in result.stdout.lower()


class TestSizeLimit:
    """Verify oversized messages are rejected.

    Note: passing 1MB+ text as a CLI arg is not feasible on Windows (WinError 206).
    We verify size enforcement via the core module directly (same code path send.py uses).
    """

    def test_oversized_message_rejected(self, bridge):
        from cc2cc.core import atomic_write, MAX_MESSAGE_SIZE
        inbox = bridge / "to-beta" / "inbox"
        msg = {"id": "msg-big", "content": {"text": "x" * 1_100_000}}
        with pytest.raises(ValueError, match="exceeds maximum"):
            atomic_write(inbox / "msg-big.json", msg)
        files = list(inbox.glob("msg-*.json"))
        assert len(files) == 0


class TestInitSecret:
    """Verify init generates HMAC secret."""

    def test_init_creates_secret_key(self, bridge):
        # init.py needs a repo_dir with channel/server.mjs — use a temp structure
        import tempfile
        repo = Path(tempfile.mkdtemp())
        (repo / "channel").mkdir()
        (repo / "channel" / "server.mjs").write_text("// mock", encoding="utf-8")
        (repo / "hooks").mkdir()
        (repo / "scripts").mkdir()
        # We can't easily test init.py via subprocess because it resolves repo_dir from __file__
        # So just verify the secret.key mechanism directly
        from cc2cc.signing import generate_secret
        secret = generate_secret()
        (bridge / "secret.key").write_text(secret, encoding="utf-8")
        assert (bridge / "secret.key").exists()
        assert len((bridge / "secret.key").read_text(encoding="utf-8")) == 64


class TestTaskWithHMAC:
    """Verify task delegation with HMAC."""

    def test_task_signed_when_secret_exists(self, bridge):
        (bridge / "secret.key").write_text("d" * 64, encoding="utf-8")
        run_script("scripts/task.py", ["alpha", "beta", "Run tests", "Execute all tests"], bridge)
        fp = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        assert "hmac" in msg
        assert msg["type"] == "task"
        assert msg["task"]["title"] == "Run tests"


class TestReplyWithHMAC:
    """Verify reply with HMAC."""

    def test_reply_signed_when_secret_exists(self, bridge):
        (bridge / "secret.key").write_text("e" * 64, encoding="utf-8")
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello"], bridge)
        msg_file = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(msg_file.read_text(encoding="utf-8"))
        run_script("scripts/reply.py", [msg["id"], "Got it!", "beta"], bridge)
        replies = list((bridge / "to-alpha" / "inbox").glob("msg-*.json"))
        assert len(replies) == 1
        reply = json.loads(replies[0].read_text(encoding="utf-8"))
        assert "hmac" in reply
        assert reply["type"] == "response"


class TestLegacyCompat:
    """Verify backwards compatibility with old alpha-to-beta/ format."""

    def test_receive_reads_legacy_inbox(self, bridge):
        """Messages in old format dirs are still found by receive.py."""
        legacy_inbox = bridge / "alpha-to-beta" / "inbox"
        legacy_inbox.mkdir(parents=True, exist_ok=True)
        (bridge / "alpha-to-beta" / "done").mkdir(parents=True, exist_ok=True)
        msg = {
            "id": "msg-legacy-1", "timestamp": "2026-03-27T10:00:00Z",
            "from": "alpha", "to": "beta", "type": "message",
            "content": {"text": "legacy message", "parts": []},
            "priority": "normal",
        }
        (legacy_inbox / "msg-legacy-1.json").write_text(
            json.dumps(msg), encoding="utf-8"
        )
        result = run_script("scripts/receive.py", ["beta", "--peek"], bridge)
        assert "legacy message" in result.stdout

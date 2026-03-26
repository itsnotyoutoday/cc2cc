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
    return subprocess.run(cmd, capture_output=True, text=True, env=env, input="")


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

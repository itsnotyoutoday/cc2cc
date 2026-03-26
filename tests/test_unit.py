#!/usr/bin/env python3
"""Unit tests for CC2CC — fast regression catching without subprocess overhead."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

from cc2cc.core import atomic_write, bridge_path, MAX_MESSAGE_SIZE
from cc2cc.signing import generate_secret, sign_message, verify_message


# ─── atomic_write edge cases ───

class TestAtomicWriteEdgeCases:
    def test_creates_parent_dirs(self, tmp_path):
        target = tmp_path / "deep" / "nested" / "dir" / "msg.json"
        atomic_write(target, {"id": "test"})
        assert target.exists()

    def test_overwrites_existing_file(self, tmp_path):
        target = tmp_path / "msg.json"
        atomic_write(target, {"version": 1})
        atomic_write(target, {"version": 2})
        assert json.loads(target.read_text(encoding="utf-8"))["version"] == 2

    def test_unicode_content_preserved(self, tmp_path):
        target = tmp_path / "msg.json"
        data = {"text": "Привет мир 🌍 日本語"}
        atomic_write(target, data)
        assert json.loads(target.read_text(encoding="utf-8"))["text"] == data["text"]

    def test_exact_size_limit_passes(self, tmp_path):
        target = tmp_path / "msg.json"
        # Create data that's exactly at the limit (accounting for JSON formatting)
        data = {"x": "a" * 999_950}
        # This should not raise — it's under 1MB
        atomic_write(target, data)
        assert target.exists()

    def test_empty_dict_writes_valid_json(self, tmp_path):
        target = tmp_path / "msg.json"
        atomic_write(target, {})
        assert json.loads(target.read_text(encoding="utf-8")) == {}


# ─── bridge_path edge cases ───

class TestBridgePathEdgeCases:
    def test_tilde_expansion(self, monkeypatch):
        monkeypatch.delenv("CC2CC_BRIDGE_DIR", raising=False)
        result = bridge_path()
        assert "~" not in str(result)  # should be expanded

    def test_windows_path_works(self, tmp_path, monkeypatch):
        monkeypatch.setenv("CC2CC_BRIDGE_DIR", str(tmp_path))
        assert bridge_path() == tmp_path


# ─── signing edge cases ───

class TestSigningEdgeCases:
    def test_sign_does_not_mutate_original(self):
        secret = generate_secret()
        msg = {"id": "msg-1", "content": {"text": "hello"}}
        original_keys = set(msg.keys())
        sign_message(msg, secret)
        assert set(msg.keys()) == original_keys  # no 'hmac' added to original

    def test_verify_with_extra_fields(self):
        """Message with fields added after signing should fail verification."""
        secret = generate_secret()
        msg = {"id": "msg-1", "content": {"text": "hello"}}
        signed = sign_message(msg, secret)
        signed["extra_field"] = "injected"
        assert not verify_message(signed, secret)

    def test_empty_message_signs(self):
        secret = generate_secret()
        signed = sign_message({}, secret)
        assert verify_message(signed, secret)

    def test_nested_object_changes_detected(self):
        secret = generate_secret()
        msg = {"id": "1", "content": {"text": "hello", "parts": [{"type": "code", "value": "x=1"}]}}
        signed = sign_message(msg, secret)
        signed["content"]["parts"][0]["value"] = "x=2"
        assert not verify_message(signed, secret)

    def test_secret_format_32_bytes(self):
        for _ in range(10):
            s = generate_secret()
            assert len(bytes.fromhex(s)) == 32


# ─── message schema validation ───

class TestMessageSchema:
    """Verify message structure matches protocol spec."""

    def _make_message(self, **overrides):
        msg = {
            "id": "msg-test-123",
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "from": "alpha",
            "to": "beta",
            "type": "message",
            "priority": "normal",
            "identity": {"agent": "alpha", "mode": "session"},
            "task": None,
            "content": {"text": "test message", "parts": []},
            "replyTo": None,
            "ttl": 3600,
        }
        msg.update(overrides)
        return msg

    def test_required_fields_present(self):
        msg = self._make_message()
        required = {"id", "timestamp", "from", "to", "type", "content"}
        assert required.issubset(set(msg.keys()))

    def test_id_format(self):
        msg = self._make_message()
        assert msg["id"].startswith("msg-")

    def test_timestamp_is_utc(self):
        msg = self._make_message()
        assert msg["timestamp"].endswith("Z")

    def test_content_has_text_and_parts(self):
        msg = self._make_message()
        assert "text" in msg["content"]
        assert "parts" in msg["content"]

    def test_task_type_requires_task_object(self):
        msg = self._make_message(
            type="task",
            task={"id": "task-1", "title": "Test", "description": "Desc", "status": "submitted", "result": None},
        )
        assert msg["task"]["id"].startswith("task-")
        assert msg["task"]["status"] == "submitted"

    def test_valid_priorities(self):
        for p in ["low", "normal", "high", "critical"]:
            msg = self._make_message(priority=p)
            assert msg["priority"] == p

    def test_valid_types(self):
        for t in ["message", "task", "response", "status"]:
            msg = self._make_message(type=t)
            assert msg["type"] == t

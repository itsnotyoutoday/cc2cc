#!/usr/bin/env python3
"""Tests for cc2cc.core module."""

import json
from pathlib import Path

import pytest

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
        with pytest.raises(TypeError):
            atomic_write(target, {"bad": object()})
        assert not target.exists()

    def test_temp_file_in_same_dir(self, tmp_path):
        target = tmp_path / "msg.json"
        data = {"id": "msg-456"}
        atomic_write(target, data)
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

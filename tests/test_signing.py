#!/usr/bin/env python3
"""Tests for cc2cc.signing module."""

import pytest

from cc2cc.signing import generate_secret, sign_message, verify_message


class TestGenerateSecret:
    def test_returns_hex_string(self):
        secret = generate_secret()
        assert isinstance(secret, str)
        assert len(secret) == 64
        bytes.fromhex(secret)

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

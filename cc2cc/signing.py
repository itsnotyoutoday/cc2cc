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

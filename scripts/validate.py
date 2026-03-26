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

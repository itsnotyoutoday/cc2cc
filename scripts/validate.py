#!/usr/bin/env python3
"""Validate all message JSON files in the bridge."""

import glob
import json
import os
import sys

bridge = os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc"))
fix = "--fix" in sys.argv

REQUIRED = {"id", "timestamp", "from", "to", "type", "content"}
VALID_TYPES = {"message", "task", "response", "status"}
VALID_PRIORITIES = {"low", "normal", "high", "critical"}

total = valid = invalid = 0

for path in glob.glob(os.path.join(bridge, "*/*/*.json")):
    total += 1
    try:
        with open(path) as f:
            msg = json.load(f)

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

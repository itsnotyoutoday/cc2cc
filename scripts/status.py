#!/usr/bin/env python3
"""Show CC2CC bridge status."""

import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Ensure UTF-8 output on Windows (for Unicode indicators)
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


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
            indicator = "\u25cf" if age < 30 else "\u25cb"
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

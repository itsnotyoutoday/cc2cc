#!/usr/bin/env python3
"""CC2CC SessionStart hook — write heartbeat, check inbox."""

import json
import os
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path


def main():
    # Drain stdin (hook protocol)
    sys.stdin.read()

    self_id = os.environ.get("CC2CC_SELF", socket.gethostname().split(".")[0])
    bridge = Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))

    # Write heartbeat
    status_dir = bridge / "status"
    status_dir.mkdir(parents=True, exist_ok=True)
    heartbeat = {
        "agent": self_id,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "session_id": str(os.getpid()),
        "status": "active",
        "context": "session started",
    }
    (status_dir / f"{self_id}-heartbeat.json").write_text(
        json.dumps(heartbeat, indent=2), encoding="utf-8"
    )

    # Check inbox — new format + legacy
    pending = 0
    output_lines = []
    new_inbox = bridge / f"to-{self_id}" / "inbox"
    if new_inbox.exists():
        for fp in new_inbox.glob("*.json"):
            pending += 1
            try:
                msg = json.loads(fp.read_text(encoding="utf-8"))
                sender = msg["from"]
                mtype = msg["type"]
                text = msg["content"]["text"][:80]
                output_lines.append(f"  - [{mtype}] from {sender}: {text}")
            except (json.JSONDecodeError, KeyError, OSError):
                output_lines.append("  - [unknown] unreadable message")
    # Legacy format
    for fp in bridge.glob(f"*-to-{self_id}/inbox/*.json"):
        pending += 1
        try:
            msg = json.loads(fp.read_text(encoding="utf-8"))
            sender = msg["from"]
            mtype = msg["type"]
            text = msg["content"]["text"][:80]
            output_lines.append(f"  - [{mtype}] from {sender}: {text}")
        except (json.JSONDecodeError, KeyError, OSError):
            output_lines.append("  - [unknown] unreadable message")

    if pending > 0:
        print(f"CC2CC: {pending} pending message(s) in inbox:")
        print("\n".join(output_lines))
    else:
        print("CC2CC: No pending messages. Bridge active.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Send a message through the CC2CC bridge."""

import json
import os
import sys
import uuid
from datetime import datetime, timezone


def main():
    if len(sys.argv) < 5:
        print(
            "Usage: send.py <from> <to> <type> <content> [priority] [mode]",
            file=sys.stderr,
        )
        print("Types: message, task, status, response", file=sys.stderr)
        print("Priority: low, normal, high, critical", file=sys.stderr)
        sys.exit(1)

    sender = sys.argv[1]
    recipient = sys.argv[2]
    msg_type = sys.argv[3]
    content = sys.argv[4]
    priority = sys.argv[5] if len(sys.argv) > 5 else "normal"
    mode = sys.argv[6] if len(sys.argv) > 6 else "session"

    bridge = os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc"))
    inbox = os.path.join(bridge, f"{sender}-to-{recipient}", "inbox")
    os.makedirs(inbox, exist_ok=True)

    msg_id = f"msg-{uuid.uuid4()}"
    msg = {
        "id": msg_id,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "from": sender,
        "to": recipient,
        "type": msg_type,
        "priority": priority,
        "identity": {"agent": sender, "mode": mode},
        "task": None,
        "content": {"text": content, "parts": []},
        "replyTo": None,
        "ttl": 3600,
    }

    path = os.path.join(inbox, f"{msg_id}.json")
    with open(path, "w") as f:
        json.dump(msg, f, indent=2, ensure_ascii=False)

    print(f"Sent {msg_id} → {recipient}")


if __name__ == "__main__":
    main()

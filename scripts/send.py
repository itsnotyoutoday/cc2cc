#!/usr/bin/env python3
"""Send a message through the CC2CC bridge."""

import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cc2cc.core import atomic_write, bridge_path
from cc2cc.signing import sign_message


def _load_secret(bridge: Path):
    secret_file = bridge / "secret.key"
    if secret_file.exists():
        return secret_file.read_text(encoding="utf-8").strip()
    return None


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

    bridge = bridge_path()
    inbox = bridge / f"to-{recipient}" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)

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

    secret = _load_secret(bridge)
    if secret:
        msg = sign_message(msg, secret)

    atomic_write(inbox / f"{msg_id}.json", msg)
    print(f"Sent {msg_id} -> {recipient}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Send a message through the CC2CC bridge to a specific room."""

import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cc2cc.core import atomic_write, bridge_path, room_inbox_path
from cc2cc.signing import sign_message


def _load_secret(bridge: Path):
    secret_file = bridge / "secret.key"
    if secret_file.exists():
        return secret_file.read_text(encoding="utf-8").strip()
    return None


def main():
    if len(sys.argv) < 6:
        print(
            "Usage: send_to_room.py <room_id> <from> <to> <type> <content> [priority] [mode]",
            file=sys.stderr,
        )
        print("Types: message, task, status, response", file=sys.stderr)
        print("Priority: low, normal, high, critical", file=sys.stderr)
        sys.exit(1)

    room_id = sys.argv[1]
    sender = sys.argv[2]
    recipient = sys.argv[3]
    msg_type = sys.argv[4]
    content = sys.argv[5]
    priority = sys.argv[6] if len(sys.argv) > 6 else "normal"
    mode = sys.argv[7] if len(sys.argv) > 7 else "session"

    bridge = bridge_path()
    inbox = room_inbox_path(recipient, room_id)
    inbox.mkdir(parents=True, exist_ok=True)

    msg_id = f"msg-{uuid.uuid4()}"
    msg = {
        "id": msg_id,
        "room_id": room_id,
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
    print(f"Sent {msg_id} -> {recipient} in room {room_id}")


if __name__ == "__main__":
    main()

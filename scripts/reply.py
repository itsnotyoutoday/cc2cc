#!/usr/bin/env python3
"""Reply to a message, completing tasks if applicable."""

import glob
import json
import os
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


def find_original(bridge, msg_id):
    """Search all dirs for the original message."""
    for pattern in [f"*/inbox/{msg_id}.json", f"*/done/{msg_id}.json"]:
        matches = glob.glob(os.path.join(str(bridge), pattern))
        if matches:
            with open(matches[0], encoding="utf-8") as f:
                return json.load(f)
    return None


def main():
    if len(sys.argv) < 3:
        print(
            "Usage: reply.py <original-msg-id> <reply-text> [from] [mode]",
            file=sys.stderr,
        )
        sys.exit(1)

    original_id = sys.argv[1]
    reply_text = sys.argv[2]
    sender = sys.argv[3] if len(sys.argv) > 3 else None
    mode = sys.argv[4] if len(sys.argv) > 4 else "session"

    bridge = bridge_path()
    original = find_original(bridge, original_id)

    if original:
        recipient = original["from"]
        if not sender:
            sender = original["to"]
    else:
        print(
            f"Warning: original message {original_id} not found", file=sys.stderr
        )
        recipient = sender
        if not sender:
            print(
                "Error: must specify <from> when original not found", file=sys.stderr
            )
            sys.exit(1)

    task = None
    if original and original.get("type") == "task" and original.get("task"):
        task = dict(original["task"])
        task["status"] = "completed"
        task["result"] = reply_text

    msg_id = f"msg-{uuid.uuid4()}"
    msg = {
        "id": msg_id,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "from": sender,
        "to": recipient,
        "type": "response",
        "priority": original.get("priority", "normal") if original else "normal",
        "identity": {"agent": sender, "mode": mode},
        "task": task,
        "content": {"text": reply_text, "parts": []},
        "replyTo": original_id,
        "ttl": 3600,
    }

    secret = _load_secret(bridge)
    if secret:
        msg = sign_message(msg, secret)

    inbox = bridge / f"{sender}-to-{recipient}" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    atomic_write(inbox / f"{msg_id}.json", msg)

    print(
        f"Replied {msg_id} → {recipient}" + (" [task completed]" if task else "")
    )


if __name__ == "__main__":
    main()

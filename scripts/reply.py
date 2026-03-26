#!/usr/bin/env python3
"""Reply to a message, completing tasks if applicable."""

import glob
import json
import os
import sys
import uuid
from datetime import datetime, timezone


def find_original(bridge, msg_id):
    """Search all dirs for the original message."""
    for pattern in [f"*/inbox/{msg_id}.json", f"*/done/{msg_id}.json"]:
        matches = glob.glob(os.path.join(bridge, pattern))
        if matches:
            with open(matches[0]) as f:
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

    bridge = os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc"))
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

    # Build task object if replying to a task
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

    inbox = os.path.join(bridge, f"{sender}-to-{recipient}", "inbox")
    os.makedirs(inbox, exist_ok=True)
    path = os.path.join(inbox, f"{msg_id}.json")
    with open(path, "w") as f:
        json.dump(msg, f, indent=2, ensure_ascii=False)

    print(
        f"Replied {msg_id} → {recipient}" + (" [task completed]" if task else "")
    )


if __name__ == "__main__":
    main()

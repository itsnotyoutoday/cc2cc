#!/usr/bin/env python3
"""Read pending messages from the CC2CC inbox."""

import json
import os
import sys
import time
from pathlib import Path

from cc2cc.signing import verify_message


def _load_secret(bridge: Path):
    secret_file = bridge / "secret.key"
    if secret_file.exists():
        return secret_file.read_text(encoding="utf-8").strip()
    return None


def main():
    if len(sys.argv) < 2:
        print("Usage: receive.py <agent> [--peek]", file=sys.stderr)
        sys.exit(1)

    agent = sys.argv[1]
    peek = "--peek" in sys.argv
    bridge = Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))
    secret = _load_secret(bridge)

    inboxes = []
    new_inbox = bridge / f"to-{agent}" / "inbox"
    if new_inbox.is_dir():
        inboxes.append(new_inbox)
    inboxes.extend(bridge.glob(f"*-to-{agent}/inbox"))

    for inbox in inboxes:
        for fp in sorted(inbox.glob("*.json")):
            try:
                msg = json.loads(fp.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue

            sig_status = ""
            if secret:
                if verify_message(msg, secret):
                    sig_status = " [verified]"
                else:
                    sig_status = " [SIGNATURE INVALID]"

            print(f"From: {msg['from']}  Type: {msg['type']}  Priority: {msg.get('priority', 'normal')}{sig_status}")
            print(f"Time: {msg['timestamp']}")
            print(f"Content: {msg['content']['text'][:200]}")
            if msg.get("task"):
                print(f"Task: {msg['task']['title']} [{msg['task']['status']}]")
            print("---")

            if not peek:
                done_dir = inbox.parent / "done"
                done_dir.mkdir(parents=True, exist_ok=True)
                dst = str(done_dir / fp.name)
                for _attempt in range(5):
                    try:
                        os.replace(str(fp), dst)
                        break
                    except PermissionError:
                        if _attempt < 4:
                            time.sleep(0.05 * (_attempt + 1))
                        else:
                            raise


if __name__ == "__main__":
    main()

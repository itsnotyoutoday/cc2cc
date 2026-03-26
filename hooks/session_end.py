#!/usr/bin/env python3
"""CC2CC SessionEnd hook — mark agent offline."""

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

    status_dir = bridge / "status"
    status_dir.mkdir(parents=True, exist_ok=True)
    heartbeat = {
        "agent": self_id,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "session_id": "none",
        "status": "offline",
        "context": "session ended",
    }
    (status_dir / f"{self_id}-heartbeat.json").write_text(
        json.dumps(heartbeat, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()

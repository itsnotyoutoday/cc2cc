#!/usr/bin/env python3
"""TTL-based message cleanup."""

import glob
import json
import os
import sys
from datetime import datetime, timezone

max_age_hours = 24
dry_run = "--dry-run" in sys.argv

for i, arg in enumerate(sys.argv[1:], 1):
    if arg == "--max-age-hours" and i + 1 < len(sys.argv):
        max_age_hours = int(sys.argv[i + 1])

bridge = os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc"))
now = datetime.now(timezone.utc)
archived_removed = 0
inbox_expired = 0

# Clean done/ directories — remove old messages
for path in glob.glob(os.path.join(bridge, "*/done/*.json")):
    try:
        with open(path) as f:
            msg = json.load(f)
        ts = datetime.fromisoformat(msg["timestamp"].replace("Z", "+00:00"))
        if (now - ts).total_seconds() > max_age_hours * 3600:
            if not dry_run:
                os.remove(path)
            archived_removed += 1
    except (json.JSONDecodeError, KeyError):
        if not dry_run:
            os.remove(path)
        archived_removed += 1

# Expire inbox/ messages past TTL
for path in glob.glob(os.path.join(bridge, "*/inbox/*.json")):
    try:
        with open(path) as f:
            msg = json.load(f)
        ts = datetime.fromisoformat(msg["timestamp"].replace("Z", "+00:00"))
        ttl = msg.get("ttl", 3600)
        if (now - ts).total_seconds() > ttl:
            done_dir = os.path.join(os.path.dirname(os.path.dirname(path)), "done")
            os.makedirs(done_dir, exist_ok=True)
            if not dry_run:
                os.rename(path, os.path.join(done_dir, os.path.basename(path)))
            inbox_expired += 1
    except (json.JSONDecodeError, KeyError):
        if not dry_run:
            os.remove(path)

prefix = "[DRY RUN] " if dry_run else ""
print(f"{prefix}Removed {archived_removed} archived, expired {inbox_expired} inbox messages")

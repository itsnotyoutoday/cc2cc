"""Core utilities: atomic writes, bridge path resolution, size limits."""

import json
import os
import sys
import tempfile
import time
from pathlib import Path

MAX_MESSAGE_SIZE = 1_000_000  # 1 MB


def bridge_path() -> Path:
    """Resolve the bridge directory from env or default."""
    return Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))


def room_inbox_path(recipient: str, room_id: str) -> Path:
    """Return the path to a recipient's inbox within a specific room."""
    return bridge_path() / "rooms" / room_id / f"to-{recipient}" / "inbox"


def retry_replace(src: str, dst: str, retries: int = 5, delay: float = 0.05) -> None:
    """os.replace with retry for Windows AV file locking (PermissionError)."""
    for i in range(retries):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i < retries - 1:
                time.sleep(delay * (i + 1))
            else:
                raise


def atomic_write(target: Path, data: dict) -> None:
    """Write JSON atomically: serialize to temp file, then rename.

    If serialization fails, no file is created.
    If the file exceeds MAX_MESSAGE_SIZE, raises ValueError.
    """
    raw = json.dumps(data, indent=2, ensure_ascii=False)
    if len(raw.encode("utf-8")) > MAX_MESSAGE_SIZE:
        raise ValueError(f"Message size {len(raw)} exceeds maximum {MAX_MESSAGE_SIZE}")

    target.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp = tempfile.mkstemp(dir=str(target.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(raw)
        retry_replace(tmp, str(target))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

"""Core utilities: atomic writes, bridge path resolution, size limits."""

import json
import os
import tempfile
from pathlib import Path

MAX_MESSAGE_SIZE = 1_000_000  # 1 MB


def bridge_path() -> Path:
    """Resolve the bridge directory from env or default."""
    return Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))


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
        # Atomic rename (same filesystem guaranteed — same dir)
        os.replace(tmp, str(target))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

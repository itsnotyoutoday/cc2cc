"""Core utilities: atomic writes, bridge path resolution, size limits."""

import json
import os
import sys
import tempfile
import time
from pathlib import Path

MAX_MESSAGE_SIZE = 1_000_000  # 1 MB


def bridge_path() -> Path:
    """Resolve the bridge directory, MIRRORING cc2cc-launch so cc2cc-admin and the scripts operate on
    the SAME bridge the daemon + agents use: an explicit CC2CC_BRIDGE_DIR wins; else auto-detect a
    machine-wide install (/var/lib/cc2cc) before falling back to the per-user local bridge (~/.cc2cc).

    Without this, cc2cc-admin defaulted straight to ~/.cc2cc, so operator team/member writes on a
    global install silently landed in the wrong (local) store and never took effect on the live mesh.
    Detect the global install by the DIRECTORY (not a file inside it — a login lacking the cc2cc group
    can't traverse the bridge to stat secret.key), matching cc2cc-launch's check.
    """
    env = os.environ.get("CC2CC_BRIDGE_DIR")
    if env:
        return Path(env)
    global_bridge = Path("/var/lib/cc2cc")
    if global_bridge.is_dir():
        return global_bridge
    return Path(os.path.expanduser("~/.cc2cc"))


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

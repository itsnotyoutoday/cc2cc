#!/usr/bin/env python3
"""CC2CC cross-platform inbox watcher with optional watchdog support."""

import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

POLL_INTERVAL = 3  # seconds


def get_inbox_dirs(bridge: Path, self_id: str) -> list:
    return [d for d in bridge.glob(f"*-to-{self_id}/inbox") if d.is_dir()]


def count_messages(dirs: list) -> int:
    return sum(len(list(d.glob("*.json"))) for d in dirs)


def notify(count: int):
    """Send desktop notification. Best-effort, never raises."""
    msg = f"{count} message(s) in CC2CC inbox"
    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.run(
                ["osascript", "-e", f'display notification "{msg}" with title "CC2CC" sound name "Submarine"'],
                capture_output=True, timeout=5,
            )
        elif system == "Linux":
            subprocess.run(["notify-send", "CC2CC", msg], capture_output=True, timeout=5)
        elif system == "Windows":
            try:
                from plyer import notification
                notification.notify(title="CC2CC", message=msg, timeout=5)
            except ImportError:
                print(f"CC2CC: {msg}")
        else:
            print(f"CC2CC: {msg}")
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        print(f"CC2CC: {msg}")


def acquire_lock(self_id: str) -> bool:
    lock_dir = Path(tempfile.gettempdir()) / f"cc2cc-watcher-{self_id}.lock"
    if lock_dir.exists():
        age = time.time() - lock_dir.stat().st_mtime
        if age < 300:
            return False
        shutil.rmtree(lock_dir, ignore_errors=True)
    try:
        lock_dir.mkdir()
        return True
    except OSError:
        return False


def release_lock(self_id: str):
    lock_dir = Path(tempfile.gettempdir()) / f"cc2cc-watcher-{self_id}.lock"
    shutil.rmtree(lock_dir, ignore_errors=True)


def poll_loop(bridge: Path, self_id: str):
    """Fallback polling loop."""
    dirs = get_inbox_dirs(bridge, self_id)
    if not dirs:
        print(f"No inbox dirs found for {self_id}", file=sys.stderr)
        sys.exit(1)

    print(f"Watching {len(dirs)} inbox(es) for {self_id} (polling every {POLL_INTERVAL}s)")
    prev_count = 0

    while True:
        count = count_messages(dirs)
        if count > 0 and count != prev_count:
            if acquire_lock(self_id):
                try:
                    notify(count)
                finally:
                    release_lock(self_id)
        prev_count = count
        time.sleep(POLL_INTERVAL)


def watchdog_loop(bridge: Path, self_id: str):
    """Use watchdog library for near-instant detection."""
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler

    dirs = get_inbox_dirs(bridge, self_id)
    if not dirs:
        print(f"No inbox dirs found for {self_id}", file=sys.stderr)
        sys.exit(1)

    class InboxHandler(FileSystemEventHandler):
        def on_created(self, event):
            if event.src_path.endswith(".json"):
                time.sleep(0.3)  # debounce
                if acquire_lock(self_id):
                    try:
                        count = count_messages(dirs)
                        if count > 0:
                            notify(count)
                    finally:
                        release_lock(self_id)

    observer = Observer()
    handler = InboxHandler()
    for d in dirs:
        observer.schedule(handler, str(d), recursive=False)

    print(f"Watching {len(dirs)} inbox(es) for {self_id} (watchdog)")
    observer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


def main():
    self_id = os.environ.get("CC2CC_SELF")
    if not self_id:
        print("Error: set CC2CC_SELF environment variable", file=sys.stderr)
        sys.exit(1)

    bridge = Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))

    try:
        import watchdog
        watchdog_loop(bridge, self_id)
    except ImportError:
        poll_loop(bridge, self_id)


if __name__ == "__main__":
    main()

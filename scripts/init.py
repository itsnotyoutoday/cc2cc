#!/usr/bin/env python3
"""Initialize CC2CC bridge."""

import io
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from cc2cc.signing import generate_secret

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def main():
    if len(sys.argv) < 2:
        bridge = Path(os.path.expanduser("~/.cc2cc"))
    else:
        bridge = Path(sys.argv[1])

    repo_dir = Path(__file__).resolve().parent.parent

    print(f"Initializing CC2CC bridge at {bridge}")

    (bridge / "status").mkdir(parents=True, exist_ok=True)

    secret_file = bridge / "secret.key"
    if not secret_file.exists():
        secret_file.write_text(generate_secret(), encoding="utf-8")
        print(f"Generated HMAC secret: {secret_file}")
    else:
        print(f"HMAC secret exists: {secret_file}")

    for src_name in ["server.mjs", "names.mjs"]:
        src = repo_dir / "channel" / src_name
        if src.exists():
            shutil.copy2(src, bridge / src_name)

    pkg = {
        "name": "cc2cc-server",
        "version": "3.0.0",
        "type": "module",
        "dependencies": {"@modelcontextprotocol/sdk": "^1.12.0"},
    }
    (bridge / "package.json").write_text(json.dumps(pkg, indent=2), encoding="utf-8")

    print("Installing MCP dependencies...")
    try:
        npm = shutil.which("npm") or ("npm.cmd" if sys.platform == "win32" else "npm")
        subprocess.run([npm, "install", "--silent"], cwd=str(bridge), check=True, capture_output=True)
        print("MCP dependencies installed.")
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("Warning: npm install failed (is Node.js installed?)")

    hooks_dst = bridge / "hooks"
    hooks_dst.mkdir(parents=True, exist_ok=True)
    for hook in ["session_start.py", "session_end.py", "inbox_watcher.py"]:
        src = repo_dir / "hooks" / hook
        if src.exists():
            shutil.copy2(src, hooks_dst / hook)

    scripts_dst = bridge / "scripts"
    scripts_dst.mkdir(parents=True, exist_ok=True)
    for script in ["send.py", "receive.py", "reply.py", "task.py", "status.py", "validate.py", "cleanup.py"]:
        src = repo_dir / "scripts" / script
        if src.exists():
            shutil.copy2(src, scripts_dst / script)

    print(f"\nBridge initialized at {bridge}\n")
    print("Add to your ~/.claude/settings.json:")
    print(json.dumps({
        "mcpServers": {
            "cc2cc": {
                "command": "node",
                "args": [str(bridge / "server.mjs")],
                "env": {"CC2CC_BRIDGE_DIR": str(bridge)},
            }
        }
    }, indent=2))


if __name__ == "__main__":
    main()

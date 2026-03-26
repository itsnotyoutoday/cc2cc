#!/usr/bin/env python3
"""Initialize CC2CC bridge between two agents."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def main():
    if len(sys.argv) < 3:
        print("Usage: init.py <agent-a> <agent-b> [bridge-dir]", file=sys.stderr)
        sys.exit(1)

    agent_a = sys.argv[1]
    agent_b = sys.argv[2]
    bridge = Path(sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser("~/.cc2cc"))
    repo_dir = Path(__file__).resolve().parent.parent

    print(f"Initializing CC2CC bridge: {agent_a} ↔ {agent_b} at {bridge}")

    # Mailboxes
    for a, b in [(agent_a, agent_b), (agent_b, agent_a)]:
        (bridge / f"{a}-to-{b}" / "inbox").mkdir(parents=True, exist_ok=True)
        (bridge / f"{a}-to-{b}" / "done").mkdir(parents=True, exist_ok=True)

    # Status & agent cards
    (bridge / "status").mkdir(parents=True, exist_ok=True)
    (bridge / "agent-cards").mkdir(parents=True, exist_ok=True)

    for agent in [agent_a, agent_b]:
        peer = agent_b if agent == agent_a else agent_a
        card = {
            "name": agent,
            "version": "1.0.0",
            "protocol": "cc2cc/1.1",
            "identity": {
                "agent_id": agent,
                "runtime": "claude-cli",
                "modes": {
                    "session": "Interactive session with user",
                    "heartbeat": "Autonomous periodic wake",
                },
            },
            "capabilities": {"taskDelegation": True, "persistent": False},
            "endpoint": f"file://{bridge}/{peer}-to-{agent}/inbox/",
        }
        (bridge / "agent-cards" / f"{agent}.json").write_text(
            json.dumps(card, indent=2), encoding="utf-8"
        )

    # MCP channel servers
    for agent in [agent_a, agent_b]:
        ch_dir = bridge / f"{agent}-channel"
        ch_dir.mkdir(parents=True, exist_ok=True)

        server_src = repo_dir / "channel" / "server.mjs"
        if server_src.exists():
            shutil.copy2(server_src, ch_dir / "server.mjs")
        else:
            print(f"Warning: channel/server.mjs not found, skipping MCP server for {agent}")

        pkg = {
            "name": f"cc2cc-channel-{agent}",
            "version": "1.1.0",
            "type": "module",
            "dependencies": {"@modelcontextprotocol/sdk": "^1.12.0"},
        }
        (ch_dir / "package.json").write_text(
            json.dumps(pkg, indent=2), encoding="utf-8"
        )

        print(f"Installing MCP dependencies for {agent}...")
        try:
            subprocess.run(
                ["npm", "install", "--silent"],
                cwd=str(ch_dir),
                check=True,
                capture_output=True,
            )
        except (subprocess.CalledProcessError, FileNotFoundError):
            print(f"Warning: npm install failed for {agent} (is Node.js installed?)")

    # Copy hooks
    hooks_dst = bridge / "hooks"
    hooks_dst.mkdir(parents=True, exist_ok=True)
    for hook in ["session_start.py", "session_end.py", "inbox_watcher.py"]:
        src = repo_dir / "hooks" / hook
        if src.exists():
            shutil.copy2(src, hooks_dst / hook)

    # Copy scripts
    scripts_dst = bridge / "scripts"
    scripts_dst.mkdir(parents=True, exist_ok=True)
    for script in ["send.py", "receive.py", "reply.py", "task.py", "status.py", "validate.py", "cleanup.py"]:
        src = repo_dir / "scripts" / script
        if src.exists():
            shutil.copy2(src, scripts_dst / script)

    print(f"\nBridge initialized at {bridge}\n")
    print("Next steps:")
    print("  1. Add MCP server + hooks to each agent's ~/.claude/settings.json")
    print("  2. See docs/CONFIGURATION.md for full settings.json examples")
    print("  3. (Optional) Set up service for auto-wake: see services/")
    print(f"\nQuick test:")
    print(f"  python {bridge}/scripts/send.py {agent_a} {agent_b} message \"Hello from {agent_a}\"")
    print(f"  python {bridge}/scripts/status.py")


if __name__ == "__main__":
    main()

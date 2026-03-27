#!/usr/bin/env python3
"""Unified CC2CC command-line interface.

Usage:
    cc2cc init [bridge-dir]
    cc2cc send <from> <to> <type> <content> [--priority P] [--mode M]
    cc2cc task <from> <to> <title> <description> [--priority P]
    cc2cc reply <msg-id> <text> [--from AGENT]
    cc2cc receive <agent> [--peek]
    cc2cc status
    cc2cc validate [--fix]
    cc2cc cleanup [--max-age-hours N] [--dry-run]
"""

import argparse
import subprocess
import sys
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent.parent


def _run_script(name: str, args: list):
    """Run a script from the repo's scripts/ or hooks/ directory."""
    script = REPO_DIR / name
    if not script.exists():
        print(f"Error: script not found: {script}", file=sys.stderr)
        sys.exit(1)
    cmd = [sys.executable, str(script)] + args
    sys.exit(subprocess.run(cmd).returncode)


def cmd_init(args):
    argv = []
    if args.bridge_dir:
        argv.append(args.bridge_dir)
    _run_script("scripts/init.py", argv)


def cmd_send(args):
    argv = [args.sender, args.recipient, args.type, args.content]
    if args.priority:
        argv.append(args.priority)
    if args.mode:
        argv.append(args.mode)
    _run_script("scripts/send.py", argv)


def cmd_task(args):
    argv = [args.sender, args.recipient, args.title, args.description]
    if args.priority:
        argv.append(args.priority)
    _run_script("scripts/task.py", argv)


def cmd_reply(args):
    argv = [args.msg_id, args.text]
    if args.sender:
        argv.append(args.sender)
    _run_script("scripts/reply.py", argv)


def cmd_receive(args):
    argv = [args.agent]
    if args.peek:
        argv.append("--peek")
    _run_script("scripts/receive.py", argv)


def cmd_status(args):
    _run_script("scripts/status.py", [])


def cmd_validate(args):
    argv = []
    if args.fix:
        argv.append("--fix")
    _run_script("scripts/validate.py", argv)


def cmd_cleanup(args):
    argv = []
    if args.max_age_hours:
        argv.extend(["--max-age-hours", str(args.max_age_hours)])
    if args.dry_run:
        argv.append("--dry-run")
    _run_script("scripts/cleanup.py", argv)


def main():
    parser = argparse.ArgumentParser(
        prog="cc2cc",
        description="CC2CC — Claude Code to Claude Code communication",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # init
    p = sub.add_parser("init", help="Initialize bridge")
    p.add_argument("bridge_dir", nargs="?", default=None)
    p.set_defaults(func=cmd_init)

    # send
    p = sub.add_parser("send", help="Send a message")
    p.add_argument("sender")
    p.add_argument("recipient")
    p.add_argument("type", choices=["message", "task", "status", "response"])
    p.add_argument("content")
    p.add_argument("--priority", choices=["low", "normal", "high", "critical"])
    p.add_argument("--mode", default=None)
    p.set_defaults(func=cmd_send)

    # task
    p = sub.add_parser("task", help="Delegate a task")
    p.add_argument("sender")
    p.add_argument("recipient")
    p.add_argument("title")
    p.add_argument("description")
    p.add_argument("--priority", choices=["low", "normal", "high", "critical"])
    p.set_defaults(func=cmd_task)

    # reply
    p = sub.add_parser("reply", help="Reply to a message")
    p.add_argument("msg_id")
    p.add_argument("text")
    p.add_argument("--from", dest="sender", default=None)
    p.set_defaults(func=cmd_reply)

    # receive
    p = sub.add_parser("receive", help="Read pending messages")
    p.add_argument("agent")
    p.add_argument("--peek", action="store_true")
    p.set_defaults(func=cmd_receive)

    # status
    p = sub.add_parser("status", help="Show bridge status")
    p.set_defaults(func=cmd_status)

    # validate
    p = sub.add_parser("validate", help="Validate message files")
    p.add_argument("--fix", action="store_true")
    p.set_defaults(func=cmd_validate)

    # cleanup
    p = sub.add_parser("cleanup", help="TTL-based message cleanup")
    p.add_argument("--max-age-hours", type=int)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_cleanup)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

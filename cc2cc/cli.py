#!/usr/bin/env python3
"""Unified CC2CC command-line interface.

Usage:
    cc2cc init <agent-a> <agent-b> [bridge-dir]
    cc2cc send <from> <to> <type> <content> [--priority P] [--mode M]
    cc2cc task <from> <to> <title> <description> [--priority P]
    cc2cc reply <msg-id> <text> [--from AGENT]
    cc2cc receive <agent> [--peek]
    cc2cc status
    cc2cc validate [--fix]
    cc2cc cleanup [--max-age-hours N] [--dry-run]
"""

import argparse
import sys


def cmd_init(args):
    from scripts.init import main as _init_main
    sys.argv = ["init.py", args.agent_a, args.agent_b] + ([args.bridge_dir] if args.bridge_dir else [])
    _init_main()


def cmd_send(args):
    from scripts.send import main as _send_main
    sys.argv = ["send.py", args.sender, args.recipient, args.type, args.content]
    if args.priority:
        sys.argv.append(args.priority)
    if args.mode:
        sys.argv.append(args.mode)
    _send_main()


def cmd_task(args):
    from scripts.task import main as _task_main
    sys.argv = ["task.py", args.sender, args.recipient, args.title, args.description]
    if args.priority:
        sys.argv.append(args.priority)
    _task_main()


def cmd_reply(args):
    from scripts.reply import main as _reply_main
    sys.argv = ["reply.py", args.msg_id, args.text]
    if args.sender:
        sys.argv.append(args.sender)
    _reply_main()


def cmd_receive(args):
    from scripts.receive import main as _receive_main
    sys.argv = ["receive.py", args.agent]
    if args.peek:
        sys.argv.append("--peek")
    _receive_main()


def cmd_status(args):
    from scripts.status import main as _status_main
    sys.argv = ["status.py"]
    _status_main()


def cmd_validate(args):
    import subprocess
    from pathlib import Path
    script = Path(__file__).resolve().parent.parent / "scripts" / "validate.py"
    cmd = [sys.executable, str(script)]
    if args.fix:
        cmd.append("--fix")
    sys.exit(subprocess.run(cmd).returncode)


def cmd_cleanup(args):
    import subprocess
    from pathlib import Path
    script = Path(__file__).resolve().parent.parent / "scripts" / "cleanup.py"
    cmd = [sys.executable, str(script)]
    if args.max_age_hours:
        cmd.extend(["--max-age-hours", str(args.max_age_hours)])
    if args.dry_run:
        cmd.append("--dry-run")
    sys.exit(subprocess.run(cmd).returncode)


def main():
    parser = argparse.ArgumentParser(
        prog="cc2cc",
        description="CC2CC — Claude Code to Claude Code communication",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # init
    p = sub.add_parser("init", help="Initialize bridge between two agents")
    p.add_argument("agent_a")
    p.add_argument("agent_b")
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

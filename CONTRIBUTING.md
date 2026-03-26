# Contributing to CC2CC

Thanks for your interest! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/non4me/cc2cc.git
cd cc2cc

# Create a test bridge (no Claude Code needed)
./scripts/init.sh alpha beta /tmp/cc2cc-dev

# Run the smoke test
./tests/smoke.sh
```

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run the tests: `./tests/smoke.sh`
4. If you changed bash scripts, run `shellcheck` on them
5. Submit a pull request

## Code Style

- **Bash:** `set -euo pipefail`, use `"$VAR"` quoting, pass file paths via arguments (not string interpolation into inline Python)
- **Python:** Standard library only, no third-party dependencies. Format with `black` if available.
- **JavaScript:** ES modules, no build step, minimal dependencies.

## What We'd Love Help With

- **HMAC message signing** — verify sender identity (see Security in README)
- **Message encryption** — encrypt content at rest
- **Linux LaunchAgent alternative** — systemd unit file for inbox watching
- **Windows/WSL support** — test and document WSL setup
- **Multi-peer MCP server** — single server handling N peers instead of one per peer
- **Tests** — more coverage, especially for edge cases in reply threading

## Reporting Issues

Open an issue with:
- Your OS and version
- Node.js and Python versions
- Steps to reproduce
- Relevant log output (check `/tmp/cc2cc-watcher-*.log` if using the inbox watcher)

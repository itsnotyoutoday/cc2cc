# CC2CC Installation Guide

How to install and run cc2cc, for a single account or for many accounts on one machine. For
joining agents **across machines**, see **[RELAY.md](RELAY.md)**.

The supported path is the installer, **`scripts/cc2cc-install.sh`** — interactive and idempotent
(safe to re-run). It has two scopes:

| Scope | Who | Bridge | Root? |
|-------|-----|--------|-------|
| **local** | one account | `~/.cc2cc` | no |
| **global** | all accounts on the host | `/var/lib/cc2cc` (shared) | yes (sudo/root) |

---

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, logged in
- **Node.js ≥ 18** (MCP server + daemon)
- **Python 3.8+** (signing, CLIs)
- For relay / teams / the operator CLI: a **venv** (`pip install -e .` pulls in `fastapi`,
  `uvicorn`, `pydantic`, and the `cc2cc` / `cc2cc-admin` commands). `tmux` is needed for
  `cc2cc-launch -t`.

```bash
git clone https://github.com/non4me/cc2cc.git ~/cc2cc && cd ~/cc2cc
```

---

## Local install (per-account)

No root required. Installs everything under your own account.

```bash
scripts/cc2cc-install.sh                 # interactive (asks scope; default local)
# or non-interactively:
scripts/cc2cc-install.sh --scope local
```

It will:
1. Create the bridge `~/.cc2cc` (`status/`, `identities/`).
2. Generate (or import) `secret.key` — it prompts: generate a fresh key for a standalone node, or
   import an existing shared key to join a relay mesh.
3. Register the `cc2cc` MCP server in your `~/.claude.json` via `claude mcp add` (absolute path).
4. Optionally set up the relay client / a local hub, and the Python tooling (venv + `cc2cc-admin`).
5. Optionally symlink `cc2cc`, `cc2cc-admin`, `cc2cc-launch`, `cc2cc-install` into `~/bin`.

Then bring an agent online:

```bash
cc2cc-launch <identity>      # foreground interactive (no identity → pick from a list)
cc2cc-launch -t <identity>   # in tmux, hands-free (auto-answers the startup menus)
```

---

## Machine-wide install (multi-user)

One operator sets up a shared bridge once; every account on the host then joins it. Useful when
several users (or several agent identities) on one machine should share a single mailbox + daemon.

### 1. Operator: the global install (root / sudo)

Run as **root**, or as a **sudo-capable user** — the installer elevates itself. When you're not
root it runs `sudo -v` first (one password prompt), then performs the privileged steps under
`sudo`; a non-sudo user is refused.

```bash
sudo scripts/cc2cc-install.sh --scope global
```

This creates:
- **Code** staged to `/opt/cc2cc` (so services don't reference a home dir)
- **Shared bridge** `/var/lib/cc2cc`, `setgid 2770`, group **`cc2cc`** (so members share it)
- A system **user + group `cc2cc`**, and a **venv** at `/opt/cc2cc/venv`
- **`secret.key`** (mode `640`, `root:cc2cc`) — prompts generate-new vs import-shared
- **systemd system services**: `cc2cc-daemon` (always) and `cc2cc-hub` (if you opt into a relay
  hub), `enable --now`
- PATH symlinks: `cc2cc` / `cc2cc-launch` / `cc2cc-install` → `/usr/local/bin`,
  `cc2cc-admin` → `/usr/local/sbin`
- `CC2CC_ENCRYPT=1` is forced (a shared multi-user bridge always encrypts relay traffic)

### 2. Grant each account access to the shared secret

The shared `secret.key` is `640 root:cc2cc`, so each human account must be in the `cc2cc` group to
read it. Let the installer do it (repeatable; re-run any time to add more):

```bash
sudo scripts/cc2cc-install.sh --scope global --add-user alice --add-user bob
# equivalently, by hand:
sudo usermod -aG cc2cc alice
```

Each added user then logs out/in (or runs `newgrp cc2cc`) for the group to take effect.

### 3. Each account joins the shared bridge

`register-client` only edits **that user's own** `~/.claude.json`, so it needs no sudo:

```bash
# as alice:
cc2cc-install.sh register-client --bridge /var/lib/cc2cc
```

You can also just run `cc2cc-install.sh` with no arguments — it detects the existing global
install and offers to register your account automatically.

Then launch as usual: `cc2cc-launch <identity>`.

> Privilege model: standing up **or** tearing down the machine-wide install requires root/sudo;
> joining it (`register-client`) and the entire local scope never do.

---

## Verifying

From inside a launched session, or via the CLIs:
- `whoami` — your identity, teams, and relay status
- `list_agents` — who's online (local, and remote agents if a relay is configured)

---

## Uninstall

Scope-aware and reversible; it confirms before deleting any data.

```bash
cc2cc-install.sh uninstall --scope local       # removes your MCP entry, ~/bin links; asks before rm ~/.cc2cc
sudo cc2cc-install.sh uninstall --scope global # stops/removes services, /etc/cc2cc, symlinks; asks before rm /var/lib/cc2cc and /opt/cc2cc
```

Global uninstall is privilege-gated (root/sudo) just like global install. The per-user MCP-entry
removal at the top of any uninstall touches only your own `~/.claude.json`.

---

## Manual install (no installer)

If you'd rather wire it by hand, see the **Manual installation** block in the
[README](../README.md#quick-start): clone, `pip install -e .`, then register the MCP server in
`~/.claude.json` (an **absolute** path — `node` does not expand `~`):

```bash
claude mcp add --scope user cc2cc \
  --env CC2CC_BRIDGE_DIR="$HOME/.cc2cc" \
  -- node "$HOME/.cc2cc/server.mjs"
```

Launch with `claude --dangerously-load-development-channels server:cc2cc`.

---

## Next steps

- **Teams** (membership, leaders, provisioning): see [SPECIFICATION.md](SPECIFICATION.md#9-teams--routing) and the `cc2cc-admin` CLI in [CONFIGURATION.md](CONFIGURATION.md#teams--provisioning).
- **Cross-machine relay** (running a hub, connecting a client): see [RELAY.md](RELAY.md).
- **Configuration** (environment variables): see [CONFIGURATION.md](CONFIGURATION.md).

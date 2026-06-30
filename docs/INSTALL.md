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

> **Identity names are lowercase** (letters/digits/hyphens, start alphanumeric, ≤31 chars). A
> capitalized name like `John` is auto-lowercased to `john` (with a notice); a name that can't be
> normalized is rejected. Provision identities/teams first with `cc2cc-admin team create` /
> `cc2cc-admin member add`. Root **can** launch — it runs without `--dangerously-skip-permissions`,
> so normal permission prompts apply.

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
- **systemd system services**: `cc2cc-daemon` (always, in **service mode** — always-on, no
  idle-exit, with `CC2CC_TEAM=<node name>`) and `cc2cc-hub` (if you opt into a relay hub),
  plus an umbrella **`cc2cc.target`** that controls them together, all `enable --now`. On a host
  without systemd, run an always-on daemon with `cc2cc-admin daemon start --service` instead.
- A **node identity** in `/var/lib/cc2cc/connections.json` (`self.id` seeded from `/etc/machine-id`,
  unique per machine; `self.name` = the node name, default = `hostname`, set with `--node-name NAME`,
  stable across reinstalls). The node name is also the **default team** for agents that don't set
  `CC2CC_TEAM`.
- PATH symlinks: `cc2cc` / `cc2cc-launch` / `cc2cc-install` → `/usr/local/bin`,
  `cc2cc-admin` → `/usr/local/sbin`
- `CC2CC_ENCRYPT=1` is forced (a shared multi-user bridge always encrypts relay traffic)

> **Ownership recap (global):** `/opt/cc2cc` is `root:cc2cc` and **not** group-writable (system
> code). The bridge `/var/lib/cc2cc` is `cc2cc:cc2cc` with setgid dirs (`2770`); `secret.key` is
> `640 cc2cc:cc2cc`; `connections.json` is `660` (it holds the hub token); `/etc/cc2cc/hub.env` is
> `640 root:cc2cc`.

#### Controlling the node (systemd)

Start/stop/restart the whole node — daemon (+ hub) — through the umbrella target:

```bash
sudo systemctl start cc2cc.target      # or stop | restart
systemctl status cc2cc.target
```

> ⚠️ There is **no bare `cc2cc` unit** — `systemctl start cc2cc` / `service cc2cc start` do **not**
> work (they default to `.service`). Type the `.target` suffix, or address `cc2cc-daemon` /
> `cc2cc-hub` individually.

#### Non-interactive (flag-driven) global install

```bash
sudo cc2cc-install install --scope global --hub --non-interactive [--node-name NAME] [--secret-key PATH]
```

`--non-interactive` skips all prompts (flags + defaults only). `--secret-key PATH` imports an
existing shared key (to join an existing mesh hands-free) instead of generating a new one.

### 2. Grant each account access to the shared secret

A human account must be in the **`cc2cc` group** to use the global bridge. This is because the MCP
runs **as the human** and reads `secret.key` (mode `640 cc2cc:cc2cc`) to do the end-to-end
encryption, *and* writes the agent's identity/heartbeat into the bridge. (The daemon, which runs as
the `cc2cc` service user, does **not** need the key — it only relays ciphertext.) Let the installer
add members (repeatable; re-run any time to add more):

```bash
sudo scripts/cc2cc-install.sh --scope global --add-user alice --add-user bob
# equivalently, by hand:
sudo usermod -aG cc2cc alice
```

> Group membership only takes effect in a **new login session** — `usermod -aG` / `--add-user` does
> **not** affect already-running sessions. Each added user logs out/in (or runs `newgrp cc2cc`).
> `cc2cc-launch` now auto-activates the group via `sg` (it re-execs itself, and for tmux wraps the
> agent command), so you don't have to re-login to launch. If you're **not** a member, `cc2cc-launch`
> stops with a clear message telling you to ask an admin to run
> `sudo cc2cc-install install --scope global --add-user <you>`, then re-login.

### 3. Each account joins the shared bridge

`register-client` only edits **that user's own** `~/.claude.json`, so it needs no sudo — and no
path: it auto-detects the global bridge `/var/lib/cc2cc`, resolves the MCP server to the staged
`/opt/cc2cc/channel/server.mjs`, and auto-enables encryption:

```bash
# as alice:
cc2cc-install.sh register-client
```

You can also just run `cc2cc-install.sh` with no arguments — it detects the existing global
install and offers to register your account automatically.

Then launch as usual: `cc2cc-launch <identity>`. To un-join later, `cc2cc-install.sh
unregister-client` removes just this user's `cc2cc` MCP entry from `~/.claude.json`.

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
sudo cc2cc-install.sh uninstall --scope global # stops/removes services + cc2cc.target, /etc/cc2cc, symlinks; asks before rm /var/lib/cc2cc and /opt/cc2cc
```

Global uninstall is privilege-gated (root/sudo) just like global install. It **no longer touches**
`~/.claude.json` — that's a per-user artifact. Each user un-registers themselves with
`cc2cc-install.sh unregister-client` (or `claude mcp remove --scope user cc2cc`). Only the **local**
uninstall removes the invoking user's own MCP entry.

---

## Manual install (no installer)

If you'd rather wire it by hand, see the **Manual installation** block in the
[README](../README.md#quick-start): clone, `pip install -e .`, then register the MCP server in
`~/.claude.json`. The server file lives in the repo at `channel/server.mjs` (the bridge dir is
separate); use an **absolute** path — `node` does not expand `~`:

```bash
claude mcp add --scope user cc2cc \
  --env CC2CC_BRIDGE_DIR="$HOME/.cc2cc" \
  -- node "$HOME/cc2cc/channel/server.mjs"
```

This matches exactly what the installer's `register_mcp` writes: command `node`, args
`[<repo>/channel/server.mjs]`, env `CC2CC_BRIDGE_DIR=<bridge>` (plus `CC2CC_ENCRYPT=1` when
encryption is on).

Launch with `claude --dangerously-load-development-channels server:cc2cc`.

---

## Next steps

- **Teams** (membership, leaders, provisioning): see [SPECIFICATION.md](SPECIFICATION.md#9-teams--routing) and the `cc2cc-admin` CLI in [CONFIGURATION.md](CONFIGURATION.md#teams--provisioning).
- **Cross-machine relay** (running a hub, connecting a client): see [RELAY.md](RELAY.md).
- **Configuration** (environment variables): see [CONFIGURATION.md](CONFIGURATION.md).

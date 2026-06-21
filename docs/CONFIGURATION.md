# CC2CC Configuration Guide

> Version: 3.x (teams + relay) | Date: 2026-06-21

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CC2CC_BRIDGE_DIR` (alias `BRIDGE_DIR`, Node) | `~/.cc2cc` | Bridge root directory |
| `CC2CC_IDENTITY` (aliases `SELF`, `CC2CC_SELF`) | auto-generated | This session's agent name. If unset, the server stays dormant until `register()` is called. |
| `CC2CC_TEAM` | `cc2cc` | Comma-separated teams seeded into a **new** identity; also the daemon's hub-registered team. An existing identity file wins over this. |
| `CC2CC_ENCRYPT` | unset | `=1` enables AES-256-GCM relay encryption. **Mandatory for the relay.** |
| `CC2CC_RELAY_TOKEN` | — | Relay hub auth token (server side; the hub refuses to start without one). |
| `CC2CC_HUB_TOKEN` | `PEERTEST` | `starthub.sh` launcher: hub token |
| `CC2CC_HUB_PORT` | `10322` | `starthub.sh` launcher: hub port |
| `CC2CC_HUB_HOST` | `127.0.0.1` | `starthub.sh` launcher: hub bind host |
| `CC2CC_PY` | `python3` | `starthub.sh` launcher: Python interpreter |
| `CC2CC_REMOTE_ACTIVE_MS` | `60000` | Remote-team "active" window (ms) |
| `CC2CC_REMOTE_EXPIRE_MS` | ~4 days | Remote-team expiry window (ms) |
| `CC2CC_DEBUG` | unset | Log relay poll failures and extra diagnostics |

> **Removed:** `CC2CC_ROLE` and `PEER` are no longer used. Roles are **derived** from `teams.json`,
> and there is no single peer (the old `SELF`/`PEER`/`peer_channel` model is gone). `SELF` /
> `CC2CC_SELF` survive only as aliases for `CC2CC_IDENTITY`.

---

## MCP Server Configuration

MCP servers are configured in `~/.claude.json` (NOT `~/.claude/settings.json`). Add a `cc2cc` entry
to `mcpServers`:

```json
{
  "mcpServers": {
    "cc2cc": {
      "command": "node",
      "args": ["~/.cc2cc/channel/server.mjs"],
      "env": {
        "CC2CC_BRIDGE_DIR": "~/.cc2cc",
        "CC2CC_IDENTITY": "alpha",
        "CC2CC_TEAM": "cc2cc"
      }
    }
  }
}
```

> **Windows:** use full paths with escaped backslashes, e.g.
> `"C:\\Users\\YOU\\.cc2cc\\channel\\server.mjs"`.

The same MCP config is used by every Claude Code instance. Each session resolves its own identity
from `CC2CC_IDENTITY` (or registers a name at runtime). The per-host **daemon** is auto-spawned by
the MCP on demand — you do not configure it separately.

### Launching

You can launch Claude Code with the development channel loaded directly:

```bash
claude --dangerously-load-development-channels server:cc2cc
```

Or use the helper scripts, which wire up the bridge, MCP config, and launch flags for you:

```bash
scripts/cc2cc-install.sh        # interactive/idempotent installer (local or global scope)
scripts/cc2cc-launch.sh         # launch a configured session
```

> `cc2cc-install.sh` supports `--scope local|global`, `--relay`, `--hub`, `--encrypt`, and a
> `register-client` action to point an additional account's `~/.claude.json` at an existing shared
> bridge. (The legacy `cc2cc init alpha beta` per-agent layout is obsolete.)

---

## Teams & Provisioning

Teams and members are administered with the `cc2cc-admin` CLI (note the hyphen):

```bash
cc2cc-admin team create nexus --admission open --retention-days 4
cc2cc-admin member add alpha --team nexus       # provision a local identity + admit
cc2cc-admin team admit nexus beta               # admit an existing member
cc2cc-admin team leader nexus alpha             # operator override of the leader
cc2cc-admin member revoke beta --team nexus     # tombstone (revoke participation)
cc2cc-admin gab                                 # show the federated Global Address Book
cc2cc-admin policy show                         # effective federation policy
```

Roles are derived: a member listed as a team's `leader` in `teams.json` is the leader; everyone
else is a member. Agents create teams at runtime with the `create_team` tool (the caller becomes
leader) and request membership with `request_join` / `admit`.

---

## Shared Secret & Encryption

`secret.key` (in the bridge root) is the single shared secret:

- **Local:** used directly as the HMAC-SHA256 key for message signing.
- **Relay:** the AES-256-GCM key is derived from it via `scrypt` (fixed domain-separation salt), so
  every peer derives the same key.

It is generated automatically during setup. For a **cross-machine relay**, every participating host
must have a **byte-identical `secret.key`** and must set `CC2CC_ENCRYPT=1` — otherwise the relay
refuses to activate (fail-closed). The per-machine `machine.secret` (auto-created, mode 0600) binds
your `machine_id` to the hub on first use; do not copy it between machines.

To regenerate the shared secret: stop all sessions, delete `secret.key` on every host, re-run setup,
and redistribute the new key.

---

## Running a Relay Hub

The hub (`relay_hub.py`, FastAPI, in-memory, zero-knowledge) brokers ciphertext between machines.
It **refuses to start without a token**:

```bash
CC2CC_RELAY_TOKEN=mytoken python3 relay_hub.py        # or: relay_hub.py --token mytoken
./starthub.sh                                          # launcher (CC2CC_HUB_TOKEN/PORT/HOST/PY)
```

Then point each machine's client config at it. Relay config lives in `connections.json` in the
bridge (legacy flat `relay.json` is also read); see `connections.example.json`. Agents can also
register a relay at runtime with the `register_relay` tool
(`{hub_url, token, team, enabled}`).

---

## Hooks (Optional)

Hooks are configured in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "python ~/.cc2cc/hooks/session_start.py",
            "env": { "CC2CC_BRIDGE_DIR": "~/.cc2cc" }
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "python ~/.cc2cc/hooks/session_end.py",
            "env": { "CC2CC_BRIDGE_DIR": "~/.cc2cc" }
          }
        ]
      }
    ]
  }
}
```

---

## Auto-Wake / Inbox Watcher (Optional)

A background watcher gives desktop notifications when messages arrive. (Inline wake-up during a
session is handled by the daemon's `{wake}` push; this watcher is for notifications when no session
is focused.)

**macOS (LaunchAgent):**
```bash
cp services/macos/com.cc2cc.inbox-watcher.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.cc2cc.inbox-watcher.plist
```

**Linux (systemd):**
```bash
cp services/linux/cc2cc-watcher.service ~/.config/systemd/user/
systemctl --user enable --now cc2cc-watcher
```

**Windows (Task Scheduler):**
```powershell
schtasks /create /tn "CC2CC Watcher" /xml services\windows\cc2cc-watcher.xml
```

**Or run manually:**
```bash
CC2CC_IDENTITY=alpha CC2CC_BRIDGE_DIR=~/.cc2cc python hooks/inbox_watcher.py
```

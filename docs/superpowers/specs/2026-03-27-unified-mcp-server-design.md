# CC2CC Unified MCP Server — Design Spec

> Date: 2026-03-27 | Version: 3.0.0

## Problem

Current server requires `SELF`/`PEER` env vars hardcoded in `settings.json`. Since all Claude Code instances on one machine share the same settings, this forces users to either use separate project directories or manually configure each agent. This is an artificial limitation.

## Solution

Single MCP server with dynamic identity. No `SELF`/`PEER` required. Each Claude instance starts the same server, which auto-generates a unique name and self-registers. Agents discover each other through heartbeat files.

## Architecture

### One config for all instances

```json
{
  "mcpServers": {
    "cc2cc": {
      "command": "node",
      "args": ["~/.cc2cc/server.mjs"],
      "env": {
        "CC2CC_BRIDGE_DIR": "~/.cc2cc"
      }
    }
  }
}
```

No `SELF`, no `PEER`. Only `CC2CC_BRIDGE_DIR` (optional, defaults to `~/.cc2cc`).

### Server startup sequence

1. Generate name from dictionary (`brave-fox`)
2. Write heartbeat to `status/brave-fox-heartbeat.json` with `status: "active"`
3. Create inbox directory: `to-brave-fox/inbox/`, `to-brave-fox/done/`, `to-brave-fox/receipts/`
4. Start polling own inbox + status directory
5. Push channel notification: "You are **brave-fox**. Online agents: calm-owl, red-bear"
6. Push to all others (via files): "brave-fox joined"

### Server shutdown

1. Update heartbeat to `status: "offline"` immediately
2. Other servers detect on next poll cycle → notify their agents: "brave-fox left"

### Directory structure (new)

```
~/.cc2cc/
├── secret.key
├── server.mjs                    # Single server (no per-agent copies)
├── package.json
├── node_modules/
├── status/
│   ├── brave-fox-heartbeat.json
│   └── calm-owl-heartbeat.json
├── to-brave-fox/
│   ├── inbox/                    # Messages TO brave-fox
│   ├── done/
│   └── receipts/
├── to-calm-owl/
│   ├── inbox/                    # Messages TO calm-owl
│   ├── done/
│   └── receipts/
├── hooks/
└── scripts/
```

Old per-pair format (`alpha-to-beta/`) replaced by per-recipient (`to-{name}/`).

### All runtime files stay in `~/.cc2cc/`

Nothing is created in the project working directory. No files enter git scope. The repository contains only source code — the bridge directory is always external.

## Tools API

### `register` — rename agent

- Input: `{ name: string }`
- Renames `to-brave-fox/` → `to-devops/`, updates heartbeat, notifies others
- Validation: `[a-z0-9][a-z0-9-]{0,30}`
- Error if name taken by active agent

### `whoami` — get own identity

- Input: none
- Output: `{ name: "brave-fox", online_since: "...", bridge_dir: "..." }`

### `send` — send message to specific agent

- Input: `{ to: string, text: string, type?: "message"|"task"|"response", priority?: "low"|"normal"|"high"|"critical" }`
- Writes JSON to `to-{recipient}/inbox/`
- If recipient offline: writes file + returns `"agent X is offline, message queued"`

### `broadcast` — send to all active agents

- Input: `{ text: string, priority?: string }`
- Writes copy to `to-{agent}/inbox/` for each agent from `status/`
- Returns: list of delivered + offline agents

### `reply` — reply to a message (threading)

- Input: `{ msg_id: string, text: string }`
- Finds original message, determines `to` from original's `from` field
- If original was task → sets `task.status: "completed"` automatically

### `list_agents` — list all known agents

- Input: none
- Output: `[{ name: "calm-owl", status: "active", last_seen: "2s ago" }, ...]`

## Polling & Notifications

### Two poll cycles (both every 3 seconds)

**Inbox poll** — `to-{self}/inbox/*.json`:
- New file → read JSON → push channel notification to agent
- Format: `[from: calm-owl] [type: message] text...`
- Write receipt to `to-{self}/receipts/`
- Move file to `to-{self}/done/`

**Status poll** — `status/*-heartbeat.json`:
- Track heartbeat changes of other agents
- `active → offline` (or heartbeat older than 30s) → push: "calm-owl went offline"
- `offline → active` → push: "calm-owl joined"
- New agent (unknown heartbeat) → push: "calm-owl joined (new agent)"

### Heartbeat refresh

- Own heartbeat rewritten every 15 seconds
- Agent considered offline if heartbeat older than 30 seconds
- Graceful shutdown: heartbeat updated to `status: "offline"` immediately

### TTL expiration with sender notification

- During inbox poll, check files for TTL expiry
- If `timestamp + ttl < now` → move to `done/`, write notification to sender:
  - Type `status`, text: "Your message msg-XXX to {self} expired (TTL {ttl}s)"
  - Written to `to-{sender}/inbox/`

## Name Generation

### Built-in dictionary

```
adjectives (20): brave, calm, swift, bold, keen, wise, fair, warm, wild, cool,
                  bright, quick, sharp, proud, free, true, kind, pure, deep, clear

animals (20):    fox, owl, bear, wolf, hawk, deer, lynx, crow, hare, seal,
                  dove, swan, toad, moth, wren, lark, bass, crab, newt, wasp
```

### Algorithm

1. Read all heartbeats from `status/` → collect Set of taken names
2. Generate random `adjective-animal` combination
3. If taken → retry (up to 10 attempts)
4. 20×20 = 400 possible names — sufficient for same-machine scenarios

### `register(name)` validation

- Accepts arbitrary string (not required to be from dictionary)
- Format: `[a-z0-9][a-z0-9-]{0,30}`
- Must not conflict with active agent name

## Backwards Compatibility

### Old directory format supported

- Server checks for `*-to-{self}/inbox/` directories (old per-pair format)
- Polls them alongside new `to-{self}/inbox/`
- New messages always written in new format

### `SELF`/`PEER` env vars

- If `SELF` is set → used as agent name instead of auto-generation
- `PEER` is ignored (no longer needed)
- Allows gradual migration without breaking existing setups

### `init.py`

- Still used for initial bridge setup (create `~/.cc2cc/`, generate `secret.key`, install npm deps)
- No longer creates per-pair directories or copies per-agent server files
- Single `server.mjs` at bridge root

### Scripts

- `send.py`, `receive.py`, etc. updated for new `to-{name}/` format
- Continue to work standalone (without MCP server) for manual use

## Testing

### Unit tests (Python)

- Name generation: uniqueness, collisions, format validation
- New directory format: `to-{name}/inbox/`
- Backwards compatibility: reading from `alpha-to-beta/inbox/`
- Broadcast: creates files in each active agent's inbox
- TTL expiration: expired message → notification to sender
- Register: rename, name conflict error

### Integration tests (Python, subprocess)

- Scripts work with new directory format
- `send.py` new format → `receive.py` reads
- Heartbeat lifecycle: active → offline
- Backwards compatibility: old format messages delivered

### MCP server tests (Node.js)

- Server starts without `SELF`/`PEER` → generates name, creates inbox
- Server starts with `SELF=alpha` → uses "alpha" as name
- Tools: `whoami`, `list_agents`, `send`, `broadcast`, `reply`, `register` — input/output validation
- Join/leave notifications on heartbeat changes
- Two servers in parallel → discover each other via heartbeats

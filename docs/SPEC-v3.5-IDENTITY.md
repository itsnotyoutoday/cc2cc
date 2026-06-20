# cc2cc Bridge v3.5 — Part 1: Persistent Identity System

**Status**: Draft Spec | **Owner**: swift-newt (implementation) | **QA**: fair-wren (PM)
**Dependencies**: None — this is the foundation for Parts 2 & 3

---

## 1. Problem Statement

Currently, every time the MCP server starts, it generates a fresh ephemeral name via `generateUniqueName()` in `names.mjs`. This means:

- Agents get a **new name every session restart** — no continuity
- The MCP server (`SELF` env var → `fair-wren`) and hooks (`CC2CC_SELF` env var → `Rocks-MacBook-Air`) **resolve to different names**
- `cleanupStaleMailboxes()` runs on startup but can't properly distinguish "my old mailbox" from "orphaned mailbox" because the name changed
- Agents have no stable identifier — no `agent_id`, no concept of "this is the same agent as last session"

## 2. Solution: `identity.json`

A single JSON file at `BRIDGE_DIR/identity.json` that persists across sessions.

### 2.1 File Format

```json
{
  "display_name": "bright-hare",
  "agent_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "created": "2026-06-18T12:00:00Z",
  "teams": ["cc2cc"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `display_name` | string | Public agent name (used for inbox paths, heartbeats, addressing) |
| `agent_id` | string | UUID v4 — stable forever, survives name changes |
| `created` | string (ISO 8601) | Timestamp of first identity creation |
| `teams` | array of strings | Team memberships (default `["cc2cc"]`, used in Part 2) |

### 2.2 File Location

`{BRIDGE_DIR}/identity.json` where `BRIDGE_DIR` defaults to `~/.cc2cc/`.

### 2.3 Identity Flow

```
startup:
  1. candidate_name = SELF env var ?? generateUniqueName()
  2. identity = loadIdentity(IDENTITY_PATH)
  3. if identity exists:
       agentName = identity.display_name  (overrides candidate_name)
     else:
       identity = createIdentity(candidate_name)  // generates UUID, writes file
       agentName = candidate_name
  4. agentIdentity = identity  (in-memory state)
  5. proceed with rest of startup (cleanup, dirs, heartbeat, polling)
```

### 2.4 Name Claim Flow

Existing `register` tool should be extended to update `identity.json`:

```
register(new_name):
  1. Validate name format
  2. Check name not taken by another agent
  3. Update identity.json: display_name = new_name
  4. Rename agent, create new dirs
  5. Notify others
```

## 3. Files to Modify

### 3.1 `~/.cc2cc/server.mjs` — Primary changes

**New constants** (after line ~41):
```javascript
const IDENTITY_PATH = join(BRIDGE_DIR, "identity.json");
```

**New state variable** (after line ~54):
```javascript
let agentIdentity = null;  // {display_name, agent_id, created, teams}
```

**New functions** (around line ~95):

1. `loadIdentity()` — reads IDENTITY_PATH, returns parsed object or null
2. `createIdentity(name)` — generates UUID v4, constructs identity object, writes file atomically, returns object
3. `saveIdentity(identity)` — atomic write to IDENTITY_PATH
4. `ensureIdentity(candidateName)` — calls loadIdentity → if exists, returns identity; if not, calls createIdentity(candidateName) and returns it

**Modified `init()` (lines 1024-1139)**:

Current order:
```
1. Determine name from SELF env or generateUniqueName()
2. Load rules + encryption key
3. cleanupStaleMailboxes()
4. Create dirs, heartbeat
5. Start polling, connect transport
```

New order:
```
1. Determine candidate name from SELF env or generateUniqueName()
2. ensureIdentity(candidateName)  → loads or creates identity.json
3. agentName = identity.display_name
4. Load rules + encryption key
5. cleanupStaleMailboxes()         // now runs with persistent name — won't delete own mailbox
6. Create dirs, heartbeat (include teams from identity)
7. Start polling, connect transport
```

**Modified `handleWhoami()` (lines 406-413)**:

```javascript
function handleWhoami() {
  return jsonResult({
    name: agentName,
    agent_id: agentIdentity?.agent_id || "unset",
    teams: agentIdentity?.teams || [],
    registered: !!agentIdentity,
    identity_file: IDENTITY_PATH,
    online_since: onlineSince,
    bridge_dir: BRIDGE_DIR,
    online_agents: onlineAgentNames(),
  });
}
```

**Modified `handleRegister()` (lines 558-609)**:

After registering a new name, also update identity.json:
```javascript
// After old heartbeat cleanup and before new dir creation:
if (agentIdentity) {
  agentIdentity.display_name = validatedName;
  saveIdentity(agentIdentity);
}
```

### 3.2 `~/.cc2cc/hooks/session_start.py` — Secondary changes

**Modified `main()`**: Read identity.json before determining self_id:

```python
self_id = os.environ.get("CC2CC_SELF", None)
if not self_id:
    identity_file = bridge / "identity.json"
    if identity_file.exists():
        try:
            identity = json.loads(identity_file.read_text(encoding="utf-8"))
            self_id = identity.get("display_name")
        except (json.JSONDecodeError, KeyError, OSError):
            pass
if not self_id:
    self_id = socket.gethostname().split(".")[0]
```

### 3.3 `~/.cc2cc/hooks/session_end.py` — Same fix

Same pattern as session_start.py above.

### 3.4 `~/.cc2cc/names.mjs` — Optional cleanup

`generateUniqueName()` still serves as fallback when no SELF env var and no identity.json exists. No changes required, but the function is now a fallback rather than primary path.

## 4. UUID Generation

Use Node.js built-in `crypto.randomUUID()`:

```javascript
import { randomUUID } from "node:crypto";
const agentId = randomUUID();
```

Available in Node.js 19+. Current cc2cc requires Node.js 18+ (check package.json engine field).

## 5. Edge Cases

| Scenario | Behavior |
|----------|----------|
| identity.json exists but is corrupted (invalid JSON) | Log warning, back up to identity.json.corrupted, create fresh identity |
| identity.json exists but missing required fields | Treat as corrupted — regenerate |
| identity.json display_name conflicts with SELF env var | identity.json wins (it's the source of truth) |
| identity.json display_name already taken by another agent | Append hex suffix (same strategy as generateUniqueName fallback) |
| First boot with no identity.json and no SELF env | Generate name via generateUniqueName(), save as identity.json |
| identity.json exists but mailbox was deleted externally | Re-create mailbox dirs in init() (already handled by current mkdir calls) |

## 6. Acceptance Criteria

1. **whoami returns agent_id** — same UUID before and after server restart
2. **whoami returns teams** — default `["cc2cc"]`
3. **whoami returns registered: true** — identity.json exists
4. **Reboot test**: Stop server, restart — agent name is identical
5. **Hook alignment**: session_start.py and session_end.py use same name as MCP server
6. **Corruption recovery**: Delete identity.json → fresh identity created on next start
7. **Name take-over**: If identity.json name is taken by another online agent, fallback with hex suffix

## 7. Implementation Order

1. Add constants + state variable to server.mjs
2. Write `loadIdentity()`, `createIdentity()`, `saveIdentity()`, `ensureIdentity()` functions
3. Modify `init()` startup order
4. Modify `handleWhoami()`
5. Modify `handleRegister()` to update identity.json
6. Fix `session_start.py` and `session_end.py`
7. Run reboot test

---

*End of Part 1 Spec — ready for implementation by swift-newt*

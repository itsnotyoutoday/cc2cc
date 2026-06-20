# cc2cc Bridge v3.6 Addendum — Rich Agent Status

**Status**: Approved | **Owner**: fair-wren (PM)
**Depends On**: v3.5 (Relay)

---

## 1. Problem Statement

The current agent status system is binary (`online`/`offline`). This lacks the granularity needed for effective team coordination. Project managers and other agents cannot see *what* an agent is working on, only that they are available. This leads to unnecessary status check messages and ambiguity about an agent's current task load.

**Note on Detection Latency**: Due to heartbeat liveness, a rich status may persist for up to `HEARTBEAT_STALE_S` (approx 15s) after an abrupt crash before the agent is marked offline and the status is suppressed.

## 2. Proposed Solution

Introduce a "rich status" feature that allows agents to self-declare their current activity. This will be a short, free-text string that is broadcast via the heartbeat mechanism and visible in `list_agents`.

This involves two main changes:
1.  A new tool, `set_status`, for an agent to update its status.
2.  An expansion of the heartbeat data structure to include the new status field.

## 3. Cross-Machine Propagation (Relay v3.5 Dependency)

**This feature is scoped for both local and cross-machine visibility.** 

> **GATING NOTICE**: Implementation of Section 3 is gated behind QC sign-off of the v3.5 Relay Hub fixes (B1-B10, H1-H4). The wire-format change was partially implemented in free-hawk's fixes — pollCycle already parses `agents` as `{name: {status_text}}` objects (B3 fix).

### 3.0 Architecture — The Three Links

Cross-machine propagation requires three links in the chain:

```
Link #1 (MISSING)         Link #2 (WORKS)           Link #3 (WORKS)
relay.mjs ──agents──▸    relay_hub.py ──agents──▸  relay.mjs
  doHeartbeat()            /api/heartbeat            pollCycle()
  reads status/ dir        stores reg.agents         parses agents obj
  ── NEEDS IMPLEMENTATION  already implemented       already implemented
```

- **Link #1 (MISSING)**: `relay.mjs` calls `/api/keepalive` but NEVER sends agent roster data. The hub's `/api/heartbeat` endpoint exists and accepts `agents: dict[str, dict]` but is never called.
- **Link #2 (WORKS)**: Hub `/api/heartbeat` stores `reg.agents = req.agents` (relay_hub.py:248). `/api/keepalive` only refreshes `last_seen` (line 238) and does not touch agents — this is correct; agents should only be updated by heartbeat.
- **Link #3 (WORKS)**: `pollCycle()` parses `data.agents` as `{name: {status_text: "..."}}` object format (relay.mjs:232-236, added in B3 fix).

### 3.1 Design Decision — Fold Into `/api/heartbeat`

**Decision**: Do NOT modify `/api/keepalive`. Use the existing `/api/heartbeat` endpoint for agent roster data.

**Rationale**:
1. `/api/keepalive` is a lightweight liveness ping — adding agent data conflates concerns
2. `/api/heartbeat` already exists and accepts `agents: dict[str, dict]` — zero hub changes needed
3. Clear separation: keepalive = "I'm online", heartbeat = "Here's my current state"
4. The `/api/heartbeat` endpoint also refreshes `last_seen`, so keepalive remains optional if heartbeat covers both

### 3.2 Link #1 Implementation — Sending Agent Roster

**Location**: `relay.mjs`, `doHeartbeat()` function (line 163)

**Current code**:
```javascript
export async function doHeartbeat(dir, teamName) {
  if (!relayEnabled || !config) return;
  await apiPost(`${hubUrl}/api/keepalive`, { token, machine_id: machineId, team: teamName });
}
```

**Proposed implementation**:
```javascript
export async function doHeartbeat(dir, teamName) {
  if (!relayEnabled || !config) return;

  // Read local agent statuses from the status directory
  let agents = {};
  const statusDir = join(dir, "status");
  try {
    const files = await readdir(statusDir);
    for (const file of files) {
      if (!file.endsWith("-heartbeat.json")) continue;
      const agentName = file.replace("-heartbeat.json", "");
      const raw = await readFile(join(statusDir, file), "utf8");
      const hb = JSON.parse(raw);
      const hbAge = (Date.now() - new Date(hb.timestamp).getTime()) / 1000;

      // MUST: filter to relay-registered team only — prevent other-team leakage
      const agentTeams = hb.teams || [];
      if (!agentTeams.includes(teamName)) continue;

      // MUST: use HEARTBEAT_STALE_S for presence accuracy, not 2× stale
      if (hbAge > HEARTBEAT_STALE_S) continue;

      agents[agentName] = { status_text: hb.status_text || "Idle" };
    }
  } catch (_) {
    // Status directory may not exist — non-fatal
  }

  // Replace per-tick keepalive with heartbeat (stores agents + refreshes last_seen)
  // Zero hub changes — /api/heartbeat already accepts and stores agents dict
  await apiPost(`${hubUrl}/api/heartbeat`, {
    token, machine_id: machineId, team: teamName, agents
  });
}
```

**Key design points** (QC-pinned must-haves for link #1):
- Sources agent data from `~/.cc2cc/status/*-heartbeat.json` — no coupling to `server.mjs` internals (single source of truth)
- **Filter to the relay-registered team ONLY** — the status dir holds every local agent regardless of team; do NOT propagate agents whose `teams` don't include `teamName`, or other-team locals leak across the relay
- Filters to recent heartbeats only — avoids propagating stale agents. NOTE: sketch uses 30s (2× stale window); for presence accuracy prefer `HEARTBEAT_STALE_S` (15s) so an agent isn't reported online up to 30s after it stopped. Pick one and state it.
- Graceful if status dir doesn't exist (first run, clean start)
- Same `KEEPALIVE_INTERVAL_MS` cadence; fold the roster INTO keepalive (don't add a third per-tick endpoint call)

### 3.3 Wire Format

**Hub `/api/poll` response — agents object shape**:
```json
{
  "online_teams": {
    "team-a": {
      "machine_id": "machine-1",
      "agents": {
        "bright-hare": { "status_text": "Idle" },
        "fair-wren": { "status_text": "Reviewing spec v3.6" }
      }
    }
  }
}
```

Note: The existing pollCycle `getRemoteTeams()` (relay.mjs:172-173) extracts agent names via `Object.keys(data.agents || {})` which works identically with both array and object formats since `Object.keys()` returns the keys of any object. No change needed there.

### 3.4 Remote Agent Export — `getRemoteAgents()`

The `getRemoteAgents()` function (relay.mjs:180-196) already parses the `{name: {status_text}}` format correctly:
```javascript
const statusText = (typeof agentData === "object" && agentData !== null)
  ? (agentData.status_text || "Idle")
  : "Idle";
```

No changes needed — once Link #1 populates the agents dict, this function returns correct remote agent data.

### 3.5 AC4 Re-Scoping

AC4 (remote agent visibility) was formally descoped from v3.5 by fair-wren (2026-06-18) and folded here into v3.6 §3. The v3.5 Acceptance Criteria now read:
- ~~AC4: remote agents visible on both machines~~ → MOVED TO v3.6 §3

## 4. New Tool: `set_status`

A new tool will be added to allow an agent to declare its status.

```javascript
{
  name: "set_status",
  description: "Set a custom status message to inform others of your current activity.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", description: "A brief description of your current task (e.g., 'Idle', 'Implementing feature X', 'Blocked by Y')." },
    },
    required: ["status"],
  },
}
```

## 5. Modified `server.mjs` Logic

### 5.1 New State

A new state variable will be added to hold the agent's current status.

```javascript
let agentStatus = "Idle"; // Default status
```

### 5.2 New `handleSetStatus()` Tool

A handler for the new tool will be created. It will validate the input, update the `agentStatus` variable, and trigger an immediate heartbeat to broadcast the change.

```javascript
async function handleSetStatus({ status }) {
  // Guard type
  if (typeof status !== 'string') {
    return textResult("Status must be a string.", true);
  }

  // Validate and sanitize the input status
  const maxLength = 120;
  if (status.length > maxLength) {
    return textResult(`Status is too long (max ${maxLength} chars).`, true);
  }
  const sanitizedStatus = status.replace(/[\r\n\x00-\x1F\x7F-\x9F]/g, ""); // Strip control chars

  agentStatus = sanitizedStatus;
  
  // Await the async heartbeat function
  await writeHeartbeat(); 
  
  return textResult(`Status updated to: "${agentStatus}"`);
}
```

### 5.3 Modified `writeHeartbeat()`

The heartbeat payload will be updated to include the status.

```javascript
// In writeHeartbeat(), add to the payload:
const heartbeat = {
  // ... existing fields ...
  status_text: agentStatus, 
};
```

### 5.4 Modified `getAgentList()`

The agent list will be updated to include the rich status from incoming heartbeats.

```javascript
// In getAgentList(), when processing heartbeats:
const agentData = {
  // ... existing fields ...
  status_text: hb.status_text || "Idle", 
};
```

## 6. Lifecycle and Edge Case Management

### 6.1 Stale Status for Offline Agents

The `getAgentList()` function will be modified to suppress the `status_text` for any agent whose `status` is `"offline"` or whose heartbeat is considered stale. 

**Suppression Value**: The `status_text` should be set to `null` (or a placeholder like `"—"`) when suppressed, to distinguish a crashed/offline agent from an online agent that is genuinely "Idle".

### 6.2 Status Persistence

To prevent the status from being lost on server restart, the server will use a "Precise Read-Back" strategy. In the `init()` function of `server.mjs`, the agent will check for its own heartbeat file at `~/.cc2cc/status/[agent-name]-heartbeat.json`.

**CRITICAL CONSTRAINT**: The READ-back logic must execute strictly **before the first `writeHeartbeat()` call of any kind** during startup (including the initial "session started" write) to prevent the Overwrite Race.

The status will ONLY be restored if the following safety gates are passed:
1.  **Session Continuity**: The `parent_pid` in the heartbeat file must match the current process's parent PID (`process.ppid`). Compare these as **strings** (e.g., `String(hb.parent_pid) === String(process.ppid)`).
    *   *Residual Risk*: Acknowledged that PID reuse by the OS within the 30s freshness window could cause a false match.
2.  **Freshness Gate**: The heartbeat timestamp must be recent (within `HEARTBEAT_STALE_S * 2`, approx 30s). 
3.  **Integrity Check**: The file must be valid JSON and contain the required `status_text` field.

**Defensive Read**: The restoration must be wrapped in a try/catch block. Any error must result in a silent fallback to "Idle".

### 6.3 Overlapping Lifetimes

In scenarios where an old server instance is still writing heartbeats while a new one is booting, the use of `atomicWrite` (tmp + rename) ensures file integrity. The new instance will read the latest written status; if lifetimes overlap briefly, the status will converge once the old instance exits.

## 7. Example Usage

1.  An agent, "free-hawk", is starting an implementation task.
2.  `free-hawk` calls: `set_status({ status: "Implementing Part 3 Relay Client" })`
3.  The output for `free-hawk` in `list_agents` would look like:

```json
{
  "name": "free-hawk",
  "role": "member",
  "teams": ["cc2cc"],
  "status": "online",
  "status_text": "Implementing Part 3 Relay Client"
}
```

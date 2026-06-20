# cc2cc Bridge v3.5 — Part 2: Team Isolation & Leadership

**Status**: Draft Spec | **Owner**: fair-wren (PM/QA) | **Implementer**: free-hawk
**Depends On**: Part 1 (identity.json with `teams` array) — COMPLETE

---

## 1. Problem Statement

With Part 1, every agent has a `teams` array in identity.json (default `["cc2cc"]`). But currently:

- **`broadcast` sends to ALL online agents** — no team filtering
- **No concept of team boundaries** — Team A and Team B agents see each other's broadcasts
- **No team leadership** — cross-team communication has no routing/choke point
- **No way to discover team structure** — `list_agents` returns all agents, not filtered by team

## 2. Solution Overview

Three-layer team model:

1. **Team isolation** — broadcast is same-team only by default
2. **Team leader routing** — cross-team messages route through the designated team leader
3. **Team discovery** — new tools to inspect team structure

## 3. Team Leader Concept

### 3.1 Definition

Each team has exactly one designated **team leader**. The team leader is the routing point for cross-team communication — messages from other teams arrive at the leader's inbox, and the leader decides whether/how to disseminate within their team.

### 3.2 Leader Designation

A `role` field in identity.json:

```json
{
  "display_name": "fair-wren",
  "agent_id": "a1b2c3d4-...",
  "created": "2026-06-18T12:00:00Z",
  "teams": ["cc2cc"],
  "role": "leader"
}
```

| Role | Description |
|------|-------------|
| `"leader"` | Team leader — receives cross-team messages, can manage team membership |
| `"member"` | Standard team member (default) |

### 3.3 Leader Registration

The `register` tool is extended with an optional `role` parameter:

```
register({ name: "bob", role: "leader" })
```

Validation rules:
- Only one leader per team (registration rejected if another leader exists for that team)
- An agent can be leader of multiple teams (useful for bridging)
- If no leader exists for a team, any member of that team can claim leadership via `register`
- Role defaults to `"member"` if not specified

### 3.4 Leader Responsibilities

The team leader is responsible for:
1. Receiving cross-team messages (from other teams' members)
2. Disseminating messages to team members as appropriate
3. Representing the team in `list_teams` output
4. Handling team join/leave requests (future)

## 4. Communication Rules

### 4.1 Same-Team Communication

| Tool | Same Team Behavior |
|------|-------------------|
| `send(to, text)` | Works as-is — direct addressed, no team filtering |
| `broadcast(text)` | Sends ONLY to online agents sharing at least one team with sender |
| `reply(msg_id, text)` | Works as-is — replies to original sender |

### 4.2 Cross-Team Communication

| Action | Behavior |
|--------|----------|
| `send(to, text)` — different team | **Blocked**: "Agent X is on a different team. Use send_team to route through their team leader." |
| `broadcast(text)` — cross-team | Blocked by team filter (broadcast is same-team only) |
| `send_team(team_name, text)` | Routes to the designated team leader's inbox for that team |

### 4.3 Team Leader Routing

When `send_team` is called:

```
sender (Team A) → send_team("team-b", "message")
  ↓
Team B's leader receives the message (in their inbox)
  ↓
Team B's leader can forward/reply/disseminate as they see fit
```

The message delivered to the team leader includes metadata:
```json
{
  "from": "sender-name",
  "from_team": "team-a",
  "to_team": "team-b",
  "type": "interteam",
  "content": { "text": "..." }
}
```

### 4.4 Dissemination Pattern

Team leaders have two options for internal dissemination:
1. **Manual forwarding** — read the cross-team message, then `broadcast` or `send` to specific team members
2. **Auto-dissemination** — future feature, the leader could set rules to auto-forward certain message types

No automatic fan-out — the leader is the gatekeeper by design.

## 5. New & Modified Files

### 5.1 `server.mjs` — Primary changes

**New state** (after line ~56):
```javascript
let teamLeaders = new Map(); // team_name → leader_agent_name
```

**Modified `getAgentList()`** — add team info to agent records:
```javascript
// Add to agent data:
//   teams: hb.teams || ["cc2cc"],
//   role: hb.role || "member",
```

**Modified `onlineAgentNames()`** — add optional team filter:
```javascript
function onlineAgentNames(teamFilter) {
  return getAgentList()
    .filter((a) => a.status === "online" && !a.is_self)
    .filter((a) => !teamFilter || (a.teams && a.teams.includes(teamFilter)))
    .map((a) => a.name);
}
```

**Modified `handleBroadcast()`** — filter targets by shared team:
```
current:  targets = onlineAgentNames()
new:      targets = onlineAgentNames().filter(
            target => sharesTeam(agentName, target)
          )
```

**Modified `handleSend()`** — check team boundary on cross-team send:
```
current:  if (!isAgentOnline(to)) → reject
new:      if (!isAgentOnline(to)) → reject
          if (!sharesTeam(agentName, to)) → reject with "different team, use send_team"
```

**New `handleSendTeam()`** — send cross-team via leader:
```javascript
async function handleSendTeam({ team, text, type = "message", priority = "normal" }) {
  // 1. Resolve team leader
  const leader = teamLeaders.get(team);
  if (!leader) return textResult(`Team "${team}" has no designated leader.`, true);
  if (!isAgentOnline(leader)) return textResult(`Leader of "${team}" is offline.`, true);

  // 2. Build inter-team message
  const msg = buildMessage({
    from: agentName,
    from_team: agentIdentity?.teams?.[0] || "unknown",
    to_team: team,
    to: leader,
    text,
    type: "interteam",
    priority,
  });

  // 3. Deliver to leader's inbox
  const targetInbox = inboxDir(leader);
  await mkdir(targetInbox, { recursive: true });
  await atomicWrite(join(targetInbox, `${msg.id}.json`), msg);

  return textResult(`Cross-team message sent to ${team} leader (${leader}) — ${msg.id}`);
}
```

**New `handleListTeams()`** — list all teams and their leaders:
```javascript
function handleListTeams() {
  return jsonResult(Array.from(teamLeaders.entries()).map(([team, leader]) => ({
    name: team,
    leader,
    member_count: getAgentList().filter(a => a.teams?.includes(team)).length,
    online_count: getAgentList().filter(a => a.teams?.includes(team) && a.status === "online").length,
  })));
}
```

**Modified `handleRegister()`** — accept and validate role parameter:
```javascript
// New parameter: role = "member" | "leader"
// On leader registration:
//   Check: no other leader exists for this team
//   If taken: reject with "Team X already has a leader: {name}"
//   If accepted: update identity.json role, update teamLeaders map

// On member registration:
//  role stays "member" (default)
```

**Modified `writeHeartbeat()`** — include role:
```javascript
// Add to heartbeat:
//   role: agentIdentity?.role || "member",
```

**Modified `init()`** — after identity loaded, rebuild teamLeaders:
```javascript
// After loading identity and polling status:
// 1. Read all heartbeats
// 2. For each agent with role === "leader", populate teamLeaders map
// 3. Verify self-consistency (if SELF is a leader, it's in the map)
```

**New `sharesTeam()` helper**:
```javascript
function sharesTeam(agentA, agentB) {
  const aTeams = knownAgents.get(agentA)?.teams || [];
  const bTeams = knownAgents.get(agentB)?.teams || [];
  return aTeams.some(t => bTeams.includes(t));
}
```

**Updated tool definitions** — add new tools:

```javascript
{
  name: "send_team",
  description: "Send a message to an entire team. Routes through the team's designated leader.",
  inputSchema: {
    type: "object",
    properties: {
      team: { type: "string", description: "Target team name" },
      text: { type: "string", description: "Message content" },
      type: { type: "string", enum: ["interteam", "message", "task", "response", "status"], default: "message" },
      priority: { type: "string", enum: ["low", "normal", "high", "critical"], default: "normal" },
    },
    required: ["team", "text"],
  },
},
{
  name: "list_teams",
  description: "List all known teams with their leaders and member counts.",
  inputSchema: { type: "object", properties: {}, required: [] },
},
```

**Updated `broadcast` description**:
```
"Send a message to all known agents on your team(s). Does not cross team boundaries."
```

**Updated `send` description**:
```
"Send a message to another agent. Notes if the recipient is offline. Cross-team sends are blocked — use send_team for other teams."
```

### 5.2 `register` tool — Modified

```javascript
// Add role parameter:
{
  name: "register",
  description: "Change this agent's name and/or role. Validates, renames directories, updates heartbeat, notifies others.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "New agent name" },
      role: { type: "string", enum: ["member", "leader"], default: "member", description: "Team role" },
    },
    required: ["name"],
  },
}
```

### 5.3 No changes to hooks

Session hooks were updated in Part 1. No changes needed for Part 2.

### 5.4 No changes to names.mjs

Helper functions unchanged. `generateUniqueName()` still serves as fallback.

## 6. Edge Cases

| Scenario | Behavior |
|----------|----------|
| Agent is on multiple teams (bridging) | Broadcast goes to all of agent's teams; send_team works for each team the agent belongs to |
| Team leader goes offline | `send_team` returns "Team X leader is offline". Other agents can claim leadership via `register` |
| Two agents try to claim leadership | First registration wins; second is rejected with "Team X already has a leader: {name}" |
| Leader leaves team (registers without role) | Team has no leader; any member can claim leadership |
| Agent on no teams | Defaults to `["cc2cc"]` team (from Part 1). Cannot broadcast or receive cross-team |
| send_team to non-existent team | Rejected: "Team X has no designated leader" |
| Leader sends broadcast to own team | Works normally — leader is a team member too |
| Leader changes teams via register | Old team loses leader; new team may conflict if another leader exists |

## 7. Team Leader Handover

When a team leader goes offline, any team member can claim leadership:

```
register({ name: "bob", role: "leader" })
```

If `bob` is a member of the team that lost its leader, the registration succeeds and `bob` becomes the new leader.

The old leader (if they come back) can reclaim leadership via the same mechanism.

## 8. Acceptance Criteria

1. **Team isolation** — Agent on Team A broadcasts, Agent on Team B does NOT receive it
2. **Direct send blocked cross-team** — `send(bob)` fails if bob is on a different team
3. **send_team routes to leader** — Cross-team message arrives at target team's leader inbox
4. **Team leader designation** — `register({name, role: "leader"})` promotes agent to leader
5. **Duplicate leader rejected** — Second agent can't claim leadership if one already exists
6. **list_teams returns structure** — Shows team names, leaders, member/online counts
7. **list_agents includes teams** — Agent records show which teams they belong to
8. **Leader offline** — `send_team` returns clear error message
9. **Leader handover** — After leader goes offline, another agent can claim leadership
10. **Multi-team bridging** — Agent on [team-a, team-b] receives broadcasts from both teams

## 9. Implementation Order

1. Add `sharesTeam()` helper
2. Add `teamLeaders` state variable
3. Add role to identity.json (createIdentity, loadIdentity, writeHeartbeat)
4. Modify `handleBroadcast()` — filter by shared team
5. Modify `handleSend()` — block cross-team direct sends
6. Modify `getAgentList()` — include teams and role in agent data
7. Build `handleSendTeam()` — cross-team routing via leader
8. Build `handleListTeams()` — team discovery
9. Modify `handleRegister()` — accept role, validate leadership
10. Modify `init()` — populate teamLeaders from heartbeats
11. Add `send_team` and `list_teams` to tool definitions and handler switch
12. Update tool descriptions for broadcast and send

---

*End of Part 2 Spec — ready for implementation by free-hawk*

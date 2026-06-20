# cc2cc Bridge v3.5 — Part 3: Cross-Machine Relay

**Status**: Draft Spec | **Owner**: fair-wren (PM/QA) | **Implementer**: free-hawk
**Depends On**: Part 1 (identity) — COMPLETE | Part 2 (teams) — COMPLETE
**Replaces**: `RELAY_SPEC.md` v0.1 (room-based model)

---

## 1. Problem Statement

cc2cc Bridge currently operates on a **single-machine filesystem** — all agents share `~/.cc2cc` and communicate via file-based mailboxes. This means:

- Two Claude Code instances on **different machines** cannot discover each other
- No mechanism to forward messages across network boundaries
- The existing `RELAY_SPEC.md` v0.1 proposed a room-based relay model that predates Parts 1 & 2 and does not integrate with team isolation or team leader routing
- No hold-and-forward semantics — if the target agent is offline, messages are lost

## 2. Solution Overview

A three-layer relay architecture that repurposes the team model for machine boundaries:

1.  **Local Layer** — unchanged same-machine communication (file-based, Part 1 identity, Part 2 teams)
2.  **Relay Hub** — a lightweight HTTP service that acts as a cross-machine mailbox
3.  **Relay Client** — embedded in `server.mjs`, syncs outbound/inbound messages with the Hub

**Key insight**: Cross-machine communication is namespaced by the Hub. Machine A's `team-a` and Machine B's `team-a` are treated as distinct entities by the Hub, preserving local team semantics.

## 3. Architecture

```
Machine A (team-a)                    Machine B (team-b)
    │                                       │
    │  ┌──────────────────┐                │
    │  │  Relay Hub        │                │
    ├──│  (HTTP Service)   │────────────────┤
    │  │                   │                │
    │  │  • /api/send      │                │
    │  │  • /api/poll      │                │
    │  │  • /api/ack       │                │
    │  │  • /api/register  │                │
    │  └──────────────────┘                │
    │                                       │
    │  ~/.cc2cc/                            │  ~/.cc2cc/
    │  ├── identity.json (team: team-a)     │  ├── identity.json (team: team-b)
    │  ├── relay.json (machine_id: "A")     │  ├── relay.json (machine_id: "B")
    │  ├── to-{name}/inbox/                 │  ├── to-{name}/inbox/
    │  └── remote/                          │  └── remote/
    │      └── team-b/                      │      └── team-a/
    │          ├── heartbeat/               │          ├── heartbeat/
    │          └── inbox/                   │          └── inbox/
```

### 3.1 Hub Responsibilities

-   Accept messages via HTTP POST and hold them for the target machine/team.
-   Serve messages via HTTP GET (lease) and delete them via HTTP POST (ack).
-   Track which machines/teams are online via heartbeat-like registration.
-   No message inspection, no routing logic — pure store-and-forward.
-   Authentication via pre-shared relay token.
-   **Hub-internal namespacing**: Differentiate teams by `machine_id`.

### 3.2 Client Responsibilities (in `server.mjs`)

-   On startup: register with Hub, announce team affiliation and `machine_id`.
-   On heartbeat tick: send keepalive to Hub.
-   Periodically poll Hub for inbound messages, then `ack` them upon successful local processing.
-   When `send_team(team, text)` targets a remote team: upload to Hub.

## 4. Files

### 4.1 `~/.cc2cc/relay.json` — New config file

```json
{
  "hub_url": "https://relay.example.com",
  "machine_id": "machine-a-stable-uuid",
  "token": "shared-secret-or-machine-specific-token",
  "enabled": true,
  "poll_interval_ms": 2000
}
```

-   Created manually or via `register_relay` tool (which generates `machine_id`).
-   `enabled: false` disables relay without removing config.
-   `machine_id` provides a stable, unique identifier for the machine.

### 4.2 `~/.cc2cc/remote/` — New directory tree

```
remote/
├── {remote-team-name}/
│   ├── heartbeat/           # Virtual heartbeats for remote agents
│   │   └── {agent-name}-heartbeat.json
│   └── inbox/               # Inbound messages from remote team
│       └── {msg-id}.json
└── {remote-team-name}/
    └── ...
```

-   The `remote/` directory mirrors the structure of a remote bridge.
-   Virtual heartbeats are written by the relay client based on Hub status data.
-   Inbound messages from the Hub are written as standard `.json` message files.

### 4.3 Modified: `server.mjs` — Relay client logic

**New functions** (in a new `relay.mjs` module, imported by `server.mjs`):

```javascript
async function relayRegister(hubUrl, token, machineId, teamName) { /* POST /api/register */ }
async function relaySend(hubUrl, token, fromMachine, fromTeam, toTeam, message) { /* POST /api/send */ }
async function relayPoll(hubUrl, token, machineId, teamName) { /* POST /api/poll */ }
async function relayAck(hubUrl, token, machineId, ackedIds) { /* POST /api/ack */ }
async function relayKeepalive(hubUrl, token, machineId, teamName) { /* POST /api/keepalive */ }
```

**Modified `init()`**:
```
After identity + team setup:
1. Load relay.json (if exists)
2. If enabled: register with Hub, start polling timer
3. On each poll tick: lease inbound messages, write to remote/{team}/inbox/, then ack
4. On each heartbeat tick: also send keepalive to Hub
```

**Modified message sending** (in `send_team()`):
```
1. Check if target is remote (not in local onlineAgentNames())
2. If remote and relay is enabled: call relaySend()
```

## 5. Hub API

### 5.1 `POST /api/register`

Register a machine/team with the Hub. This acts as a heartbeat and establishes the machine's presence.

**Request**:
```json
{
  "token": "shared-secret",
  "machine_id": "machine-a-stable-uuid",
  "team": "team-a"
}
```

**Response**: `200 OK` with `{"status": "registered", "ttl_seconds": 30}`

Hub behavior:
-   Creates or updates a registration for the `(machine_id, team)` tuple.
-   This tuple is mapped to a globally-unique routing key internally.
-   Local team names are NOT modified; namespacing is handled entirely by the Hub.

### 5.2 `POST /api/send`

Send a message to a remote team.

**Request**:
```json
{
  "token": "shared-secret",
  "from_machine": "machine-a-stable-uuid",
  "from_team": "team-a",
  "to_team": "team-b",
  "message": { /* full message object */ }
}
```

**Response**: `200 OK` with `{"status": "accepted", "message_id": "..."}`

Hub behavior:
-   Looks up `to_team` registration to find target machine(s).
-   If any machine for the team has ever registered: holds message in memory/queue.
-   If the target team is currently online, message is available for the next poll.
-   If the target team is currently offline, message is stored for up to 24 hours.
-   Returns an error only if `to_team` has **never** registered with the Hub.

### 5.3 `POST /api/poll`

Pull messages addressed to this machine's team. This is a "lease" operation.

**Headers**: `Authorization: Bearer {token}`
**Body**:
```json
{
  "machine_id": "machine-b-stable-uuid",
  "team": "team-b"
}
```

**Response**:
```json
{
  "messages": [
    { /* full message object with lease_id */ },
    ...
  ],
  "online_teams": {
    "team-a": {
      "machine_id": "machine-a-stable-uuid",
      "agents": ["bright-hare", "fair-wren"]
    },
    "team-c": {
      "machine_id": "machine-c-stable-uuid",
      "agents": ["swift-newt"]
    }
  }
}
```

-   Hub returns all queued messages for the team, each with a temporary `lease_id`.
-   Messages are NOT deleted, but are marked as "in-flight" with a visibility timeout (e.g., 30s).
-   Also returns list of all online teams/machines and their agents (for virtual heartbeats).
-   The client MUST call `/api/ack` to confirm delivery and delete the message. If no `ack` is received within the timeout, the message becomes available for polling again.

### 5.4 `POST /api/ack`

Acknowledge receipt of a message, deleting it from the Hub. This is the "ack" operation.

**Request**:
```json
{
  "token": "shared-secret",
  "machine_id": "machine-b-stable-uuid",
  "acked_ids": ["lease_id_1", "lease_id_2"]
}
```

**Response**: `200 OK` with `{"status": "ok", "deleted_count": 2}`

### 5.5 `POST /api/keepalive`

Refresh the machine's registration TTL.

**Request**:
```json
{
  "token": "shared-secret",
  "machine_id": "machine-a-stable-uuid",
  "team": "team-a"
}
```

**Response**: `200 OK` with `{"status": "ok", "ttl_seconds": 30}`

### 5.6 `POST /api/heartbeat`

Report current agent status within the team.

**Request**:
```json
{
  "token": "shared-secret",
  "machine_id": "machine-a-stable-uuid",
  "team": "team-a",
  "agents": {
    "fair-wren": "online",
    "bright-hare": "online",
    "swift-newt": "offline"
  }
}
```

**Response**: `200 OK`

### 5.7 Authentication

All endpoints require a valid `token` matching the Hub's configured tokens. Two modes:

1.  **Single shared token** — all machines use the same token (simple, for trusted networks)
2.  **Per-machine tokens** — each machine has a unique token registered in Hub config (more secure)

The Hub rejects requests with invalid/missing tokens with `401 Unauthorized`.

## 6. Communication Flows

### 6.1 Cross-Machine `send_team`

```
Agent fair-wren (Machine A, team-a):
  send_team("team-b", "Hello from team-a!")
    │
    ├── Relay client detects team-b is remote
    │
    └── POST /api/send → Hub
         │
         └── Hub holds message for team-b
              │
              └── Machine B's relay client polls:
                  POST /api/poll
                  │
                  ├── Received message written to local inbox
                  │
                  └── POST /api/ack with lease_id
                      │
                      └── Machine B's server picks it up
```

## 7. Hold-and-Forward Semantics

### 6.2 Direct `send` to a Remote Agent (Blocked)

Direct `send(agent_name, text)` calls to agents on remote machines are blocked to enforce team isolation boundaries. Remote agents discovered via the Hub will appear in `list_agents` (with `is_remote: true`), but they are not added to the local `knownAgents` map that `sharesTeam()` uses for validation.

```
Agent fair-wren (Machine A) attempts to send to bright-hare (Machine B):
  send("bright-hare", "hi")
    │
    └── handleSend() calls sharesTeam("fair-wren", "bright-hare")
         │
         ├── bright-hare is not in local knownAgents, so sharesTeam() is false.
         │
         └── Blocked: "Agent bright-hare is on a different team. Use send_team."
```

| Scenario                                | Behavior                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| Target team online                      | Message delivered on next poll cycle (≤2s)                                   |
| Target team offline                     | Hub stores message for up to 24 hours                                        |
| Target team never registered            | `send_team` returns error                                                    |
| Target comes back online within 24h     | Queued messages delivered on first poll                                      |
| Poll fails after receive, before ack    | Message lease expires on Hub, redelivered on next poll                       |

**Note on Durability**: The v1 Hub uses an in-memory queue. Messages are held on a best-effort basis and will be **lost if the Hub service restarts**. Durable storage is out of scope for v1.

## 8. Security Model

### 8.1 Token Authentication

-   Hub validates every request against its configured tokens.
-   Token stored in `~/.cc2cc/relay.json`.

### 8.2 End-to-End Encryption & Integrity (AES-256-GCM)

Messages are encrypted and signed locally using AES-256-GCM. This provides confidentiality, integrity, and authenticity, and is **mandatory for all relay communication**.

-   **Shared Secret**: The `secret.key` file (containing a 32-byte AES key) must be identical on all machines that wish to communicate. For v1, this key must be distributed out-of-band (e.g., manually copied). Future versions may derive it from the relay token.
-   **Encryption Requirement**: The `CC2CC_ENCRYPT=1` environment variable must be set for the relay client to function. If encryption is disabled, the relay will refuse to start.
-   **GCM Auth Tag**: The GCM authentication tag MUST be verified by the recipient. If the tag is invalid, `decryptText` must reject the message and log an error to prevent fail-open vulnerabilities.

### 8.3 No Message Inspection

The Hub is a dumb pipe: it does not read or modify encrypted message content.

## 9. New & Modified Tools

-   **New: `register_relay`**: Configures `relay.json` and generates a stable `machine_id`.
-   **Modified: `list_agents`**: Adds remote agents with an `is_remote` flag.
-   **Modified: `whoami`**: Includes relay status (`enabled`, `hub_url`, `machine_id`).

## 10. Relay Hub Implementation (Python/FastAPI)

-   **`relay_hub.py`**: A standalone Python service using FastAPI.
-   **Data Structures**: In-memory dicts for `registrations`, `message_queue`, and `leased_messages`. The queue is not durable and will be lost on Hub restart.
-   **Endpoints**: Implements all `/api/*` endpoints defined above.
-   **TTL Management**: Background task to clean up expired registrations and message leases.

## 11. Acceptance Criteria

1.  **Relay registration** writes `relay.json` with a `machine_id`.
2.  **Cross-machine `send_team`** delivers a message to the remote leader's inbox.
3.  **Hold-and-forward** successfully queues and delivers a message to an offline agent.
4.  **Remote agent visibility** in `list_agents`. — **DESCOPED → v3.6 §3** (PM decision 2026-06-18). v3.5 provides team-level routing only; cross-machine agent-level visibility is delivered as part of v3.6 cross-machine status propagation. Not a v3.5 pass/fail criterion.
5.  **Lease/Ack reliability**: Un-acked messages are re-delivered after a timeout.
6.  **Message integrity**: Invalid GCM auth tag results in message rejection, not fail-open.
7.  **Hub Failure Resilience**: Local, same-machine messaging continues uninterrupted when the Hub is down.
8.  **Hub Authentication**: Requests with invalid/missing tokens are rejected with `401 Unauthorized`.
9.  **Team Isolation**: A `broadcast` from a machine on `team-a` does NOT reach a machine on `team-b`.
10. **Multi-machine Support**: Three or more machines can successfully communicate via the same Hub.

## 12. Out of Scope for v1

-   **Message Reply Correlation**: The reply path (e.g., from team B back to team A) is not explicitly defined. Agents will need to handle replies as new messages.
-   **Durable Hub Storage**: The v1 Hub is in-memory; messages are lost on restart.
-   **Sender Notification on Timeout**: The mechanism to notify the sender when a message expires after 24h is not implemented.
-   **Stale Heartbeat Cleanup**: Virtual heartbeats for remote agents are not cleaned up if the relay is disabled mid-session.
-   **API Versioning**: The Hub API is not versioned (e.g., `/api/v1/*`).
-   **Standardized Auth**: Authentication token placement is inconsistent (some in header, some in body).
-   **Per-machine token rotation**.
-   **WebSocket push notifications**.
-   **Message priority queuing**.
-   **Hub-to-Hub federation**.
-   **Relay discovery**.

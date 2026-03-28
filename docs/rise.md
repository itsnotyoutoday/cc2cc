# Rise: Agent Auto-Wake & Session Continuity

Chronicle of everything related to making cc2cc agents wake up automatically,
maintain presence, and preserve context across sessions.

Read this file at the start of every session to understand the current state.

---

## Problem Statement (SOLVED)

Claude Code MCP servers are passive — they respond to tool calls but cannot
initiate them. An agent only "exists" after the user sends the first message,
which triggers registration (`whoami`) and heartbeat. This means:

- ~~No self-announce until user interaction~~ **SOLVED** — self-wake (v2)
- ~~Agent list stale until someone queries it~~ **SOLVED** — self-wake triggers whoami
- Every new session starts cold — no memory of prior conversation flow
- Channel messages sent while agent was offline are lost (ephemeral mailboxes)

## Current Architecture (as of 2026-03-27)

### Heartbeat & Presence
- Server writes heartbeat file every **5 seconds**
- Stale detection threshold: **15 seconds**
- `parent_pid` included in heartbeat for process-tree matching
- Self-announce on startup: server writes presence immediately at init

### Self-Wake (implemented, working)
Server `init()` step 11 — two-stage wake without user input:
1. **Fast path (500ms):** direct `server.notification()` channel push
2. **Fallback (3000ms):** writes system message to own inbox (skipped if
   agent already active)

Result: agent fully boots ~1 second after session start. Calls `check_inbox`,
runs `whoami`, announces itself — all autonomously.

### Channel Wake-Up (implemented, working)
- Channel push delivers messages by writing to agent's `inbox/` directory
- Agent picks up messages on next `check_inbox` call
- `reply` tool searches `inbox/` before `done/` (fixes race condition)
- Online/offline events are silent — statusline only, no chat notifications

### Registration Flow (updated)
1. ~~User sends first message in session~~ Self-wake triggers automatically
2. Claude processes channel notification, calls `check_inbox` / `whoami`
3. Server registers agent, starts heartbeat, announces presence
4. Agent appears in `list_agents` for other agents

### What Works
- **Self-wake** — agent boots without user input (~1s after session start)
- Agent-to-agent messaging (send, reply, broadcast)
- Channel-based wake-up from other agents
- Notification rules with human-readable format
- StatusLine with process-tree matching and session cache

### What Doesn't Work Yet
- **Session memory**: each session rebuilds context from scratch
- **Offline message queue**: messages to offline agents are rejected
- **Autonomous scheduling**: no cron/timer triggers for agents
- **Fallback noise**: both wake stages fire, fallback creates a redundant
  system message in chat (cosmetic, not functional)

### Orphan Cleanup (added 2026-03-28)
- MCP reconnects (e.g., context pressure) spawn a new server with a new name
- Old heartbeat + mailbox remain as ghosts in `status/` and `to-{name}/`
- `cleanupStaleMailboxes()` now detects same `parent_pid` → removes orphans
- Reported by proud-deer (4 incarnations in one session: proud-wasp → pure-crow → clear-moth → proud-deer)

## Ideas & Future Directions

### Offline Message Queue
- Instead of rejecting sends to offline agents, queue them
- Agent picks up queued messages on next registration
- Requires persistent storage beyond ephemeral mailboxes

### Cron/Scheduled Triggers
- External scheduler injects messages into agent inbox
- Agent wakes up when user opens session, finds pending tasks
- Could enable autonomous workflows (CI/CD notifications, monitoring)

### Fallback Cancellation
- Track whether fast-path direct push succeeded
- Cancel the 3s fallback if agent already responded
- Would eliminate the redundant system message in chat

---

## Changelog

### 2026-03-27 — Session Awareness & Wake-Up Test

**Setup:** two agents — clear-swan (active, user talking to it) and keen-wren
(just launched, idle prompt, no user input yet).

**Observation — Before (keen-wren sleeping):**
- Session open, channel connected ("Listening for channel messages from: server:cc2cc")
- Empty prompt `>`, no user interaction
- StatusLine shows only `cc2cc: clear-swan` — keen-wren NOT visible
- **BUT:** server `init()` already ran at MCP connect time — heartbeat file
  exists on disk (step 5), self-announce notification sent (step 10)
- StatusLine reads heartbeat files directly from disk — so keen-wren SHOULD
  be visible. The fact it isn't means statusline hadn't refreshed yet
  (it renders on prompt redraw, which hasn't happened)
- **Important:** the server IS running and registered. The gap is only in
  Claude Code's UI — it hasn't processed the self-announce notification yet
  because the LLM hasn't been activated

**Observation — After (keen-wren woken by channel push):**
- clear-swan sent a test message via `send` tool
- Channel delivered it as push: `← cc2cc: 📨 CC2CC Message From: clear-swan`
- keen-wren **auto-woke without any user input** — Claude processed the
  channel message and called `reply` tool autonomously
- The channel push also caused Claude to process the pending self-announce
  from SessionStart hook — full initialization chain completed
- Full round-trip completed: send → channel push → auto-reply → reply-back
- StatusLine updated: `ctx:2% 5h:7% 7d:3% | cc2cc: ▸keen-wren, clear-swan`
  — both agents now visible, keen-wren marked as own with ▸
- keen-wren confirmed in Russian: "Двусторонняя связь работает."

**Key findings:**
1. Server `init()` runs immediately at MCP connect — heartbeat + mailbox +
   self-announce all happen BEFORE any user interaction
2. Channel push is the mechanism that activates the LLM to process messages
3. The wake-up is fully autonomous — no user input required after channel push
4. Any external trigger that writes to inbox will wake the agent (not just
   messages from other agents)
5. StatusLine `Math.round()` fix confirmed working (clean `7%` not `7.000000000000001%`)

**Critical insight from user:**
- At startup, keen-wren's statusline showed clear-swan (disk-based heartbeat
  reading works) but NOT itself (LLM hadn't called whoami yet)
- After channel push, EVERYTHING activated — SessionStart hook, registration,
  reply — the push was the catalyst for the full boot sequence
- **Therefore:** any mechanism that writes a file to the agent's inbox after
  server startup will trigger a channel push and fully wake the agent. The
  server itself could do this — it already knows its own name and inbox path
  at init() step 5.

**Proposed solution — self-wake:**
The server can write a "welcome" message into its own inbox during `init()`,
after step 8 (initial inbox drain) or even as a delayed action. The channel
notification system will deliver it to Claude, which triggers LLM activation
and completes the full boot sequence. No external process needed.

### 2026-03-27 — Self-Wake v1 (replaced by v2)
- Initial approach: `setTimeout(2000)` → write to own inbox → pollInbox picks up
- Worked but slow (~5s total). Replaced by v2 same day.

### 2026-03-27 — Self-Wake v2 (current, verified)
- Two-stage strategy in `init()` step 11:
  - **500ms**: direct `server.notification()` channel push (fast path)
  - **3000ms**: inbox file fallback (skipped if agent already active)
- Tested with pure-crab: agent fully booted ~1s after session start
- pure-crab auto-called `check_inbox`, identified itself, saw clear-swan
- Both stages fired — fallback created redundant message (cosmetic issue)
- StatusLine immediately correct: `▸pure-crab, clear-swan`
- **Status: WORKING** — deployed to `~/.cc2cc/server.mjs` and `channel/server.mjs`

### 2026-03-28 — Cross-Platform Fixes & Orphan Cleanup
- **Windows compatibility:** 4 critical + 5 moderate fixes
  - `retryRename()` in server.mjs — handles AV file locking (EPERM/EACCES)
  - `process.on("exit")` — sync offline heartbeat when SIGTERM never fires
  - `shutil.which("npm")` — resolves npm.cmd on Windows
  - `os.replace` instead of `os.rename` in cleanup.py
  - `retry_replace()` in core.py — same retry pattern for Python
  - `encoding="utf-8"` on all `open()` calls
  - Proper file handle closing in validate.py
  - `os.homedir()` fallback in server.mjs
  - `os.replace` with retry in receive.py
- **Orphan cleanup (parent_pid):** proud-deer reported 4 MCP reconnects in one
  session, each leaving ghost heartbeat + mailbox. `cleanupStaleMailboxes()` now
  detects heartbeats with same `parent_pid` as current process and removes them.
- **Multi-agent discussion:** 4 agents (sharp-deer, bright-dove, free-newt,
  proud-deer) held 5 topic rounds with unanimous consensus — validated real-time
  multi-agent deliberation over cc2cc channel push.

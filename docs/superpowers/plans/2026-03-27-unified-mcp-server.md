# Unified MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-agent MCP server with a single unified server that auto-generates identity — any number of Claude Code instances share one `settings.json` config.

**Architecture:** Single `server.mjs` with dynamic name generation, no `SELF`/`PEER` env vars. Each instance polls its own `to-{name}/inbox/` and `status/` directory. Agents discover each other through heartbeat files. Python scripts updated for new `to-{name}/` directory format with backwards compatibility for old `{a}-to-{b}/` format.

**Tech Stack:** Node.js 18+ (MCP SDK 1.28), Python 3.8+ (scripts/hooks/tests), pytest

---

### Task 1: Name Generation Module

**Files:**
- Create: `channel/names.mjs`
- Create: `tests/test_names.mjs`

- [ ] **Step 1: Create name generation module**

```javascript
// channel/names.mjs
import { readdir, readFile } from "fs/promises";
import { join } from "path";

const ADJECTIVES = [
  "brave", "calm", "swift", "bold", "keen", "wise", "fair", "warm", "wild", "cool",
  "bright", "quick", "sharp", "proud", "free", "true", "kind", "pure", "deep", "clear",
];

const ANIMALS = [
  "fox", "owl", "bear", "wolf", "hawk", "deer", "lynx", "crow", "hare", "seal",
  "dove", "swan", "toad", "moth", "wren", "lark", "bass", "crab", "newt", "wasp",
];

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function randomName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adj}-${animal}`;
}

export function validateName(name) {
  return NAME_RE.test(name);
}

export async function takenNames(bridgeDir) {
  const statusDir = join(bridgeDir, "status");
  let files;
  try {
    files = (await readdir(statusDir)).filter((f) => f.endsWith("-heartbeat.json"));
  } catch {
    return new Set();
  }
  const names = new Set();
  for (const file of files) {
    try {
      const raw = await readFile(join(statusDir, file), "utf8");
      const hb = JSON.parse(raw);
      const age = (Date.now() - new Date(hb.timestamp).getTime()) / 1000;
      if (hb.status === "active" && age < 30) {
        names.add(hb.agent);
      }
    } catch {
      // skip unreadable heartbeats
    }
  }
  return names;
}

export async function generateUniqueName(bridgeDir) {
  const taken = await takenNames(bridgeDir);
  for (let i = 0; i < 10; i++) {
    const name = randomName();
    if (!taken.has(name)) return name;
  }
  // Fallback: add random suffix
  return `${randomName()}-${Math.floor(Math.random() * 1000)}`;
}
```

- [ ] **Step 2: Create test file for names module**

```javascript
// tests/test_names.mjs
import { randomName, validateName } from "../channel/names.mjs";
import assert from "node:assert";
import { test, describe } from "node:test";

describe("randomName", () => {
  test("returns adjective-animal format", () => {
    const name = randomName();
    assert.match(name, /^[a-z]+-[a-z]+$/);
  });

  test("generates different names", () => {
    const names = new Set();
    for (let i = 0; i < 20; i++) names.add(randomName());
    assert.ok(names.size > 1, "Should generate varied names");
  });
});

describe("validateName", () => {
  test("accepts valid names", () => {
    assert.ok(validateName("brave-fox"));
    assert.ok(validateName("alpha"));
    assert.ok(validateName("agent-01"));
    assert.ok(validateName("a"));
  });

  test("rejects invalid names", () => {
    assert.ok(!validateName(""));
    assert.ok(!validateName("-starts-with-dash"));
    assert.ok(!validateName("Has-Uppercase"));
    assert.ok(!validateName("has spaces"));
    assert.ok(!validateName("a".repeat(32)));
  });
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/test_names.mjs`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add channel/names.mjs tests/test_names.mjs
git commit -m "feat: add name generation module for unified MCP server"
```

---

### Task 2: Rewrite MCP Server with Dynamic Identity

**Files:**
- Rewrite: `channel/server.mjs`

- [ ] **Step 1: Rewrite server.mjs with full unified architecture**

```javascript
// channel/server.mjs
#!/usr/bin/env node

/**
 * CC2CC Unified MCP Channel Server v3.0
 *
 * Dynamic identity — no SELF/PEER required.
 * Each Claude Code instance starts this same server.
 * The server auto-generates a unique name and self-registers.
 *
 * Environment:
 *   CC2CC_BRIDGE_DIR — path to bridge root (default: ~/.cc2cc)
 *   SELF             — optional: force agent name instead of auto-generation
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readdir, readFile, rename, mkdir, writeFile, rm } from "fs/promises";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import { generateUniqueName, validateName, takenNames } from "./names.mjs";

const BRIDGE_DIR =
  process.env.CC2CC_BRIDGE_DIR ||
  process.env.BRIDGE_DIR ||
  `${process.env.HOME || process.env.USERPROFILE}/.cc2cc`;
const POLL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_STALE_S = 30;

let selfName = process.env.SELF || null;
let onlineSince = new Date().toISOString();

// State tracking
const seenFiles = new Set();
const knownAgents = new Map(); // name -> { status, timestamp }

// Logging helper — writes to stderr (stdout is MCP transport)
function log(level, msg, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    server: selfName || "?",
    msg,
    ...data,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

// Atomic write helper
async function atomicWrite(targetPath, data) {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}.json`);
  await writeFile(tmpPath, JSON.stringify(data, null, 2));
  await rename(tmpPath, targetPath);
}

// --- Inbox helpers ---

function inboxDir() {
  return join(BRIDGE_DIR, `to-${selfName}`, "inbox");
}
function doneDir() {
  return join(BRIDGE_DIR, `to-${selfName}`, "done");
}
function receiptsDir() {
  return join(BRIDGE_DIR, `to-${selfName}`, "receipts");
}

// Get all inbox dirs for this agent (new + legacy formats)
function allInboxDirs() {
  const dirs = [inboxDir()];
  // Legacy format: *-to-{self}/inbox/
  // We'll discover these in the poll loop via readdir
  return dirs;
}

async function findLegacyInboxes() {
  const dirs = [];
  try {
    const entries = await readdir(BRIDGE_DIR);
    for (const entry of entries) {
      if (entry.endsWith(`-to-${selfName}`)) {
        dirs.push(join(BRIDGE_DIR, entry, "inbox"));
      }
    }
  } catch {
    // bridge dir may not exist yet
  }
  return dirs;
}

// --- Heartbeat ---

async function writeHeartbeat(status = "active", context = "") {
  const statusDir = join(BRIDGE_DIR, "status");
  await mkdir(statusDir, { recursive: true });
  const hb = {
    agent: selfName,
    timestamp: new Date().toISOString(),
    session_id: String(process.pid),
    status,
    context,
  };
  await atomicWrite(join(statusDir, `${selfName}-heartbeat.json`), hb);
}

// --- Agent discovery ---

function formatAge(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${(seconds / 3600).toFixed(1)}h ago`;
}

async function discoverAgents() {
  const statusDir = join(BRIDGE_DIR, "status");
  let files;
  try {
    files = (await readdir(statusDir)).filter((f) =>
      f.endsWith("-heartbeat.json")
    );
  } catch {
    return [];
  }

  const agents = [];
  for (const file of files) {
    try {
      const raw = await readFile(join(statusDir, file), "utf8");
      const hb = JSON.parse(raw);
      if (hb.agent === selfName) continue;
      const age = (Date.now() - new Date(hb.timestamp).getTime()) / 1000;
      const status = hb.status === "active" && age < HEARTBEAT_STALE_S ? "active" : "offline";
      agents.push({ name: hb.agent, status, last_seen: formatAge(age) });
    } catch {
      // skip
    }
  }
  return agents;
}

// --- Build message object ---

function buildMessage({ to, text, type = "message", priority = "normal", replyTo = null, task = null }) {
  const id = `msg-${randomUUID()}`;
  return {
    id,
    timestamp: new Date().toISOString(),
    from: selfName,
    to,
    type,
    priority,
    identity: { agent: selfName, mode: "session" },
    task,
    content: { text, parts: [] },
    replyTo,
    ttl: 3600,
  };
}

async function writeMessage(msg) {
  const inbox = join(BRIDGE_DIR, `to-${msg.to}`, "inbox");
  await mkdir(inbox, { recursive: true });
  await atomicWrite(join(inbox, `${msg.id}.json`), msg);
}

// --- Find original message for reply ---

async function findOriginal(msgId) {
  try {
    const entries = await readdir(BRIDGE_DIR);
    for (const entry of entries) {
      for (const sub of ["inbox", "done"]) {
        const fp = join(BRIDGE_DIR, entry, sub, `${msgId}.json`);
        try {
          const raw = await readFile(fp, "utf8");
          return JSON.parse(raw);
        } catch {
          // not here
        }
      }
    }
  } catch {
    // bridge dir issue
  }
  return null;
}

// --- MCP Server setup ---

const server = new Server(
  {
    name: "cc2cc",
    version: "3.0.0",
    instructions: [
      "You are connected to the CC2CC agent-to-agent bridge.",
      "Messages from other agents arrive as <channel> tags.",
      'Use "send" to message a specific agent, "broadcast" to message all.',
      'Use "reply" to respond to a message (pass the msg_id from the tag).',
      'Use "list_agents" to see who is online.',
      'Use "whoami" to check your identity.',
      'Use "register" to change your name.',
      "If a message is a task (type=task), execute it and send the result via reply.",
      "Always show A2A dialog to the user.",
    ].join(" "),
  },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
  }
);

// --- Tools definition ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "whoami",
      description: "Get your agent identity and bridge info",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_agents",
      description: "List all known agents and their status",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "send",
      description: "Send a message to a specific agent",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient agent name" },
          text: { type: "string", description: "Message content" },
          type: {
            type: "string",
            enum: ["message", "task", "response"],
            default: "message",
          },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "critical"],
            default: "normal",
          },
        },
        required: ["to", "text"],
      },
    },
    {
      name: "broadcast",
      description: "Send a message to all active agents",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Message content" },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "critical"],
            default: "normal",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "reply",
      description: "Reply to a message by msg_id (auto-completes tasks)",
      inputSchema: {
        type: "object",
        properties: {
          msg_id: {
            type: "string",
            description: "Message ID from <channel> tag",
          },
          text: { type: "string", description: "Reply content" },
        },
        required: ["msg_id", "text"],
      },
    },
    {
      name: "register",
      description: "Change your agent name (lowercase, numbers, dashes)",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "New agent name (e.g. devops, tester-1)",
          },
        },
        required: ["name"],
      },
    },
  ],
}));

// --- Tool handlers ---

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const { name: toolName, arguments: args } = params;

  try {
    switch (toolName) {
      case "whoami": {
        const agents = await discoverAgents();
        const online = agents.filter((a) => a.status === "active").map((a) => a.name);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  name: selfName,
                  online_since: onlineSince,
                  bridge_dir: BRIDGE_DIR,
                  online_agents: online,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "list_agents": {
        const agents = await discoverAgents();
        if (agents.length === 0) {
          return {
            content: [{ type: "text", text: "No other agents found." }],
          };
        }
        const lines = agents.map(
          (a) => `${a.status === "active" ? "●" : "○"} ${a.name}: ${a.status} (${a.last_seen})`
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "send": {
        const { to, text, type = "message", priority = "normal" } = args;
        const agents = await discoverAgents();
        const recipient = agents.find((a) => a.name === to);
        const msg = buildMessage({ to, text, type, priority });
        await writeMessage(msg);
        log("info", "message sent", { id: msg.id, to });
        const offlineNote =
          !recipient || recipient.status !== "active"
            ? ` (${to} is offline, message queued)`
            : "";
        return {
          content: [
            { type: "text", text: `Sent ${msg.id} to ${to}${offlineNote}` },
          ],
        };
      }

      case "broadcast": {
        const { text, priority = "normal" } = args;
        const agents = await discoverAgents();
        const delivered = [];
        const offline = [];
        for (const agent of agents) {
          const msg = buildMessage({
            to: agent.name,
            text,
            type: "message",
            priority,
          });
          await writeMessage(msg);
          if (agent.status === "active") {
            delivered.push(agent.name);
          } else {
            offline.push(agent.name);
          }
        }
        log("info", "broadcast sent", {
          delivered: delivered.length,
          offline: offline.length,
        });
        const parts = [];
        if (delivered.length) parts.push(`Delivered to: ${delivered.join(", ")}`);
        if (offline.length) parts.push(`Queued for offline: ${offline.join(", ")}`);
        if (!parts.length) parts.push("No other agents found.");
        return {
          content: [{ type: "text", text: parts.join("\n") }],
        };
      }

      case "reply": {
        const { msg_id, text } = args;
        const original = await findOriginal(msg_id);
        if (!original) {
          return {
            content: [
              {
                type: "text",
                text: `Original message ${msg_id} not found. Use "send" instead.`,
              },
            ],
            isError: true,
          };
        }

        let task = null;
        if (original.type === "task" && original.task) {
          task = { ...original.task, status: "completed", result: text };
        }

        const msg = buildMessage({
          to: original.from,
          text,
          type: "response",
          priority: original.priority || "normal",
          replyTo: msg_id,
          task,
        });
        await writeMessage(msg);
        log("info", "reply sent", { id: msg.id, to: original.from });
        const taskNote = task ? " [task completed]" : "";
        return {
          content: [
            {
              type: "text",
              text: `Replied ${msg.id} to ${original.from}${taskNote}`,
            },
          ],
        };
      }

      case "register": {
        const { name: newName } = args;
        if (!validateName(newName)) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid name "${newName}". Use lowercase letters, numbers, dashes. 1-31 chars. Must start with letter or number.`,
              },
            ],
            isError: true,
          };
        }

        const taken = await takenNames(BRIDGE_DIR);
        if (taken.has(newName)) {
          return {
            content: [
              {
                type: "text",
                text: `Name "${newName}" is already taken by an active agent.`,
              },
            ],
            isError: true,
          };
        }

        const oldName = selfName;
        const oldInbox = join(BRIDGE_DIR, `to-${oldName}`);
        const newInbox = join(BRIDGE_DIR, `to-${newName}`);

        // Move inbox directory
        try {
          await rename(oldInbox, newInbox);
        } catch {
          // Old dir may not exist yet, create new one
          await mkdir(join(newInbox, "inbox"), { recursive: true });
          await mkdir(join(newInbox, "done"), { recursive: true });
          await mkdir(join(newInbox, "receipts"), { recursive: true });
        }

        // Remove old heartbeat, write new one
        const statusDir = join(BRIDGE_DIR, "status");
        try {
          await rm(join(statusDir, `${oldName}-heartbeat.json`));
        } catch {
          // may not exist
        }

        selfName = newName;
        await writeHeartbeat("active", `renamed from ${oldName}`);

        // Notify others about rename
        const agents = await discoverAgents();
        for (const agent of agents) {
          if (agent.status === "active") {
            const msg = buildMessage({
              to: agent.name,
              text: `Agent "${oldName}" renamed to "${newName}"`,
              type: "status",
            });
            await writeMessage(msg);
          }
        }

        log("info", "renamed", { from: oldName, to: newName });
        return {
          content: [
            {
              type: "text",
              text: `Renamed from "${oldName}" to "${newName}". Other agents notified.`,
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
          isError: true,
        };
    }
  } catch (err) {
    log("error", `tool ${toolName} failed`, { error: err.message });
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// --- Polling loops ---

async function drainInbox() {
  const dirs = [inboxDir(), ...(await findLegacyInboxes())];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });

    let files;
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"));
    } catch {
      continue;
    }

    for (const file of files) {
      const fullPath = join(dir, file);
      if (seenFiles.has(fullPath)) continue;
      seenFiles.add(fullPath);

      try {
        const raw = await readFile(fullPath, "utf8");
        const msg = JSON.parse(raw);

        // TTL check
        const msgAge = (Date.now() - new Date(msg.timestamp).getTime()) / 1000;
        const ttl = msg.ttl || 3600;
        if (msgAge > ttl) {
          // Expired — notify sender
          const expiredNotif = buildMessage({
            to: msg.from,
            text: `Your message ${msg.id} to ${selfName} expired (TTL ${ttl}s)`,
            type: "status",
          });
          await writeMessage(expiredNotif);

          // Move to done
          const done = join(dirname(dir), "done");
          await mkdir(done, { recursive: true });
          await rename(fullPath, join(done, file));
          log("info", "message expired", { id: msg.id, from: msg.from });
          continue;
        }

        // Build notification content
        const taskTitle = msg.task?.title ? `[${msg.task.title}] ` : "";
        const content = `[from: ${msg.from}] [type: ${msg.type || "message"}] ${taskTitle}${msg.content?.text || ""}`;

        // Push channel notification
        await server.notification({
          method: "notifications/claude/channel",
          params: {
            content,
            meta: {
              msg_id: msg.id,
              priority: msg.priority || "normal",
              type: msg.type || "message",
              from: msg.from,
            },
          },
        });

        log("info", "message delivered", {
          id: msg.id,
          from: msg.from,
          type: msg.type,
        });

        // Write receipt
        await mkdir(receiptsDir(), { recursive: true });
        const receipt = {
          msg_id: msg.id,
          delivered_at: new Date().toISOString(),
          delivered_to: selfName,
        };
        await atomicWrite(join(receiptsDir(), `${msg.id}.receipt.json`), receipt);

        // Move to done
        const done = join(dirname(dir), "done");
        await mkdir(done, { recursive: true });
        await rename(fullPath, join(done, file));
      } catch (err) {
        log("error", "message processing failed", {
          file,
          error: err.message,
        });
      }
    }
  }

  // Prevent memory leak
  if (seenFiles.size > 500) seenFiles.clear();
}

async function pollStatus() {
  const agents = await discoverAgents();

  for (const agent of agents) {
    const prev = knownAgents.get(agent.name);

    if (!prev) {
      // New agent
      knownAgents.set(agent.name, { status: agent.status, timestamp: Date.now() });
      if (agent.status === "active") {
        await server.notification({
          method: "notifications/claude/channel",
          params: {
            content: `[cc2cc] ${agent.name} joined`,
            meta: { type: "status", from: "cc2cc" },
          },
        });
        log("info", "agent joined", { agent: agent.name });
      }
    } else if (prev.status !== agent.status) {
      // Status changed
      knownAgents.set(agent.name, { status: agent.status, timestamp: Date.now() });
      const event = agent.status === "active" ? "joined" : "went offline";
      await server.notification({
        method: "notifications/claude/channel",
        params: {
          content: `[cc2cc] ${agent.name} ${event}`,
          meta: { type: "status", from: "cc2cc" },
        },
      });
      log("info", `agent ${event}`, { agent: agent.name });
    }
  }

  // Detect removed agents (heartbeat deleted)
  for (const [name, info] of knownAgents) {
    if (!agents.find((a) => a.name === name) && info.status === "active") {
      knownAgents.set(name, { status: "offline", timestamp: Date.now() });
      await server.notification({
        method: "notifications/claude/channel",
        params: {
          content: `[cc2cc] ${name} went offline`,
          meta: { type: "status", from: "cc2cc" },
        },
      });
    }
  }
}

// --- Startup ---

async function main() {
  // Generate or use provided name
  if (!selfName) {
    selfName = await generateUniqueName(BRIDGE_DIR);
  }

  // Create directories
  await mkdir(inboxDir(), { recursive: true });
  await mkdir(doneDir(), { recursive: true });
  await mkdir(receiptsDir(), { recursive: true });

  // Write initial heartbeat
  await writeHeartbeat("active", "session started");

  // Discover existing agents
  const agents = await discoverAgents();
  const onlineNames = agents
    .filter((a) => a.status === "active")
    .map((a) => a.name);

  // Notify others that we joined
  for (const agent of agents) {
    if (agent.status === "active") {
      const msg = buildMessage({
        to: agent.name,
        text: `${selfName} joined the bridge`,
        type: "status",
      });
      await writeMessage(msg);
    }
  }

  // Initialize known agents map
  for (const agent of agents) {
    knownAgents.set(agent.name, { status: agent.status, timestamp: Date.now() });
  }

  log("info", "server started", {
    self: selfName,
    online: onlineNames,
    poll_ms: POLL_MS,
  });

  // Push welcome notification to own agent
  const onlineList =
    onlineNames.length > 0
      ? `Online agents: ${onlineNames.join(", ")}`
      : "No other agents online";
  await server.notification({
    method: "notifications/claude/channel",
    params: {
      content: `[cc2cc] You are ${selfName}. ${onlineList}`,
      meta: { type: "status", from: "cc2cc" },
    },
  });

  // Start polling
  setInterval(drainInbox, POLL_MS);
  setInterval(pollStatus, POLL_MS);
  setInterval(() => writeHeartbeat("active", "running"), HEARTBEAT_INTERVAL_MS);
  drainInbox();

  // Graceful shutdown
  const shutdown = async () => {
    log("info", "shutting down", { self: selfName });
    await writeHeartbeat("offline", "session ended");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  log("error", "startup failed", { error: err.message });
  process.exit(1);
});
```

- [ ] **Step 2: Run MCP server smoke test**

Run: `cd ~/.cc2cc && timeout 5 node server.mjs 2>&1; echo "EXIT: $?"`
Expected: Server starts, generates name, writes heartbeat, exits with timeout (124)

- [ ] **Step 3: Commit**

```bash
git add channel/server.mjs
git commit -m "feat: rewrite MCP server with dynamic identity and multi-agent support"
```

---

### Task 3: Update Python Scripts for New Directory Format

**Files:**
- Modify: `scripts/send.py`
- Modify: `scripts/receive.py`
- Modify: `scripts/reply.py`
- Modify: `scripts/task.py`
- Modify: `scripts/status.py`
- Modify: `scripts/validate.py`
- Modify: `scripts/cleanup.py`

- [ ] **Step 1: Update send.py — write to `to-{recipient}/inbox/`**

Replace the inbox path line in `send.py`:

```python
# Old:
# inbox = bridge / f"{sender}-to-{recipient}" / "inbox"

# New:
inbox = bridge / f"to-{recipient}" / "inbox"
```

Full updated `send.py`:

```python
#!/usr/bin/env python3
"""Send a message through the CC2CC bridge."""

import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cc2cc.core import atomic_write, bridge_path
from cc2cc.signing import sign_message


def _load_secret(bridge: Path):
    secret_file = bridge / "secret.key"
    if secret_file.exists():
        return secret_file.read_text(encoding="utf-8").strip()
    return None


def main():
    if len(sys.argv) < 5:
        print(
            "Usage: send.py <from> <to> <type> <content> [priority] [mode]",
            file=sys.stderr,
        )
        print("Types: message, task, status, response", file=sys.stderr)
        print("Priority: low, normal, high, critical", file=sys.stderr)
        sys.exit(1)

    sender = sys.argv[1]
    recipient = sys.argv[2]
    msg_type = sys.argv[3]
    content = sys.argv[4]
    priority = sys.argv[5] if len(sys.argv) > 5 else "normal"
    mode = sys.argv[6] if len(sys.argv) > 6 else "session"

    bridge = bridge_path()
    inbox = bridge / f"to-{recipient}" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)

    msg_id = f"msg-{uuid.uuid4()}"
    msg = {
        "id": msg_id,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "from": sender,
        "to": recipient,
        "type": msg_type,
        "priority": priority,
        "identity": {"agent": sender, "mode": mode},
        "task": None,
        "content": {"text": content, "parts": []},
        "replyTo": None,
        "ttl": 3600,
    }

    secret = _load_secret(bridge)
    if secret:
        msg = sign_message(msg, secret)

    atomic_write(inbox / f"{msg_id}.json", msg)
    print(f"Sent {msg_id} -> {recipient}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Update receive.py — read from `to-{agent}/inbox/` + legacy fallback**

```python
#!/usr/bin/env python3
"""Read pending messages from the CC2CC inbox."""

import json
import os
import shutil
import sys
from pathlib import Path

from cc2cc.signing import verify_message


def _load_secret(bridge: Path):
    secret_file = bridge / "secret.key"
    if secret_file.exists():
        return secret_file.read_text(encoding="utf-8").strip()
    return None


def main():
    if len(sys.argv) < 2:
        print("Usage: receive.py <agent> [--peek]", file=sys.stderr)
        sys.exit(1)

    agent = sys.argv[1]
    peek = "--peek" in sys.argv
    bridge = Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))
    secret = _load_secret(bridge)

    # New format: to-{agent}/inbox + Legacy format: *-to-{agent}/inbox
    inboxes = []
    new_inbox = bridge / f"to-{agent}" / "inbox"
    if new_inbox.exists():
        inboxes.append(new_inbox)
    for legacy in bridge.glob(f"*-to-{agent}/inbox"):
        if legacy not in inboxes:
            inboxes.append(legacy)

    for inbox in inboxes:
        for fp in sorted(inbox.glob("*.json")):
            try:
                msg = json.loads(fp.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue

            sig_status = ""
            if secret:
                if verify_message(msg, secret):
                    sig_status = " [verified]"
                else:
                    sig_status = " [SIGNATURE INVALID]"

            print(f"From: {msg['from']}  Type: {msg['type']}  Priority: {msg.get('priority', 'normal')}{sig_status}")
            print(f"Time: {msg['timestamp']}")
            print(f"Content: {msg['content']['text'][:200]}")
            if msg.get("task"):
                print(f"Task: {msg['task']['title']} [{msg['task']['status']}]")
            print("---")

            if not peek:
                done_dir = inbox.parent / "done"
                done_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(fp), str(done_dir / fp.name))


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Update reply.py — write to `to-{recipient}/inbox/`**

```python
#!/usr/bin/env python3
"""Reply to a message, completing tasks if applicable."""

import glob
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cc2cc.core import atomic_write, bridge_path
from cc2cc.signing import sign_message


def _load_secret(bridge: Path):
    secret_file = bridge / "secret.key"
    if secret_file.exists():
        return secret_file.read_text(encoding="utf-8").strip()
    return None


def find_original(bridge, msg_id):
    """Search all dirs for the original message."""
    for pattern in [f"*/inbox/{msg_id}.json", f"*/done/{msg_id}.json"]:
        matches = glob.glob(os.path.join(str(bridge), pattern))
        if matches:
            with open(matches[0], encoding="utf-8") as f:
                return json.load(f)
    return None


def main():
    if len(sys.argv) < 3:
        print(
            "Usage: reply.py <original-msg-id> <reply-text> [from] [mode]",
            file=sys.stderr,
        )
        sys.exit(1)

    original_id = sys.argv[1]
    reply_text = sys.argv[2]
    sender = sys.argv[3] if len(sys.argv) > 3 else None
    mode = sys.argv[4] if len(sys.argv) > 4 else "session"

    bridge = bridge_path()
    original = find_original(bridge, original_id)

    if original:
        recipient = original["from"]
        if not sender:
            sender = original["to"]
    else:
        print(
            f"Warning: original message {original_id} not found", file=sys.stderr
        )
        recipient = sender
        if not sender:
            print(
                "Error: must specify <from> when original not found", file=sys.stderr
            )
            sys.exit(1)

    task = None
    if original and original.get("type") == "task" and original.get("task"):
        task = dict(original["task"])
        task["status"] = "completed"
        task["result"] = reply_text

    msg_id = f"msg-{uuid.uuid4()}"
    msg = {
        "id": msg_id,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "from": sender,
        "to": recipient,
        "type": "response",
        "priority": original.get("priority", "normal") if original else "normal",
        "identity": {"agent": sender, "mode": mode},
        "task": task,
        "content": {"text": reply_text, "parts": []},
        "replyTo": original_id,
        "ttl": 3600,
    }

    secret = _load_secret(bridge)
    if secret:
        msg = sign_message(msg, secret)

    inbox = bridge / f"to-{recipient}" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    atomic_write(inbox / f"{msg_id}.json", msg)

    print(
        f"Replied {msg_id} -> {recipient}" + (" [task completed]" if task else "")
    )


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Update task.py — write to `to-{recipient}/inbox/`**

```python
#!/usr/bin/env python3
"""Delegate a task to a peer agent."""

import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cc2cc.core import atomic_write, bridge_path
from cc2cc.signing import sign_message


def _load_secret(bridge: Path):
    secret_file = bridge / "secret.key"
    if secret_file.exists():
        return secret_file.read_text(encoding="utf-8").strip()
    return None


def main():
    if len(sys.argv) < 5:
        print(
            "Usage: task.py <from> <to> <title> <description> [priority] [mode]",
            file=sys.stderr,
        )
        sys.exit(1)

    sender = sys.argv[1]
    recipient = sys.argv[2]
    title = sys.argv[3]
    description = sys.argv[4]
    priority = sys.argv[5] if len(sys.argv) > 5 else "normal"
    mode = sys.argv[6] if len(sys.argv) > 6 else "session"

    bridge = bridge_path()
    inbox = bridge / f"to-{recipient}" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)

    msg_id = f"msg-{uuid.uuid4()}"
    task_id = f"task-{uuid.uuid4()}"
    msg = {
        "id": msg_id,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "from": sender,
        "to": recipient,
        "type": "task",
        "priority": priority,
        "identity": {"agent": sender, "mode": mode},
        "task": {
            "id": task_id,
            "title": title,
            "description": description,
            "status": "submitted",
            "result": None,
        },
        "content": {"text": f"Task: {title} -- {description}", "parts": []},
        "replyTo": None,
        "ttl": 3600,
    }

    secret = _load_secret(bridge)
    if secret:
        msg = sign_message(msg, secret)

    atomic_write(inbox / f"{msg_id}.json", msg)
    print(f"Delegated {task_id} -> {recipient}: {title}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Update status.py — show `to-{name}/` mailboxes + legacy**

```python
#!/usr/bin/env python3
"""Show CC2CC bridge status."""

import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Ensure UTF-8 output on Windows (for Unicode indicators)
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def format_age(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.0f}s ago"
    if seconds < 3600:
        return f"{seconds / 60:.0f}m ago"
    if seconds < 86400:
        return f"{seconds / 3600:.1f}h ago"
    return f"{seconds / 86400:.1f}d ago"


def main():
    bridge = Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))

    print("=== CC2CC Bridge Status ===\n")

    # Heartbeats
    status_dir = bridge / "status"
    if status_dir.exists():
        for hb_path in sorted(status_dir.glob("*-heartbeat.json")):
            try:
                hb = json.loads(hb_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue

            ts = datetime.fromisoformat(hb["timestamp"].replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - ts).total_seconds()
            indicator = "\u25cf" if age < 30 else "\u25cb"
            print(f"{indicator} {hb['agent']}: {hb['status']} ({format_age(age)})")
            if hb.get("context"):
                print(f"  Context: {hb['context']}")

    print()

    # Mailboxes — new format (to-{name}/) + legacy ({a}-to-{b}/)
    for inbox in sorted(bridge.glob("*/inbox")):
        if not inbox.is_dir():
            continue
        name = inbox.parent.name
        inbox_count = len(list(inbox.glob("*.json")))
        done_dir = inbox.parent / "done"
        done_count = len(list(done_dir.glob("*.json"))) if done_dir.exists() else 0
        print(f"{name}: {inbox_count} pending, {done_count} processed")


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Update validate.py — scan both directory formats**

No changes needed — the glob `*/*/*.json` already matches both `to-brave-fox/inbox/*.json` and `alpha-to-beta/inbox/*.json`. Validated.

- [ ] **Step 7: Update cleanup.py — scan both directory formats**

No changes needed — the globs `*/done/*.json` and `*/inbox/*.json` already match both formats. Validated.

- [ ] **Step 8: Run existing tests to check nothing broke**

Run: `python -m pytest tests/ -v`
Expected: Some tests may fail because they use old `{a}-to-{b}` format in fixtures. That's expected and will be fixed in Task 5.

- [ ] **Step 9: Commit**

```bash
git add scripts/send.py scripts/receive.py scripts/reply.py scripts/task.py scripts/status.py
git commit -m "feat: update scripts for to-{name}/ directory format with legacy fallback"
```

---

### Task 4: Update init.py and Hooks

**Files:**
- Modify: `scripts/init.py`
- Modify: `hooks/session_start.py`
- Modify: `hooks/session_end.py`

- [ ] **Step 1: Rewrite init.py — simplified bridge setup, single server.mjs**

```python
#!/usr/bin/env python3
"""Initialize CC2CC bridge."""

import io
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from cc2cc.signing import generate_secret

# Ensure UTF-8 output on Windows
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def main():
    if len(sys.argv) < 2:
        bridge = Path(os.path.expanduser("~/.cc2cc"))
    else:
        bridge = Path(sys.argv[1])

    repo_dir = Path(__file__).resolve().parent.parent

    print(f"Initializing CC2CC bridge at {bridge}")

    # Status directory
    (bridge / "status").mkdir(parents=True, exist_ok=True)

    # HMAC secret
    secret_file = bridge / "secret.key"
    if not secret_file.exists():
        secret_file.write_text(generate_secret(), encoding="utf-8")
        print(f"Generated HMAC secret: {secret_file}")
    else:
        print(f"HMAC secret exists: {secret_file}")

    # Single MCP server at bridge root
    server_src = repo_dir / "channel" / "server.mjs"
    names_src = repo_dir / "channel" / "names.mjs"
    if server_src.exists():
        shutil.copy2(server_src, bridge / "server.mjs")
    if names_src.exists():
        shutil.copy2(names_src, bridge / "names.mjs")

    pkg = {
        "name": "cc2cc-server",
        "version": "3.0.0",
        "type": "module",
        "dependencies": {"@modelcontextprotocol/sdk": "^1.12.0"},
    }
    (bridge / "package.json").write_text(
        json.dumps(pkg, indent=2), encoding="utf-8"
    )

    print("Installing MCP dependencies...")
    try:
        subprocess.run(
            ["npm", "install", "--silent"],
            cwd=str(bridge),
            check=True,
            capture_output=True,
        )
        print("MCP dependencies installed.")
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("Warning: npm install failed (is Node.js installed?)")

    # Copy hooks
    hooks_dst = bridge / "hooks"
    hooks_dst.mkdir(parents=True, exist_ok=True)
    for hook in ["session_start.py", "session_end.py", "inbox_watcher.py"]:
        src = repo_dir / "hooks" / hook
        if src.exists():
            shutil.copy2(src, hooks_dst / hook)

    # Copy scripts
    scripts_dst = bridge / "scripts"
    scripts_dst.mkdir(parents=True, exist_ok=True)
    for script in ["send.py", "receive.py", "reply.py", "task.py", "status.py", "validate.py", "cleanup.py"]:
        src = repo_dir / "scripts" / script
        if src.exists():
            shutil.copy2(src, scripts_dst / script)

    print(f"\nBridge initialized at {bridge}\n")
    print("Add to your ~/.claude/settings.json:")
    print(json.dumps({
        "mcpServers": {
            "cc2cc": {
                "command": "node",
                "args": [str(bridge / "server.mjs")],
                "env": {"CC2CC_BRIDGE_DIR": str(bridge)},
            }
        }
    }, indent=2))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Update session_start.py — check both inbox formats**

```python
#!/usr/bin/env python3
"""CC2CC SessionStart hook — write heartbeat, check inbox."""

import json
import os
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path


def main():
    # Drain stdin (hook protocol)
    sys.stdin.read()

    self_id = os.environ.get("CC2CC_SELF", socket.gethostname().split(".")[0])
    bridge = Path(os.environ.get("CC2CC_BRIDGE_DIR", os.path.expanduser("~/.cc2cc")))

    # Write heartbeat
    status_dir = bridge / "status"
    status_dir.mkdir(parents=True, exist_ok=True)
    heartbeat = {
        "agent": self_id,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "session_id": str(os.getpid()),
        "status": "active",
        "context": "session started",
    }
    (status_dir / f"{self_id}-heartbeat.json").write_text(
        json.dumps(heartbeat, indent=2), encoding="utf-8"
    )

    # Check inbox — new format + legacy
    pending = 0
    output_lines = []
    # New format
    for fp in (bridge / f"to-{self_id}" / "inbox").glob("*.json") if (bridge / f"to-{self_id}" / "inbox").exists() else []:
        pending += 1
        try:
            msg = json.loads(fp.read_text(encoding="utf-8"))
            sender = msg["from"]
            mtype = msg["type"]
            text = msg["content"]["text"][:80]
            output_lines.append(f"  - [{mtype}] from {sender}: {text}")
        except (json.JSONDecodeError, KeyError, OSError):
            output_lines.append("  - [unknown] unreadable message")
    # Legacy format
    for fp in bridge.glob(f"*-to-{self_id}/inbox/*.json"):
        pending += 1
        try:
            msg = json.loads(fp.read_text(encoding="utf-8"))
            sender = msg["from"]
            mtype = msg["type"]
            text = msg["content"]["text"][:80]
            output_lines.append(f"  - [{mtype}] from {sender}: {text}")
        except (json.JSONDecodeError, KeyError, OSError):
            output_lines.append("  - [unknown] unreadable message")

    if pending > 0:
        print(f"CC2CC: {pending} pending message(s) in inbox:")
        print("\n".join(output_lines))
    else:
        print("CC2CC: No pending messages. Bridge active.")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: session_end.py — no changes needed**

The hook already writes to `status/{self}-heartbeat.json` with `status: "offline"`. This is compatible with the new architecture. No changes.

- [ ] **Step 4: Commit**

```bash
git add scripts/init.py hooks/session_start.py
git commit -m "feat: update init.py for unified server, hooks for dual-format inbox"
```

---

### Task 5: Update Tests

**Files:**
- Modify: `tests/test_smoke.py`
- Modify: `tests/test_unit.py`
- Create: `tests/test_names.py`

- [ ] **Step 1: Add Python tests for name validation**

```python
# tests/test_names.py
"""Tests for name generation concepts (Python-side validation)."""

import re

import pytest

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")


class TestNameValidation:
    def test_valid_names(self):
        for name in ["brave-fox", "alpha", "agent-01", "a", "test-agent-99"]:
            assert NAME_RE.match(name), f"{name} should be valid"

    def test_invalid_names(self):
        for name in ["", "-starts", "Has-Upper", "has spaces", "a" * 32]:
            assert not NAME_RE.match(name), f"{name} should be invalid"
```

- [ ] **Step 2: Update test_smoke.py bridge fixture for new format**

```python
# Replace the bridge fixture in tests/test_smoke.py:

@pytest.fixture
def bridge(tmp_path):
    """Create a temporary bridge directory with both formats."""
    # New format
    for agent in ["alpha", "beta"]:
        (tmp_path / f"to-{agent}" / "inbox").mkdir(parents=True)
        (tmp_path / f"to-{agent}" / "done").mkdir(parents=True)
    (tmp_path / "status").mkdir()
    return tmp_path
```

Update all test assertions that reference `alpha-to-beta` to use `to-beta` and `to-alpha`:

```python
class TestSend:
    def test_creates_message_file(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello from alpha"], bridge)
        files = list((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        assert len(files) == 1

    def test_message_fields(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello from alpha"], bridge)
        fp = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        assert msg["from"] == "alpha"
        assert msg["to"] == "beta"
        assert msg["type"] == "message"
        assert msg["content"]["text"] == "Hello from alpha"


class TestReceive:
    def test_peek_preserves_file(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello"], bridge)
        result = run_script("scripts/receive.py", ["beta", "--peek"], bridge)
        assert "alpha" in result.stdout
        assert len(list((bridge / "to-beta" / "inbox").glob("*.json"))) == 1

    def test_consume_moves_to_done(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello"], bridge)
        run_script("scripts/receive.py", ["beta"], bridge)
        assert len(list((bridge / "to-beta" / "inbox").glob("*.json"))) == 0
        assert len(list((bridge / "to-beta" / "done").glob("*.json"))) == 1


class TestReply:
    def test_reply_creates_response(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello"], bridge)
        msg_file = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(msg_file.read_text(encoding="utf-8"))
        msg_id = msg["id"]
        run_script("scripts/reply.py", [msg_id, "Got it!", "beta"], bridge)
        replies = list((bridge / "to-alpha" / "inbox").glob("msg-*.json"))
        assert len(replies) == 1
        reply = json.loads(replies[0].read_text(encoding="utf-8"))
        assert reply["replyTo"] == msg_id
        assert reply["type"] == "response"


class TestTask:
    def test_task_creation(self, bridge):
        run_script("scripts/task.py", ["alpha", "beta", "Run tests", "Execute integration tests"], bridge)
        files = list((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        assert len(files) == 1
        msg = json.loads(files[0].read_text(encoding="utf-8"))
        assert msg["type"] == "task"
        assert msg["task"]["status"] == "submitted"
        assert msg["task"]["title"] == "Run tests"

    def test_task_reply_completes(self, bridge):
        run_script("scripts/task.py", ["alpha", "beta", "Run tests", "Execute tests"], bridge)
        task_file = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        task_msg = json.loads(task_file.read_text(encoding="utf-8"))
        done_dir = bridge / "to-beta" / "done"
        task_file.rename(done_dir / task_file.name)
        run_script("scripts/reply.py", [task_msg["id"], "All 42 tests passed", "beta"], bridge)
        replies = list((bridge / "to-alpha" / "inbox").glob("msg-*.json"))
        assert len(replies) == 1
        reply = json.loads(replies[0].read_text(encoding="utf-8"))
        assert reply["task"]["status"] == "completed"
        assert reply["task"]["result"] == "All 42 tests passed"


class TestValidate:
    def test_all_valid(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Test"], bridge)
        result = run_script("scripts/validate.py", [], bridge)
        assert "Invalid: 0" in result.stdout


class TestHooks:
    def test_session_start_heartbeat(self, bridge):
        run_script("hooks/session_start.py", [], bridge, env_extra={"CC2CC_SELF": "alpha"})
        hb_file = bridge / "status" / "alpha-heartbeat.json"
        assert hb_file.exists()
        hb = json.loads(hb_file.read_text(encoding="utf-8"))
        assert hb["status"] == "active"

    def test_session_start_reports_pending(self, bridge):
        run_script("scripts/send.py", ["beta", "alpha", "message", "Hey alpha"], bridge)
        result = run_script("hooks/session_start.py", [], bridge, env_extra={"CC2CC_SELF": "alpha"})
        assert "1 pending" in result.stdout

    def test_session_end_offline(self, bridge):
        run_script("hooks/session_end.py", [], bridge, env_extra={"CC2CC_SELF": "alpha"})
        hb = json.loads((bridge / "status" / "alpha-heartbeat.json").read_text(encoding="utf-8"))
        assert hb["status"] == "offline"


class TestStatus:
    def test_shows_agents_and_mailboxes(self, bridge):
        run_script("hooks/session_start.py", [], bridge, env_extra={"CC2CC_SELF": "alpha"})
        run_script("scripts/send.py", ["alpha", "beta", "message", "Test"], bridge)
        result = run_script("scripts/status.py", [], bridge)
        assert "alpha" in result.stdout
        assert "pending" in result.stdout


class TestCleanup:
    def test_removes_expired(self, bridge):
        expired = {
            "id": "msg-expired",
            "timestamp": "2020-01-01T00:00:00Z",
            "from": "alpha", "to": "beta", "type": "message",
            "content": {"text": "old", "parts": []},
            "ttl": 3600,
        }
        done_dir = bridge / "to-beta" / "done"
        (done_dir / "msg-expired.json").write_text(json.dumps(expired), encoding="utf-8")
        before = len(list(done_dir.glob("*.json")))
        run_script("scripts/cleanup.py", ["--max-age-hours", "1"], bridge)
        after = len(list(done_dir.glob("*.json")))
        assert after < before


class TestAtomicWriteIntegration:
    def test_send_creates_complete_json(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Atomic test"], bridge)
        fp = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        assert all(k in msg for k in ("id", "timestamp", "from", "to", "type", "content"))


class TestHMACSigning:
    def test_signed_message_has_hmac(self, bridge):
        (bridge / "secret.key").write_text("a" * 64, encoding="utf-8")
        run_script("scripts/send.py", ["alpha", "beta", "message", "Signed msg"], bridge)
        fp = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        assert "hmac" in msg
        assert len(msg["hmac"]) == 64

    def test_unsigned_when_no_secret(self, bridge):
        run_script("scripts/send.py", ["alpha", "beta", "message", "Unsigned"], bridge)
        fp = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        assert "hmac" not in msg

    def test_receive_shows_verified(self, bridge):
        (bridge / "secret.key").write_text("b" * 64, encoding="utf-8")
        run_script("scripts/send.py", ["alpha", "beta", "message", "Check sig"], bridge)
        result = run_script("scripts/receive.py", ["beta", "--peek"], bridge)
        assert "verified" in result.stdout.lower()

    def test_receive_shows_invalid_for_tampered(self, bridge):
        (bridge / "secret.key").write_text("c" * 64, encoding="utf-8")
        run_script("scripts/send.py", ["alpha", "beta", "message", "Will tamper"], bridge)
        fp = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        msg["content"]["text"] = "TAMPERED"
        fp.write_text(json.dumps(msg), encoding="utf-8")
        result = run_script("scripts/receive.py", ["beta", "--peek"], bridge)
        assert "invalid" in result.stdout.lower()


class TestSizeLimit:
    def test_oversized_message_rejected(self, bridge):
        from cc2cc.core import atomic_write, MAX_MESSAGE_SIZE
        inbox = bridge / "to-beta" / "inbox"
        msg = {"id": "msg-big", "content": {"text": "x" * 1_100_000}}
        with pytest.raises(ValueError, match="exceeds maximum"):
            atomic_write(inbox / "msg-big.json", msg)
        files = list(inbox.glob("msg-*.json"))
        assert len(files) == 0


class TestInitSecret:
    def test_init_creates_secret_key(self, bridge):
        from cc2cc.signing import generate_secret
        secret = generate_secret()
        (bridge / "secret.key").write_text(secret, encoding="utf-8")
        assert (bridge / "secret.key").exists()
        assert len((bridge / "secret.key").read_text(encoding="utf-8")) == 64


class TestTaskWithHMAC:
    def test_task_signed_when_secret_exists(self, bridge):
        (bridge / "secret.key").write_text("d" * 64, encoding="utf-8")
        run_script("scripts/task.py", ["alpha", "beta", "Run tests", "Execute all tests"], bridge)
        fp = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(fp.read_text(encoding="utf-8"))
        assert "hmac" in msg
        assert msg["type"] == "task"
        assert msg["task"]["title"] == "Run tests"


class TestReplyWithHMAC:
    def test_reply_signed_when_secret_exists(self, bridge):
        (bridge / "secret.key").write_text("e" * 64, encoding="utf-8")
        run_script("scripts/send.py", ["alpha", "beta", "message", "Hello"], bridge)
        msg_file = next((bridge / "to-beta" / "inbox").glob("msg-*.json"))
        msg = json.loads(msg_file.read_text(encoding="utf-8"))
        run_script("scripts/reply.py", [msg["id"], "Got it!", "beta"], bridge)
        replies = list((bridge / "to-alpha" / "inbox").glob("msg-*.json"))
        assert len(replies) == 1
        reply = json.loads(replies[0].read_text(encoding="utf-8"))
        assert "hmac" in reply
        assert reply["type"] == "response"


class TestLegacyCompat:
    """Verify backwards compatibility with old alpha-to-beta/ format."""

    def test_receive_reads_legacy_inbox(self, bridge):
        """Messages in old format dirs are still found by receive.py."""
        legacy_inbox = bridge / "alpha-to-beta" / "inbox"
        legacy_inbox.mkdir(parents=True, exist_ok=True)
        (bridge / "alpha-to-beta" / "done").mkdir(parents=True, exist_ok=True)
        msg = {
            "id": "msg-legacy-1", "timestamp": "2026-03-27T10:00:00Z",
            "from": "alpha", "to": "beta", "type": "message",
            "content": {"text": "legacy message", "parts": []},
            "priority": "normal",
        }
        (legacy_inbox / "msg-legacy-1.json").write_text(
            json.dumps(msg), encoding="utf-8"
        )
        result = run_script("scripts/receive.py", ["beta", "--peek"], bridge)
        assert "legacy message" in result.stdout
```

- [ ] **Step 3: Run all tests**

Run: `python -m pytest tests/ -v`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/test_smoke.py tests/test_unit.py tests/test_names.py
git commit -m "test: update tests for unified server directory format"
```

---

### Task 6: Update CLI and Package Config

**Files:**
- Modify: `cc2cc/cli.py`
- Modify: `channel/package.json`

- [ ] **Step 1: Update cli.py — simplify init command**

Change the `cmd_init` function and init subparser:

```python
def cmd_init(args):
    argv = []
    if args.bridge_dir:
        argv.append(args.bridge_dir)
    _run_script("scripts/init.py", argv)
```

And the parser:

```python
    # init
    p = sub.add_parser("init", help="Initialize bridge")
    p.add_argument("bridge_dir", nargs="?", default=None)
    p.set_defaults(func=cmd_init)
```

Remove the `agent_a` and `agent_b` arguments — they are no longer needed.

- [ ] **Step 2: Update channel/package.json version**

```json
{
  "name": "cc2cc-server",
  "version": "3.0.0",
  "description": "CC2CC Unified MCP Server — dynamic identity, multi-agent",
  "type": "module",
  "main": "server.mjs",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add cc2cc/cli.py channel/package.json
git commit -m "feat: simplify CLI init, update package.json for v3.0"
```

---

### Task 7: Update Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/CONFIGURATION.md`
- Modify: `docs/SPECIFICATION.md`

- [ ] **Step 1: Update README.md quick start section**

Replace the Quick Start section with:

```markdown
## Quick Start

### 1. Clone and initialize

```bash
git clone https://github.com/non4me/cc2cc.git
cd cc2cc
pip install -e .
cc2cc init
```

### 2. Configure Claude Code

Add to `~/.claude/settings.json`:

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

That's it. Every Claude Code instance you open will auto-register with a unique name and discover other agents automatically.

### 3. Open two terminals

```bash
# Terminal 1
claude
# You'll see: [cc2cc] You are brave-fox. No other agents online

# Terminal 2
claude
# You'll see: [cc2cc] You are calm-owl. Online agents: brave-fox
# Terminal 1 sees: [cc2cc] calm-owl joined
```

### 4. Send messages (from inside Claude Code)

The agent can use MCP tools directly:
- `send(to="brave-fox", text="Hello!")` — send to specific agent
- `broadcast(text="Deploy starting")` — send to all
- `reply(msg_id="msg-xxx", text="Got it")` — reply to a message
- `list_agents()` — see who's online
- `whoami()` — check your name
- `register(name="devops")` — change your name
```

- [ ] **Step 2: Update README architecture diagram**

```markdown
## Architecture

```
┌─────────────────┐                              ┌─────────────────┐
│  Claude Code A   │                              │  Claude Code B   │
│  (auto: brave-fox)│                             │  (auto: calm-owl)│
│                  │                              │                  │
│  MCP Server ◄────┼─── to-brave-fox/inbox/ ◄─────┼── send tool     │
│  (polls inbox)   │                              │                  │
│  send tool ──────┼──► to-calm-owl/inbox/ ───────┼──► MCP Server   │
│                  │                              │  (polls inbox)   │
│  Tools:          │    status/                   │  Tools:          │
│  send, broadcast │    brave-fox-heartbeat.json  │  send, broadcast │
│  reply, register │    calm-owl-heartbeat.json   │  reply, register │
│  list_agents     │                              │  list_agents     │
│  whoami          │                              │  whoami          │
└─────────────────┘                              └─────────────────┘
```
```

- [ ] **Step 3: Update docs/CONFIGURATION.md with new config**

Replace the full example with the simplified single-config approach. Remove SELF/PEER documentation, add note about backwards compatibility.

- [ ] **Step 4: Update docs/SPECIFICATION.md with new directory layout**

Update the directory layout section to show `to-{name}/` format. Add backwards compatibility note about legacy `{a}-to-{b}/` format.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/CONFIGURATION.md docs/SPECIFICATION.md
git commit -m "docs: update for unified MCP server v3.0"
```

---

### Task 8: End-to-End Verification

- [ ] **Step 1: Clean up old bridge and reinitialize**

```bash
rm -rf ~/.cc2cc
cd /path/to/cc2cc && cc2cc init
```

- [ ] **Step 2: Run full test suite**

Run: `python -m pytest tests/ -v`
Expected: All tests PASS

- [ ] **Step 3: Run Node.js name tests**

Run: `node --test tests/test_names.mjs`
Expected: All tests PASS

- [ ] **Step 4: Manual smoke test — server startup**

```bash
cd ~/.cc2cc && timeout 5 node server.mjs 2>&1
```

Expected: Server starts, generates name, writes heartbeat, logs start message. Exits after timeout.

- [ ] **Step 5: Verify settings.json config is correct**

Check `~/.claude/settings.json` has the simplified MCP config (no SELF/PEER).

- [ ] **Step 6: Commit any remaining fixes**

```bash
git add -A
git commit -m "chore: end-to-end verification fixes"
```

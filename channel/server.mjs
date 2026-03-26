#!/usr/bin/env node

/**
 * CC2CC MCP Channel Server
 *
 * Polls the inbox for messages from a peer agent and pushes them
 * into the Claude Code session as channel notifications.
 *
 * Exposes a single "reply" tool so the agent can respond.
 *
 * Environment:
 *   BRIDGE_DIR — path to bridge root (default: ~/.cc2cc)
 *   SELF       — this agent's ID (default: alpha)
 *   PEER       — peer agent's ID (default: beta)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readdir, readFile, rename, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

const BRIDGE_DIR = process.env.BRIDGE_DIR || `${process.env.HOME}/.cc2cc`;
const SELF = process.env.SELF || "alpha";
const PEER = process.env.PEER || "beta";
const POLL_MS = 3000;

const INBOX = join(BRIDGE_DIR, `${PEER}-to-${SELF}`, "inbox");
const DONE = join(BRIDGE_DIR, `${PEER}-to-${SELF}`, "done");
const OUTBOX = join(BRIDGE_DIR, `${SELF}-to-${PEER}`, "inbox");

const server = new Server(
  { name: "peer_channel", version: "1.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
  }
);

// Instructions injected into Claude Code's context
// NOTE: _handleInitialize is a private SDK method — may break on SDK updates
server.setRequestHandler({ method: "initialize" }, async (request) => {
  const result = await server._handleInitialize(request);
  result.instructions = [
    `Messages from your peer agent "${PEER}" arrive as <channel> tags.`,
    `Reply using the "reply" tool, passing the msg_id from the tag.`,
    `If the message is a task (type=task), execute it and send the result.`,
    `Always show A2A dialog to the user.`,
  ].join(" ");
  return result;
});

// Reply tool — the only tool exposed
server.setRequestHandler({ method: "tools/list" }, async () => ({
  tools: [
    {
      name: "reply",
      description: `Reply to ${PEER} through the A2A bridge`,
      inputSchema: {
        type: "object",
        properties: {
          msg_id: {
            type: "string",
            description: "Message ID from <channel> tag (for threading)",
          },
          text: { type: "string", description: "Reply content" },
          type: {
            type: "string",
            enum: ["message", "response", "task"],
            default: "response",
          },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "critical"],
            default: "normal",
          },
        },
        required: ["msg_id", "text"],
      },
    },
  ],
}));

// Handle reply tool calls
server.setRequestHandler({ method: "tools/call" }, async ({ params }) => {
  if (params.name !== "reply") {
    return { content: [{ type: "text", text: "Unknown tool" }] };
  }

  const {
    msg_id,
    text,
    type = "response",
    priority = "normal",
  } = params.arguments;

  const id = `msg-${randomUUID()}`;
  const msg = {
    id,
    timestamp: new Date().toISOString(),
    from: SELF,
    to: PEER,
    type,
    priority,
    identity: { agent: SELF, mode: "session" },
    task: null,
    content: { text, parts: [] },
    replyTo: msg_id || null,
    ttl: 3600,
  };

  await mkdir(OUTBOX, { recursive: true });
  await writeFile(join(OUTBOX, `${id}.json`), JSON.stringify(msg, null, 2));
  return {
    content: [{ type: "text", text: `Sent ${id} to ${PEER}` }],
  };
});

// --- Polling loop: watch inbox, push to channel ---

const seenFiles = new Set();

async function drainInbox() {
  await mkdir(INBOX, { recursive: true });
  await mkdir(DONE, { recursive: true });

  let files;
  try {
    files = (await readdir(INBOX)).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }

  for (const file of files) {
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);

    try {
      const raw = await readFile(join(INBOX, file), "utf8");
      const msg = JSON.parse(raw);

      const taskTitle = msg.task?.title ? `[${msg.task.title}] ` : "";
      const content = `${taskTitle}${msg.content?.text || ""}`;

      // Push channel notification to Claude Code
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

      // Move to done/
      await rename(join(INBOX, file), join(DONE, file));
    } catch (err) {
      // Skip malformed messages silently
    }
  }

  // Prevent memory leak on long-running sessions
  if (seenFiles.size > 500) seenFiles.clear();
}

// Start polling
setInterval(drainInbox, POLL_MS);
drainInbox();

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);

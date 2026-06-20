#!/usr/bin/env node

/**
 * CC2CC MCP Channel Server v3.0
 *
 * Unified multi-agent communication server with dynamic identity.
 * Auto-generates a unique name on startup, discovers peers via heartbeats,
 * and exposes 7 MCP tools: whoami, list_agents, send, broadcast, reply, check_inbox, register.
 *
 * Ephemeral mailboxes: on startup, stale agent directories are cleaned up.
 * Sending to offline agents is rejected — mailboxes only exist for active sessions.
 *
 * Environment:
 *   CC2CC_BRIDGE_DIR / BRIDGE_DIR — path to bridge root (default: ~/.cc2cc)
 *   SELF — override auto-generated agent name
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readdir, readFile, rename, mkdir, writeFile, stat, rm } from "fs/promises";
import { writeFileSync } from "fs";
import { join, basename, dirname } from "path";
import { randomUUID, createCipheriv, createDecipheriv, scryptSync } from "crypto";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { realpathSync } from "fs";
import { generateUniqueName, validateName, takenNames } from "./names.mjs";
import * as relay from "./relay.mjs";
import { ensureDaemon, connectToDaemon } from "./daemon-client.mjs";
import { render as tpl, loadTemplateOverrides } from "./templates.mjs";

// ─── Constants ───────────────────────────────────────────────────────────────

const POLL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_STALE_S = 15;
const SEEN_FILES_CAP = 500;
const DEFAULT_TTL = 3600;

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
const BRIDGE_DIR =
  process.env.CC2CC_BRIDGE_DIR || process.env.BRIDGE_DIR || join(HOME, ".cc2cc");

// Identity name from the launcher env (cc-launch sets CC2CC_IDENTITY; SELF is the
// legacy alias). When present and valid, identity is stored per-name so multiple
// agents can share one bridge with distinct names/teams/roles. Falls back to the
// legacy single identity.json when no (valid) name is supplied.
const RAW_IDENTITY_NAME = process.env.CC2CC_IDENTITY || process.env.SELF || null;
const IDENTITY_NAME =
  RAW_IDENTITY_NAME && validateName(RAW_IDENTITY_NAME) ? RAW_IDENTITY_NAME : null;
const IDENTITY_PATH = join(
  BRIDGE_DIR,
  "identities",
  IDENTITY_NAME ? `identity-${IDENTITY_NAME}.json` : "identity.json",
);

// ─── State ───────────────────────────────────────────────────────────────────

let agentName = null; // set during init
let notificationRules = null; // loaded from rules.json
const onlineSince = new Date().toISOString();
const sessionId = String(process.pid);
const seenFiles = new Set();
let knownAgents = new Map(); // name → heartbeat data
let agentStatus = "Idle"; // Default status (v3.6)
let pollTimer = null;
let statusTimer = null;
let heartbeatTimer = null;
// Daemon mode (v3.7): the standalone daemon owns the hub connection; this MCP does not poll
// the hub. daemonMode = a daemon is ensured + we're connected for wake pushes.
let daemonMode = false;
let relayConfigured = false;
let daemonClient = null;
/** Relay is reachable for this session iff a daemon owns it and a hub is configured. */
function relayActive() { return daemonMode && relayConfigured; }
let wakeAcknowledged = false; // set true when direct push succeeds
let agentIdentity = null; // loaded during init — {display_name, agent_id, created, teams}
let participating = false; // opt-in: false until the session joins (env identity or register)
let lastIdentityTouch = 0; // throttle for persisting identity last_seen
let teamLeaders = new Map(); // team_name → leader_agent_name
// Operator/governance policy from cc2cc_admin (team-<name>.json on this bridge):
let operatorLeaders = new Map(); // team → leader (AUTHORITATIVE, overrides heartbeat-derived)
let teamRevoked = new Map();      // team → Set(member) whose participation was revoked

// Default federation GAB policy — message-handling + governance defaults for this server.
// A bridge-level policy.json overrides these; team rules can override per-team.
const DEFAULT_POLICY = {
  messages: { retention_days: 4, stale_after_hours: 24, max_age_days: 5 },
  teams: { default_admission: "open", sticky_leader: true },
  // identities: when an agent is considered offline (no heartbeat) vs. fully EXPIRED
  // (absent long enough to be treated as non-existent and garbage-collected).
  identities: { offline_after_seconds: 15, expire_days: 30 },
  directory: { active_seconds: 60, expire_days: 4 },
  relay: { encrypt_required: true },
};
let policy = DEFAULT_POLICY;

// ─── Encryption (optional, enabled via CC2CC_ENCRYPT=1) ─────────────────────

const ENCRYPT_ENABLED = process.env.CC2CC_ENCRYPT === "1";
let encryptionKey = null; // derived from secret.key via scrypt
/** Test-only: set encryption key for decryptMessage tests. */
export function setEncryptionKey(key) { encryptionKey = key; }

async function loadEncryptionKey() {
  if (!ENCRYPT_ENABLED) return;
  try {
    const secretPath = join(BRIDGE_DIR, "secret.key");
    const secret = (await readFile(secretPath, "utf8")).trim();
    encryptionKey = scryptSync(secret, "cc2cc-aes", 32);
  } catch {
    encryptionKey = null;
  }
}

function encryptText(plaintext) {
  if (!encryptionKey) return plaintext;
  const iv = Buffer.from(randomUUID().replace(/-/g, ""), "hex").subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `ENC:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptText(data) {
  if (!encryptionKey || !data.startsWith("ENC:")) return data;
  try {
    const [, ivHex, tagHex, encHex] = data.split(":");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(encHex, "hex"), null, "utf8") + decipher.final("utf8");
  } catch (err) {
    log("error", "GCM decryption failed, possible tampering", { error: err.message });
    throw new Error("Decryption failed: Invalid authentication tag");
  }
}

// ─── Status Management (v3.6) ────────────────────────────────────────────────

async function handleSetStatus({ status }) {
  if (typeof status !== "string") {
    return {
      content: [{ type: "text", text: "Status must be a string." }],
      isError: true,
    };
  }

  const maxLength = 120;
  if (status.length > maxLength) {
    return {
      content: [{ type: "text", text: `Status is too long (max ${maxLength} chars).` }],
      isError: true,
    };
  }

  // Sanitize: strip control characters
  const sanitizedStatus = status.replace(/[\r\n\x00-\x1F\x7F-\x9F]/g, "");
  agentStatus = sanitizedStatus || "Idle";

  // Trigger immediate heartbeat to broadcast change
  await writeHeartbeat("active", "status update");

  return {
    content: [{ type: "text", text: `Status updated to: "${agentStatus}"` }],
  };
}

// ─── Logging (structured JSON → stderr; stdout is MCP transport) ─────────────

function log(level, msg, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    server: agentName,
    msg,
    ...data,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function inboxDir(name) {
  return join(BRIDGE_DIR, `to-${name}`, "inbox");
}
function doneDir(name) {
  return join(BRIDGE_DIR, `to-${name}`, "done");
}
function receiptsDir(name) {
  return join(BRIDGE_DIR, `to-${name}`, "receipts");
}
function statusDir() {
  return join(BRIDGE_DIR, "status");
}

/** Retry-aware rename: handles Windows AV file locking (EPERM/EACCES). */
async function retryRename(src, dst, retries = 5, delayMs = 50) {
  for (let i = 0; i < retries; i++) {
    try {
      await rename(src, dst);
      return;
    } catch (err) {
      if ((err.code === "EPERM" || err.code === "EACCES") && i < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

/** Atomic write: tmp file → rename */
async function atomicWrite(targetPath, data) {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}.json`);
  await writeFile(tmpPath, JSON.stringify(data, null, 2));
  await retryRename(tmpPath, targetPath);
}

/** Build a message object (encrypts content.text if encryption enabled) */
function buildMessage({ from, to, text, type = "message", priority = "normal", replyTo = null, task = null }) {
  return {
    id: `msg-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    from,
    to,
    type,
    priority,
    identity: { agent: from, mode: "session" },
    task,
    content: { text: encryptText(text), parts: [] },
    replyTo,
    ttl: DEFAULT_TTL,
  };
}

/** Decrypt content.text if encrypted. Returns null on failure — caller must skip/remove the file. */
export function decryptMessage(msg) {
  if (msg?.content?.text && msg.content.text.startsWith("ENC:")) {
    try {
      msg.content.text = decryptText(msg.content.text);
    } catch (err) {
      log("error", "message decryption failed, discarding", { msg_id: msg.id, from: msg.from });
      return null; // quarantine — never surface ciphertext
    }
  }
  return msg;
}

// ─── Identity ─────────────────────────────────────────────────────────────────

/**
 * Load identity from BRIDGE_DIR/identity.json.
 * Returns null if file doesn't exist, is corrupted, or has missing fields.
 * Backs up corrupted files before returning null.
 */
async function loadIdentity() {
  try {
    const raw = await readFile(IDENTITY_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data.display_name || !data.agent_id || !data.created || !Array.isArray(data.teams)) {
      log("warn", "identity.json missing required fields, regenerating");
      return null;
    }
    return data;
  } catch (err) {
    if (err.code === "ENOENT") return null; // first boot
    // Corrupted — back up
    try {
      await rename(IDENTITY_PATH, IDENTITY_PATH + ".corrupted");
      log("warn", "identity.json corrupted, backed up as identity.json.corrupted and regenerating");
    } catch { /* best effort backup */ }
    return null;
  }
}

/** Save identity object atomically to IDENTITY_PATH. */
async function saveIdentity(identity) {
  await atomicWrite(IDENTITY_PATH, identity);
}

/** Create a new identity with the given display name, UUID, and teams/role.
 * Teams/role are seeded from CC2CC_TEAM (comma-separated) / CC2CC_ROLE when set,
 * else default to ["cc2cc"] / "member". */
async function createIdentity(name) {
  const envTeams = (process.env.CC2CC_TEAM || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  // Identity = who you are (name, id, teams you're in). It does NOT carry a role —
  // leadership/membership-role is defined by the team registry (teams.json) and derived.
  const identity = {
    display_name: name,
    agent_id: randomUUID(),
    created: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    teams: envTeams.length ? envTeams : ["cc2cc"],
  };
  await saveIdentity(identity);
  log("info", "identity created", { name, agent_id: identity.agent_id, teams: identity.teams });
  return identity;
}

/**
 * Load existing identity or create a new one with the candidate name.
 * Existing identity always takes precedence (display_name is source of truth).
 */
async function ensureIdentity(candidateName) {
  const existing = await loadIdentity();
  if (existing) {
    log("info", "identity loaded", { name: existing.display_name, agent_id: existing.agent_id });
    return existing;
  }
  return await createIdentity(candidateName);
}

/** Write heartbeat to status/{name}-heartbeat.json */
async function writeHeartbeat(statusValue = "active", context = "session started") {
  const hb = {
    agent: agentName,
    name: agentName, // compat with takenNames() in names.mjs
    timestamp: new Date().toISOString(),
    heartbeat: new Date().toISOString(), // compat with takenNames()
    session_id: sessionId,
    parent_pid: String(process.ppid),
    status: statusValue,
    context,
    status_text: agentStatus,
    teams: agentIdentity?.teams || ["cc2cc"],
  };
  const filePath = join(statusDir(), `${agentName}-heartbeat.json`);
  await atomicWrite(filePath, hb);

  // Persist last_seen into the identity file (throttled) so expiry can be computed from the
  // identity alone — even after the (transient) heartbeat is gone.
  if (agentIdentity) {
    const nowMs = Date.now();
    if (nowMs - lastIdentityTouch >= 30000) {
      lastIdentityTouch = nowMs;
      agentIdentity.last_seen = new Date().toISOString();
      saveIdentity(agentIdentity).catch(() => {});
    }
  }
}

/** Check if a heartbeat is stale */
function isStale(heartbeatData) {
  const ts = heartbeatData.timestamp || heartbeatData.heartbeat;
  if (!ts) return true;
  const age = (Date.now() - new Date(ts).getTime()) / 1000;
  return age > HEARTBEAT_STALE_S;
}

/** Check if an agent is online based on known heartbeat data */
function isAgentOnline(name) {
  const hb = knownAgents.get(name);
  if (!hb) return false;
  if (hb.status !== "active") return false;
  return !isStale(hb);
}

/** Role is DERIVED from the team registry: an agent is "leader" if it leads any team it's
 *  in, else "member". Not stored on the identity/heartbeat. */
function roleOf(name, teams) {
  return (teams || []).some((t) => teamLeaders.get(t) === name) ? "leader" : "member";
}

/** Get list of all agents with status info (teams + derived role for team-aware filtering) */
function getAgentList() {
  const agents = [];
  for (const [name, hb] of knownAgents) {
    const online = hb.status === "active" && !isStale(hb);
    const teams = effectiveTeams(name, hb.teams); // GAB policy: revoked memberships excluded
    agents.push({
      name,
      status: online ? "online" : "offline",
      status_text: online ? (hb.status_text || "Idle") : null,
      last_seen: hb.timestamp || hb.heartbeat,
      is_self: name === agentName,
      teams,
      role: roleOf(name, teams), // derived from teams.json, not stored
    });
  }
  return agents;
}

/** Get names of online agents (excluding self), optionally filtered by team */
function onlineAgentNames(teamFilter) {
  return getAgentList()
    .filter((a) => a.status === "online" && !a.is_self)
    .filter((a) => !teamFilter || (a.teams && a.teams.includes(teamFilter)))
    .map((a) => a.name);
}

/** Get all known agent names (for broadcast notifications) */
function allAgentNames() {
  return [...knownAgents.keys()].filter((n) => n !== agentName);
}

/** Check if two agents share at least one team. */
function sharesTeam(agentA, agentB) {
  const aData = getAgentList().find((a) => a.name === agentA);
  const bData = getAgentList().find((a) => a.name === agentB);
  const aTeams = aData?.teams || ["cc2cc"];
  const bTeams = bData?.teams || ["cc2cc"];
  return aTeams.some((t) => bTeams.includes(t));
}

// ─── MCP Server Setup ───────────────────────────────────────────────────────

const server = new Server(
  {
    name: "cc2cc_channel",
    version: "3.0.0",
    instructions: [
      "You are connected to CC2CC — an agent-to-agent communication bridge.",
      "Other agents can send you messages. Incoming messages appear as INCOMING MESSAGES blocks in tool responses.",
      "IMPORTANT: When you see INCOMING MESSAGES, you MUST react to them — read, respond, or act on tasks.",
      "Use check_inbox periodically (every few interactions) to see if anyone sent you something.",
      "Use send/reply/broadcast to communicate. Use list_agents to see who is online.",
      "If a message is a task, execute it and reply with the result.",
    ].join(" "),
  },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
  }
);

// ─── Tool Definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "whoami",
    description: "Returns this agent's identity, uptime, bridge directory, and list of online agents",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_agents",
    description: "Returns all known agents with their status (online/offline) and last seen time",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "send",
    description: "Send a message to another agent on the same team. Cross-team sends are blocked — use send_team instead.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient agent name" },
        text: { type: "string", description: "Message content" },
        type: {
          type: "string",
          enum: ["message", "task", "response", "status"],
          default: "message",
          description: "Message type",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "critical"],
          default: "normal",
          description: "Message priority",
        },
      },
      required: ["to", "text"],
    },
  },
  {
    name: "broadcast",
    description: "Send a message to all online agents on the same team. Cross-team broadcasting is not allowed.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message content" },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "critical"],
          default: "normal",
          description: "Message priority",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "reply",
    description: "Reply to a received message by msg_id. Auto-completes tasks when replying to task messages.",
    inputSchema: {
      type: "object",
      properties: {
        msg_id: {
          type: "string",
          description: "Message ID to reply to (from channel notification)",
        },
        text: { type: "string", description: "Reply content" },
      },
      required: ["msg_id", "text"],
    },
  },
  {
    name: "check_inbox",
    description: "Check for new incoming messages. Also happens automatically on every other tool call.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "register",
    description: "Join the cc2cc system (if not already), or change this agent's name. Leadership is NOT set here — use create_team or ask a team leader (roles live in the team registry).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Your agent name (lowercase alphanumeric with hyphens, max 31 chars)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "send_team",
    description: "Send a cross-team message to another team via their team leader. The leader's inbox receives the message.",
    inputSchema: {
      type: "object",
      properties: {
        team: { type: "string", description: "Target team name" },
        text: { type: "string", description: "Message content" },
        type: {
          type: "string",
          enum: ["message", "task", "response", "status"],
          default: "message",
          description: "Message type",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "critical"],
          default: "normal",
          description: "Message priority",
        },
      },
      required: ["team", "text"],
    },
  },
  {
    name: "list_teams",
    description: "Lists all known teams with their designated leader, total member count, and currently online count.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "set_status",
    description: "Set this agent's status text, broadcast to other agents via heartbeat.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Status text (max 120 chars)" },
      },
      required: ["status"],
    },
  },
  {
    name: "register_relay",
    description: "Configure cross-machine relay. Sets up relay.json and registers with the Relay Hub. Requires a running relay hub.",
    inputSchema: {
      type: "object",
      properties: {
        hub_url: { type: "string", description: "Relay Hub URL (e.g., http://192.168.1.50:8080)" },
        token: { type: "string", description: "Relay auth token" },
        team: { type: "string", description: "Team name to register under (default: same as identity team)" },
        enabled: { type: "boolean", default: true, description: "Enable or disable relay" },
      },
      required: ["hub_url"],
    },
  },
  {
    name: "create_team",
    description: "Create a new team (you become its leader). In-session equivalent of launching with CC2CC_TEAM or `cc2cc_admin team create`.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "New team name (lowercase a-z, 0-9, hyphens)" },
        admission: { type: "string", enum: ["open", "approved"], description: "Join policy (default open)" },
        retention_days: { type: "integer", description: "Message retention for this team (default 4)" },
      },
      required: ["name"],
    },
  },
  {
    name: "request_join",
    description: "Request to join a team. Routes a join request to that team's leader (via standard cross-team messaging); the leader admits at their discretion. Any agent may call this.",
    inputSchema: {
      type: "object",
      properties: {
        team: { type: "string", description: "Team you want to join" },
        note: { type: "string", description: "Optional message to the leader (why you want to join)" },
      },
      required: ["team"],
    },
  },
  {
    name: "admit",
    description: "Team leader: admit an agent into a team you lead. Updates the team roster (team-<name>.json). Only the team's leader may call this.",
    inputSchema: {
      type: "object",
      properties: {
        team: { type: "string", description: "Team to admit into (must be one you lead)" },
        agent: { type: "string", description: "Agent name to admit" },
      },
      required: ["team", "agent"],
    },
  },
  {
    name: "evict",
    description: "Team leader: revoke an agent's participation in a team you lead (emits a tombstone). Does NOT delete the agent's identity. Only the team's leader may call this.",
    inputSchema: {
      type: "object",
      properties: {
        team: { type: "string", description: "Team to evict from (must be one you lead)" },
        agent: { type: "string", description: "Agent name to evict" },
      },
      required: ["team", "agent"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// ─── Tool Handlers ──────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const { name: toolName, arguments: args } = params;

  try {
    let result;
    switch (toolName) {
      case "whoami":
        result = handleWhoami(); break;
      case "list_agents":
        result = handleListAgents(); break;
      case "send":
        result = await handleSend(args); break;
      case "broadcast":
        result = await handleBroadcast(args); break;
      case "reply":
        result = await handleReply(args); break;
      case "check_inbox":
        result = textResult("Inbox checked."); break;
      case "register":
        result = await handleRegister(args); break;
      case "send_team":
        result = await handleSendTeam(args); break;
      case "list_teams":
        result = handleListTeams(); break;
      case "set_status":
        result = await handleSetStatus(args); break;
      case "register_relay":
        result = await relay.handleRegisterRelay(BRIDGE_DIR, args); break;
      case "create_team":
        result = await handleCreateTeam(args); break;
      case "request_join":
        result = await handleRequestJoin(args); break;
      case "admit":
        result = await handleAdmit(args); break;
      case "evict":
        result = await handleEvict(args); break;
      default:
        return textResult(`Unknown tool: ${toolName}`, true);
    }

    // Piggyback: consume inbox and append any pending messages to the response
    const pending = await consumeInbox();
    if (pending.length > 0) {
      const pendingText = formatPendingMessages(pending);
      // Append pending messages to the first text content block
      if (result.content && result.content.length > 0 && result.content[0].type === "text") {
        result.content[0].text += pendingText;
      } else {
        result.content.push({ type: "text", text: pendingText });
      }
    }

    return result;
  } catch (err) {
    log("error", `tool ${toolName} failed`, { error: err.message });
    return textResult(`Error: ${err.message}`, true);
  }
});

function textResult(text, isError = false) {
  const result = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

function jsonResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

// ── whoami ──

// 12b: In the daemon model the DAEMON owns the relay loop, so the MCP's own relayEnabled flag
// is always false even while the relay is live. Report liveness from the daemon link instead,
// so whoami doesn't contradict list_agents (which correctly shows remote peers online).
function relayStatusForUi() {
  const s = relay.getRelayStatus();
  if (daemonMode) s.enabled = relayActive();
  return s;
}

function handleWhoami() {
  const peers = getAgentList().filter((a) => a.status === "online" && !a.is_self);
  const whoami = {
    name: agentName,
    agent_id: agentIdentity?.agent_id || "unset",
    teams: agentIdentity?.teams || [],
    role: roleOf(agentName, agentIdentity?.teams || []), // derived from teams.json
    registered: !!agentIdentity,
    identity_file: IDENTITY_PATH,
    online_since: onlineSince,
    bridge_dir: BRIDGE_DIR,
    online_agents: peers.map((a) => a.name),
    // Structured roster so callers can name peers (and their team/role) directly.
    online_roster: peers.map((a) => ({ name: a.name, teams: a.teams, role: a.role })),
    relay: relayStatusForUi(),
    // Presentation guidance for the agent relaying this to a human.
    _note:
      "Refer to agents by `name` (e.g. \"alpha-mem\") when reporting to the user — never by agent_id. " +
      "`agent_id` is an internal UUID, not a human-facing identifier.",
  };
  return jsonResult(whoami);
}

// ── list_agents ──

function handleListAgents() {
  const local = getAgentList();
  let remote = [];
  if (relayActive()) {
    remote = relay.getRemoteAgents();
  }
  return jsonResult([...local, ...remote]);
}

// ── send ──

async function handleSend({ to, text, type = "message", priority = "normal" }) {
  if (!to || !text) return textResult("Missing required fields: to, text", true);

  // Bug 0d fix: if the target is a known REMOTE agent (another machine), a local inbox write
  // would strand. Relay via that agent's team instead (reaches the team leader).
  const remote = relayActive() ? relay.getRemoteAgents().find((a) => a.name === to) : null;
  if (remote && remote.team) {
    log("info", "direct send relayed via remote team", { to, team: remote.team });
    return handleSendTeam({ team: remote.team, text, intent: type });
  }

  // Block cross-team direct sends (check before offline check — remote agents
  // may be offline on this machine but reachable via send_team relay)
  if (!sharesTeam(agentName, to)) {
    return textResult(tpl("cross_team_blocked", { to }), true);
  }

  if (!isAgentOnline(to)) {
    return textResult(`Agent "${to}" is offline. Message not sent. Use list_agents to see who is online.`, true);
  }

  const msg = buildMessage({ from: agentName, to, text, type, priority });
  const targetInbox = inboxDir(to);
  await mkdir(targetInbox, { recursive: true });
  await atomicWrite(join(targetInbox, `${msg.id}.json`), msg);

  log("info", "message sent", { id: msg.id, to });
  return textResult(`Sent ${msg.id} to ${to} — delivered to inbox`);
}

// ── broadcast ──

async function handleBroadcast({ text, priority = "normal" }) {
  if (!text) return textResult("Missing required field: text", true);

  const targets = onlineAgentNames().filter((t) => sharesTeam(agentName, t));
  if (targets.length === 0) {
    return textResult("No team members online. Broadcast is same-team only.");
  }

  const results = [];
  for (const to of targets) {
    const msg = buildMessage({ from: agentName, to, text, type: "message", priority });
    const targetInbox = inboxDir(to);
    await mkdir(targetInbox, { recursive: true });
    await atomicWrite(join(targetInbox, `${msg.id}.json`), msg);
    results.push({ to, id: msg.id, online: isAgentOnline(to) });
  }

  log("info", "broadcast sent", { count: results.length });
  return jsonResult({ broadcast: true, recipients: results });
}

// ── reply ──

async function handleReply({ msg_id, text }) {
  if (!msg_id || !text) return textResult("Missing required fields: msg_id, text", true);

  // Try to find the original message — check inbox first (channel push
  // may arrive before consumeInbox moves the file to done/)
  let originalMsg = null;
  const myInbox = inboxDir(agentName);

  try {
    const files = await readdir(myInbox);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(myInbox, f), "utf8");
        const m = JSON.parse(raw);
        if (m.id === msg_id) {
          originalMsg = m;
          break;
        }
      } catch { /* skip */ }
    }
  } catch { /* inbox may not exist */ }

  // Then check done dir
  if (!originalMsg) {
    const myDone = doneDir(agentName);
    try {
      const files = await readdir(myDone);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(myDone, f), "utf8");
          const m = JSON.parse(raw);
          if (m.id === msg_id) {
            originalMsg = m;
            break;
          }
        } catch { /* skip */ }
      }
    } catch { /* done dir may not exist */ }
  }

  // Also check legacy inbox paths
  if (!originalMsg) {
    try {
      const topDirs = await readdir(BRIDGE_DIR);
      for (const d of topDirs) {
        if (!d.endsWith(`-to-${agentName}`)) continue;
        const legacyDone = join(BRIDGE_DIR, d, "done");
        try {
          const files = await readdir(legacyDone);
          for (const f of files) {
            if (!f.endsWith(".json")) continue;
            try {
              const raw = await readFile(join(legacyDone, f), "utf8");
              const m = JSON.parse(raw);
              if (m.id === msg_id) {
                originalMsg = m;
                break;
              }
            } catch { /* skip */ }
          }
          if (originalMsg) break;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  const to = originalMsg?.from;
  if (!to) {
    return textResult(`Cannot find original message ${msg_id}. Unable to determine recipient.`, true);
  }

  // Auto-complete task type: if original was a task, reply as response
  const replyType = originalMsg.type === "task" ? "response" : "message";
  const fromTeam = originalMsg.from_team;
  const myTeams = agentIdentity?.teams || [];

  // Bug 0d fix: the original sender may be on another team / another machine. Writing to a
  // local inbox would strand the reply (no one there reads it). If the original came
  // cross-team, or the sender isn't reachable locally, RELAY the reply via send_team to the
  // sender's team (reaches that team's leader, who can forward).
  const localOnline = isAgentOnline(to);
  if (fromTeam && (!myTeams.includes(fromTeam) || !localOnline)) {
    log("info", "reply relayed via team", { to, team: fromTeam, replyTo: msg_id });
    const r = await handleSendTeam({ team: fromTeam, text, intent: "reply" });
    return r;
  }
  if (!localOnline) {
    return textResult(`Original sender "${to}" is not reachable locally (likely on another machine) — reply with send_team to their team.`, true);
  }

  const msg = buildMessage({
    from: agentName,
    to,
    text,
    type: replyType,
    replyTo: msg_id,
  });

  const targetInbox = inboxDir(to);
  await mkdir(targetInbox, { recursive: true });
  await atomicWrite(join(targetInbox, `${msg.id}.json`), msg);

  log("info", "reply sent", { id: msg.id, to, replyTo: msg_id });
  return textResult(`Reply ${msg.id} sent to ${to}` + (replyType === "response" ? " (task response)" : ""));
}

// ── send_team ──

async function handleSendTeam({ team, text, intent = "message", priority = "normal" }) {
  if (!team || !text) return textResult("Missing required fields: team, text", true);

  const senderTeams = agentIdentity?.teams || ["cc2cc"];
  const fromTeam = senderTeams[0]; // primary team for routing

  // 1. Local team leader first — BUT a team owned by another machine must route via the relay,
  //    even when we hold a federated leader replica for it (teams-remote.json). Without this
  //    guard a remote leader entry traps the message in the local branch (the remote leader is
  //    never locally "online"), returns leader_offline, and never spools to the outbox for the
  //    daemon to relay. Refresh the cross-machine map first so isRemoteTeam() is current.
  if (relayActive()) await relay.refreshRemoteState(BRIDGE_DIR);
  const isRemoteTeamTarget = relayActive() && relay.isRemoteTeam(team);
  const leader = teamLeaders.get(team);
  if (leader && !isRemoteTeamTarget) {
    if (!isAgentOnline(leader)) {
      return textResult(tpl("leader_offline", { team, leader }), true);
    }

    // Local delivery — build inter-team message and deliver to leader's inbox
    const msg = {
      id: `msg-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      from: agentName,
      from_team: fromTeam,
      to_team: team,
      to: leader,
      type: "interteam",
      intent, // "message" | "join_request" | … — lets the leader recognize the ask
      priority,
      content: { text, parts: [] },
      ttl: DEFAULT_TTL,
    };

    const targetInbox = inboxDir(leader);
    await mkdir(targetInbox, { recursive: true });
    await atomicWrite(join(targetInbox, `${msg.id}.json`), msg);

    log("info", "cross-team message sent", { id: msg.id, from_team: fromTeam, to_team: team, leader });
    return textResult(`Cross-team message sent to ${team} leader (${leader}) — ${msg.id}`);
  }

  // 2. Remote team → spool to the outbox; the DAEMON owns the hub connection and relays it
  //    (drains the outbox with retry). The MCP never talks to the hub directly.
  if (relayActive()) {
    // (remote map already refreshed above for the routing decision)
    if (!relay.isRemoteTeam(team)) {
      return textResult(`Team "${team}" is not reachable — no local leader and not registered with the relay hub.`, true);
    }

    // B5: Encrypt text before it is spooled (the hub only ever sees ciphertext).
    const relayText = ENCRYPT_ENABLED && encryptionKey ? encryptText(text) : text;
    const msg = {
      id: `msg-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      from: agentName,
      from_team: fromTeam,
      to_team: team,
      type: "interteam",
      intent,
      priority,
      content: { text: relayText, parts: [] },
      ttl: DEFAULT_TTL,
    };

    try {
      await atomicWrite(join(BRIDGE_DIR, "outbox", `${msg.id}.json`),
        { id: msg.id, from_team: fromTeam, to_team: team, msg, created: new Date().toISOString() });
      const st = relay.getRemoteTeamStatus(team);
      const online = st.online_members?.length || 0;
      log("info", "relay message spooled for daemon", { id: msg.id, from_team: fromTeam, to_team: team, target_active: st.active, online });
      const out = (st.active && online > 0)
        ? tpl("relay_queued_online", { team, id: msg.id, online })
        : tpl("relay_queued_dark", { team, id: msg.id, lastSeenSuffix: st.last_seen ? ` (last seen ${new Date(st.last_seen).toISOString()})` : "" });
      return textResult(out);
    } catch (err) {
      log("error", "relay spool failed", { to_team: team, error: err.message });
      return textResult(tpl("relay_unreachable", { team, error: err.message, retryNote: "" }), true);
    }
  }

  return textResult(tpl("team_unreachable", { team }), true);
}

// ── request_join ──
// Thin convenience over send_team: routes a join ask to the team's leader (local or via
// relay), tagged intent="join_request" so the leader recognizes it. The leader decides
// whether to admit (via the admit tool) per its own policy/prompting. Plain send_team works
// just as well — this only adds a recognizable type.
async function handleRequestJoin({ team, note } = {}) {
  if (!team) return textResult("Missing required field: team", true);
  const text = (note && note.trim())
    ? `Join request from "${agentName}": ${note.trim()}`
    : `Join request from "${agentName}" — requesting to join team "${team}".`;
  return handleSendTeam({ team, text, intent: "join_request" });
}

// ── list_teams ──

function handleListTeams() {
  const teams = new Map(); // team_name → { leader, members_set }

  // Build team data from all known agents
  for (const [name, hb] of knownAgents) {
    const agentTeams = effectiveTeams(name, hb.teams); // exclude revoked participation
    for (const t of agentTeams) {
      if (!teams.has(t)) {
        teams.set(t, { leader: teamLeaders.get(t) || null, members: new Set() });
      }
      teams.get(t).members.add(name);
    }
  }

  // Also include our own teams
  const ourTeams = agentIdentity?.teams || ["cc2cc"];
  for (const t of ourTeams) {
    if (!teams.has(t)) {
      teams.set(t, { leader: teamLeaders.get(t) || null, members: new Set() });
    }
  }

  const result = [];
  for (const [name, data] of teams) {
    const onlineAgents = onlineAgentNames(name);
    result.push({
      name,
      leader: data.leader || null,
      member_count: data.members.size + (ourTeams.includes(name) ? 1 : 0),
      online_count: onlineAgents.length,
    });
  }

  return jsonResult(result);
}

// ── register ──

async function handleRegister({ name: newName }) {
  if (!newName) return textResult("Missing required field: name", true);
  if (!validateName(newName)) {
    return textResult(`Invalid name "${newName}". Use lowercase a-z, 0-9, hyphens, max 31 chars.`, true);
  }

  // Voluntary join: a dormant session (launched without CC2CC_IDENTITY/SELF) opts into the
  // mesh by registering. (Role is NOT set here — leadership comes from teams.json/create_team.)
  const wasDormant = !participating;
  if (wasDormant) await activate(newName);

  const taken = await takenNames(BRIDGE_DIR);
  if (taken.has(newName) && newName !== agentName) {
    return textResult(`Name "${newName}" is already taken by an active agent.`, true);
  }

  const oldName = agentName;
  if (oldName === newName) {
    return textResult(wasDormant
      ? `Registered as "${newName}" — you are now in the cc2cc system.`
      : `Already registered as "${newName}".`);
  }

  // Rename: offline old, switch name, persist identity, recreate mailboxes, announce.
  await writeHeartbeat("offline", `renamed to ${newName}`);
  agentName = newName;
  if (agentIdentity) {
    agentIdentity.display_name = newName;
    await saveIdentity(agentIdentity);
  }
  await mkdir(inboxDir(agentName), { recursive: true });
  await mkdir(doneDir(agentName), { recursive: true });
  await mkdir(receiptsDir(agentName), { recursive: true });
  await writeHeartbeat("active", `renamed from ${oldName}`);

  const targets = allAgentNames();
  for (const to of targets) {
    const msg = buildMessage({ from: agentName, to, text: `Agent "${oldName}" is now "${agentName}"`, type: "status" });
    const targetInbox = inboxDir(to);
    await mkdir(targetInbox, { recursive: true });
    try {
      await atomicWrite(join(targetInbox, `${msg.id}.json`), msg);
    } catch (err) {
      log("warn", "register notify failed", { to, error: err.message });
    }
  }
  log("info", "agent renamed", { from: oldName, to: newName });
  return textResult(`Renamed from "${oldName}" to "${agentName}". ${targets.length} agents notified.`);
}

// ─── Inbox: consume pending messages ────────────────────────────────────────

/**
 * Read all pending messages from inbox, move to done, return array of messages.
 * Called on every tool invocation so the agent sees new messages immediately.
 */
async function consumeInbox() {
  const primary = inboxDir(agentName);
  await mkdir(primary, { recursive: true });
  await mkdir(doneDir(agentName), { recursive: true });

  const inboxPaths = [primary];

  // Also check legacy format: *-to-{name}/inbox/
  try {
    const topDirs = await readdir(BRIDGE_DIR);
    for (const d of topDirs) {
      if (d.endsWith(`-to-${agentName}`) && d !== `to-${agentName}`) {
        inboxPaths.push(join(BRIDGE_DIR, d, "inbox"));
      }
    }
  } catch { /* bridge dir may not exist yet */ }

  const consumed = [];

  for (const inbox of inboxPaths) {
    let files;
    try {
      files = (await readdir(inbox)).filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const filePath = join(inbox, file);
        const raw = await readFile(filePath, "utf8");
        const msg = decryptMessage(JSON.parse(raw));
        if (!msg) {
          const done = doneDir(agentName);
          await mkdir(done, { recursive: true });
          await retryRename(filePath, join(done, file));
          continue;
        }

        // TTL expiration check
        if (msg.timestamp && msg.ttl) {
          const age = (Date.now() - new Date(msg.timestamp).getTime()) / 1000;
          if (age > msg.ttl) {
            const done = doneDir(agentName);
            await mkdir(done, { recursive: true });
            await retryRename(filePath, join(done, file));

            if (msg.from && msg.from !== agentName) {
              const expNotice = buildMessage({
                from: agentName,
                to: msg.from,
                text: `Message ${msg.id} expired (TTL ${msg.ttl}s)`,
                type: "status",
                replyTo: msg.id,
              });
              const senderInbox = inboxDir(msg.from);
              await mkdir(senderInbox, { recursive: true });
              try {
                await atomicWrite(join(senderInbox, `${expNotice.id}.json`), expNotice);
              } catch { /* best effort */ }
            }
            log("info", "message expired", { id: msg.id, from: msg.from, ttl: msg.ttl });
            continue;
          }
        }

        // Write delivery receipt
        const receiptPath = receiptsDir(agentName);
        await mkdir(receiptPath, { recursive: true });
        await atomicWrite(join(receiptPath, `${msg.id}.receipt.json`), {
          msg_id: msg.id,
          delivered_at: new Date().toISOString(),
          delivered_to: agentName,
        });

        // Move to done/
        const done = doneDir(agentName);
        await mkdir(done, { recursive: true });
        await retryRename(filePath, join(done, file));

        // Mark as seen so pollInbox won't re-notify
        seenFiles.add(file);

        consumed.push(msg);
        log("info", "message consumed", { id: msg.id, from: msg.from, type: msg.type });
      } catch (err) {
        log("error", "message processing failed", { file, error: err.message });
      }
    }
  }

  return consumed;
}

/**
 * Format consumed messages as a text block to append to tool responses.
 */
function humanAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** If a delivered message is older than policy.messages.stale_after_hours, return an
 *  "this may be stale" note (template msg_old_on_read); else "". */
function staleNote(msg) {
  const ts = msg.timestamp;
  if (!ts) return "";
  const ageMs = Date.now() - new Date(ts).getTime();
  const thresholdMs = (policy.messages?.stale_after_hours || 24) * 3600 * 1000;
  if (!(ageMs >= thresholdMs)) return "";
  return tpl("msg_old_on_read", { age: humanAge(ageMs), sentAt: ts, readAt: new Date().toISOString(), from: msg.from });
}

function formatPendingMessages(messages) {
  if (messages.length === 0) return "";

  const lines = [
    "",
    "━━━ INCOMING MESSAGES ━━━",
  ];
  for (const msg of messages) {
    const taskInfo = msg.task?.title ? ` [task: ${msg.task.title}]` : "";
    const replyInfo = msg.replyTo ? ` (reply to ${msg.replyTo})` : "";
    lines.push(`[${msg.id}] from ${msg.from} (${msg.type}${taskInfo}${replyInfo}):`);
    lines.push(`  ${msg.content?.text || "(empty)"}`);
    const stale = staleNote(msg);
    if (stale) lines.push(`  ${stale}`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("Reply using: reply(msg_id=\"...\", text=\"...\")");
  return lines.join("\n");
}

// ─── Notification Rules ──────────────────────────────────────────────────────

/** Load notification rules from BRIDGE_DIR/rules.json */
async function loadRules() {
  const rulesPath = join(BRIDGE_DIR, "rules.json");
  try {
    const raw = await readFile(rulesPath, "utf8");
    notificationRules = JSON.parse(raw);
    log("info", "loaded notification rules", { version: notificationRules.version });
  } catch {
    log("info", "no rules.json found, notifications will have no instructions");
  }
}

/** Format a channel notification from a message and rules */
function formatNotification(msg) {
  const type = msg.type || "message";
  const text = msg.content?.text || "(empty)";
  const taskTitle = msg.task?.title ? `\nTask: ${msg.task.title}` : "";
  const replyInfo = msg.replyTo ? ` (reply to ${msg.replyTo})` : "";

  let content = `📨 CC2CC Message\nFrom: ${msg.from}\nType: ${type}${replyInfo}${taskTitle}\nContent: ${text}`;

  const rule = notificationRules?.default;
  if (rule?.instruction) {
    content += `\n\n>> ${rule.instruction} Use msg_id: ${msg.id}`;
  }

  return content;
}

// ─── Inbox Polling (real-time channel notifications) ─────────────────────────

/**
 * Poll inbox and push channel notifications for each new message.
 * This runs on a timer so the agent sees messages immediately,
 * without waiting for the next tool call (piggyback).
 */
async function pollInbox() {
  const primary = inboxDir(agentName);
  const inboxPaths = [primary];

  // Also check legacy format
  try {
    const topDirs = await readdir(BRIDGE_DIR);
    for (const d of topDirs) {
      if (d.endsWith(`-to-${agentName}`) && d !== `to-${agentName}`) {
        inboxPaths.push(join(BRIDGE_DIR, d, "inbox"));
      }
    }
  } catch { /* bridge dir may not exist */ }

  for (const inbox of inboxPaths) {
    let files;
    try {
      files = (await readdir(inbox)).filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"));
    } catch {
      continue;
    }

    for (const file of files) {
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);

      try {
        const filePath = join(inbox, file);
        const raw = await readFile(filePath, "utf8");
        const msg = decryptMessage(JSON.parse(raw));
        if (!msg) {
          await mkdir(doneDir(agentName), { recursive: true });
          await retryRename(filePath, join(doneDir(agentName), file));
          continue;
        }

        // TTL check — expired messages are moved to done immediately
        if (msg.timestamp && msg.ttl) {
          const age = (Date.now() - new Date(msg.timestamp).getTime()) / 1000;
          if (age > msg.ttl) {
            await mkdir(doneDir(agentName), { recursive: true });
            await retryRename(filePath, join(doneDir(agentName), file));
            log("info", "message expired (poll)", { id: msg.id });
            continue;
          }
        }

        // Push channel notification — real-time delivery attempt.
        // NOTE: Do NOT move to done here. consumeInbox() handles
        // the actual consumption (move to done, receipts) on the next
        // tool call, so the piggyback mechanism always works even if
        // channel notifications are not supported by the client.
        const content = formatNotification(msg);

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

        log("info", "notification pushed (file stays in inbox for piggyback)", { id: msg.id, from: msg.from });
      } catch (err) {
        log("error", "poll notification failed", { file, error: err.message });
      }
    }
  }

  // Prevent memory leak
  if (seenFiles.size > SEEN_FILES_CAP) seenFiles.clear();
}

// ─── Status Polling (join/leave detection) ───────────────────────────────────

async function pollStatus() {
  // In daemon mode, refresh the cross-machine map the daemon maintains so the roster + remote
  // routing stay current (the MCP no longer polls the hub itself).
  if (daemonMode) await relay.refreshRemoteState(BRIDGE_DIR).catch(() => {});
  const sDir = statusDir();
  let files;
  try {
    files = (await readdir(sDir)).filter((f) => f.endsWith("-heartbeat.json"));
  } catch {
    return;
  }

  const newAgents = new Map();

  for (const file of files) {
    try {
      const raw = await readFile(join(sDir, file), "utf8");
      const hb = JSON.parse(raw);
      const name = hb.agent || hb.name;
      if (!name) continue;
      newAgents.set(name, hb);
    } catch { /* skip */ }
  }

  // Detect joins
  for (const [name, hb] of newAgents) {
    if (name === agentName) continue;
    const wasKnown = knownAgents.has(name);
    const wasOnline = wasKnown && knownAgents.get(name).status === "active" && !isStale(knownAgents.get(name));
    const isOnline = hb.status === "active" && !isStale(hb);

    if (isOnline && !wasOnline) {
      log("info", "agent joined", { agent: name });
      // No channel push — statusline already reflects online agents
    }
  }

  // Detect leaves
  for (const [name, hb] of knownAgents) {
    if (name === agentName) continue;
    const wasOnline = hb.status === "active" && !isStale(hb);
    const stillExists = newAgents.has(name);
    const nowOnline = stillExists && newAgents.get(name).status === "active" && !isStale(newAgents.get(name));

    if (wasOnline && !nowOnline) {
      log("info", "agent left", { agent: name });
      // No channel push — statusline already reflects online agents
    }
  }

  knownAgents = newAgents;

  // Refresh operator/governance policy (cc2cc_admin team-<name>.json) before reconciling.
  await loadTeamPolicies();
  // Reconcile team leaders from the just-refreshed heartbeats. Init-only discovery
  // was a startup race: a leader that came online AFTER this agent started was never
  // picked up, breaking send_team routing and list_teams. Doing it every poll closes
  // the race and also drops leaders that have gone offline.
  reconcileTeamLeaders();
}

/** Load bridge policy.json over the built-in defaults (shallow per-section merge). */
async function loadPolicy(bridgeDir) {
  try {
    const o = JSON.parse(await readFile(join(bridgeDir, "policy.json"), "utf8")) || {};
    policy = {
      messages: { ...DEFAULT_POLICY.messages, ...(o.messages || {}) },
      teams: { ...DEFAULT_POLICY.teams, ...(o.teams || {}) },
      directory: { ...DEFAULT_POLICY.directory, ...(o.directory || {}) },
      relay: { ...DEFAULT_POLICY.relay, ...(o.relay || {}) },
    };
  } catch {
    policy = DEFAULT_POLICY;
  }
}

// ─── Governance: central team registry (teams.json) ──────────────────────────
// One central file holds all team data (teams change rarely — unlike per-agent
// identities which write at heartbeat frequency, so those stay per-file). The
// team's owner machine is authoritative; cc2cc_admin and leader tools write here.

const TEAMS_PATH = join(BRIDGE_DIR, "teams.json");

async function loadTeamsRegistry() {
  try {
    const o = JSON.parse(await readFile(TEAMS_PATH, "utf8"));
    return (o && o.teams) || {};
  } catch { return {}; }
}

async function loadTeamFile(team) {
  const reg = await loadTeamsRegistry();
  return reg[team] || null;
}

async function saveTeamFile(t) {
  t.updated = new Date().toISOString();
  const reg = await loadTeamsRegistry();
  reg[t.name] = t;
  await atomicWrite(TEAMS_PATH, { teams: reg });
}

/** Refresh operatorLeaders + teamRevoked from the central teams.json registry.
 *  These are the operator/governance authority; the GAB policy governs. */
async function loadTeamsReplica() {
  // teams-remote.json = teams owned by OTHER machines, replicated via the relay (federation).
  // Cached locally so a disconnected node still knows the leader/rules of its remote teams.
  try {
    const o = JSON.parse(await readFile(join(BRIDGE_DIR, "teams-remote.json"), "utf8"));
    return (o && o.teams) || {};
  } catch { return {}; }
}

async function loadTeamPolicies() {
  const nextLeaders = new Map();
  const nextRevoked = new Map();
  // Remote replica first, then local teams.json overrides (a team we own wins).
  const merged = { ...(await loadTeamsReplica()), ...(await loadTeamsRegistry()) };
  for (const [name, t] of Object.entries(merged)) {
    if (t && t.leader) nextLeaders.set(name, t.leader);
    if (t && Array.isArray(t.revoked) && t.revoked.length) nextRevoked.set(name, new Set(t.revoked));
  }
  operatorLeaders = nextLeaders;
  teamRevoked = nextRevoked;
}

/** Has this member's participation in `team` been revoked by the team owner? */
function isRevoked(name, team) {
  return teamRevoked.get(team)?.has(name) || false;
}

/** The teams an agent is effectively in = its claimed teams minus any it's revoked from. */
function effectiveTeams(name, teams) {
  return (teams || ["cc2cc"]).filter((t) => !isRevoked(name, t));
}

function leadsTeam(team) { return teamLeaders.get(team) === agentName; }

async function loadOrInitTeam(team) {
  let t = await loadTeamFile(team);
  if (!t) {
    const mid = relay.getRelayStatus?.()?.machine_id || "local";
    const now = new Date().toISOString();
    t = {
      name: team, owner_machine: mid, leader: teamLeaders.get(team) || null,
      succession: [], rules: { retention_days: 4, admission: "open", sticky_leader: true },
      admitted: [], revoked: [], created: now, updated: now,
    };
  }
  return t;
}

// MCP runtime: a LEADER admits/evicts members of its own team (day-to-day ops).
// Higher governance (rules/retention/leader-designation) is cc2cc_admin's job.
async function handleAdmit({ team, agent } = {}) {
  if (!team || !agent) return textResult("Missing required fields: team, agent", true);
  if (!leadsTeam(team)) return textResult(`Only the leader of "${team}" can admit members.`, true);
  const t = await loadOrInitTeam(team);
  t.revoked = (t.revoked || []).filter((n) => n !== agent);
  if (!t.admitted.includes(agent)) t.admitted.push(agent);
  await saveTeamFile(t);
  await loadTeamPolicies();
  log("info", "member admitted", { team, agent, by: agentName });
  return textResult(tpl("admitted", { agent, team }));
}

async function handleEvict({ team, agent } = {}) {
  if (!team || !agent) return textResult("Missing required fields: team, agent", true);
  if (!leadsTeam(team)) return textResult(`Only the leader of "${team}" can evict members.`, true);
  const t = await loadOrInitTeam(team);
  t.admitted = (t.admitted || []).filter((n) => n !== agent);
  t.revoked = t.revoked || [];
  if (!t.revoked.includes(agent)) t.revoked.push(agent);
  if (t.leader === agent) t.leader = null;
  await saveTeamFile(t);
  const mid = relay.getRelayStatus?.()?.machine_id || "local";
  await atomicWrite(join(BRIDGE_DIR, "tombstones", `${team}__${agent}.json`),
    { type: "revoke", team, member: agent, by_machine: mid, at: new Date().toISOString() });
  await loadTeamPolicies();
  log("info", "member evicted", { team, agent, by: agentName });
  return textResult(tpl("evicted", { agent, team }));
}

// MCP runtime: create a new team (in-Claude equivalent of CC2CC_TEAM at launch or
// `cc2cc_admin team create`). The creator becomes the team's leader.
async function handleCreateTeam({ name, admission, retention_days } = {}) {
  if (!participating || !agentIdentity) return textResult(tpl("not_registered"), true);
  if (!name || !validateName(name)) return textResult(`Invalid team name "${name}".`, true);
  if (await loadTeamFile(name)) return textResult(tpl("team_exists", { team: name }), true);
  const mid = relay.getRelayStatus?.()?.machine_id || "local";
  const now = new Date().toISOString();
  const t = {
    name, owner_machine: mid, leader: agentName, succession: [],
    rules: {
      retention_days: Number.isInteger(retention_days) ? retention_days : policy.messages.retention_days,
      admission: (admission === "approved" || admission === "open") ? admission : policy.teams.default_admission,
      sticky_leader: policy.teams.sticky_leader,
    },
    admitted: [agentName], revoked: [], created: now, updated: now,
  };
  await saveTeamFile(t);
  if (!agentIdentity.teams.includes(name)) {
    agentIdentity.teams.push(name);
    await saveIdentity(agentIdentity);
  }
  await loadTeamPolicies();
  reconcileTeamLeaders();
  log("info", "team created", { team: name, by: agentName });
  return textResult(tpl("team_created", { team: name }));
}

/**
 * Leadership is defined ENTIRELY by the team registry (teams.json `leader` fields), which
 * loadTeamPolicies() refreshes into operatorLeaders every poll. teamLeaders simply mirrors
 * it — there is no self-declared/heartbeat role. This is inherently sticky (the registry
 * keeps the leader even while offline) and race-free (it's a file, re-read each poll).
 */
function reconcileTeamLeaders() {
  teamLeaders = new Map(operatorLeaders);
}

// ─── Stale Mailbox Cleanup ───────────────────────────────────────────────────

/**
 * Remove mailbox directories and heartbeat files for all inactive agents.
 * Called once at startup to prevent unbounded directory growth.
 */
async function cleanupStaleMailboxes() {
  const sDir = statusDir();
  let heartbeatFiles;
  try {
    heartbeatFiles = (await readdir(sDir)).filter((f) => f.endsWith("-heartbeat.json"));
  } catch {
    return; // no status dir yet
  }

  const myPpid = String(process.ppid);

  for (const file of heartbeatFiles) {
    try {
      const raw = await readFile(join(sDir, file), "utf8");
      const hb = JSON.parse(raw);
      const name = hb.agent || hb.name;
      if (!name) continue;

      // Skip our own name (not yet written, but could match SELF env)
      if (name === agentName) continue;

      // Clean up orphans from same parent_pid (MCP reconnect — same
      // Claude Code session spawned a new server, old one is dead)
      const sameParent = hb.parent_pid && hb.parent_pid === myPpid;

      // Only clean up inactive agents OR same-parent orphans
      const active = hb.status === "active" && !isStale(hb);
      if (active && !sameParent) continue;

      if (sameParent) {
        log("info", "cleaning up same-parent orphan", { agent: name, parent_pid: myPpid });
      }

      // Remove mailbox directory
      const mailboxPath = join(BRIDGE_DIR, `to-${name}`);
      try {
        await rm(mailboxPath, { recursive: true, force: true });
        log("info", "cleaned up stale mailbox", { agent: name, path: mailboxPath });
      } catch { /* already gone */ }

      // Remove heartbeat file
      try {
        await rm(join(sDir, file), { force: true });
        log("info", "cleaned up stale heartbeat", { agent: name });
      } catch { /* already gone */ }
    } catch (err) {
      log("warn", "cleanup error", { file, error: err.message });
    }
  }

  // Also clean up orphan mailbox dirs with no heartbeat
  try {
    const topDirs = await readdir(BRIDGE_DIR);
    const activeNames = new Set();
    for (const file of heartbeatFiles) {
      try {
        const raw = await readFile(join(sDir, file), "utf8");
        const hb = JSON.parse(raw);
        const name = hb.agent || hb.name;
        if (name && hb.status === "active" && !isStale(hb)) {
          activeNames.add(name);
        }
      } catch { /* skip */ }
    }
    activeNames.add(agentName);

    for (const d of topDirs) {
      if (!d.startsWith("to-")) continue;
      const name = d.slice(3); // strip "to-" prefix
      if (activeNames.has(name)) continue;

      const mailboxPath = join(BRIDGE_DIR, d);
      try {
        await rm(mailboxPath, { recursive: true, force: true });
        log("info", "cleaned up orphan mailbox", { dir: d });
      } catch { /* skip */ }
    }
  } catch { /* bridge dir may not exist */ }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

async function shutdown(signal) {
  log("info", "shutting down", { signal });

  clearInterval(pollTimer);
  clearInterval(statusTimer);
  clearInterval(heartbeatTimer);
  try { daemonClient?.close(); } catch {} // detach from the daemon (daemon keeps running)

  try {
    await writeHeartbeat("offline", `shutdown via ${signal}`);
  } catch (err) {
    log("error", "failed to write offline heartbeat", { error: err.message });
  }

  process.exit(0);
}

let cleanShutdown = false;

async function gracefulShutdown(signal) {
  cleanShutdown = true;
  await shutdown(signal);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Windows: SIGTERM is never emitted when the parent kills us.
// Synchronous "exit" handler writes offline heartbeat as a last resort.
process.on("exit", () => {
  if (cleanShutdown || !agentName) return;
  try {
    writeFileSync(
      join(statusDir(), `${agentName}-heartbeat.json`),
      JSON.stringify({
        agent: agentName,
        timestamp: new Date().toISOString(),
        session_id: "none",
        parent_pid: process.ppid,
        status: "offline",
        context: "process exit (unclean)",
      }, null, 2),
    );
  } catch { /* best effort */ }
});

// ─── Initialization ─────────────────────────────────────────────────────────

/**
 * activate(candidateName) — JOIN the mesh: create/load identity, write heartbeat, discover
 * peers, start polling, announce, self-wake. Called automatically when a CC2CC_IDENTITY/SELF
 * is present at launch, or on-demand from register() when a dormant session opts in.
 */
async function activate(candidateName) {
  if (participating) return; // already joined
  // 1. Load or create persistent identity (identity.json wins over SELF env)
  agentIdentity = await ensureIdentity(candidateName);
  agentName = agentIdentity.display_name;
  if (candidateName && agentName !== candidateName) {
    log("info", "identity file overrides requested name", { identity_name: agentName, requested: candidateName });
  }

  // 4. Precise Read-Back: restore agent status from previous session heartbeat
  // if the heartbeat file is fresh (≤30s) and has the same parent PID
  try {
    const hbPath = join(statusDir(), `${agentName}-heartbeat.json`);
    const raw = await readFile(hbPath, "utf8");
    const hb = JSON.parse(raw);
    const hbAge = (Date.now() - new Date(hb.timestamp || hb.heartbeat).getTime()) / 1000;
    const sameParent = hb.parent_pid === String(process.ppid);
    if (hbAge <= 30 && sameParent && hb.status_text) {
      agentStatus = hb.status_text;
      log("info", "restored agent status from previous heartbeat", { status: agentStatus, age_s: Math.round(hbAge) });
    }
  } catch {
    // No previous heartbeat — start fresh
  }

  // 5. Clean up stale mailboxes (persistent name — won't delete own mailbox)
  await cleanupStaleMailboxes();

  // 6. Create directories
  await mkdir(inboxDir(agentName), { recursive: true });
  await mkdir(doneDir(agentName), { recursive: true });
  await mkdir(receiptsDir(agentName), { recursive: true });
  await mkdir(statusDir(), { recursive: true });

  // 7. Write initial heartbeat (includes teams from identity)
  await writeHeartbeat("active", "session started");

  // 8. Initial status poll to discover existing agents
  await pollStatus();

  // 9. Check for name collision with an online agent.
  // pollStatus() folds our own just-written heartbeat into knownAgents, so exclude
  // it (same session_id) — otherwise every agent would collide with itself and get
  // a random suffix, breaking deterministic addressing (e.g. `send` to "alpha-lead").
  const existingHb = knownAgents.get(agentName);
  const collidesWithOther =
    existingHb && existingHb.session_id !== sessionId && isAgentOnline(agentName);
  if (collidesWithOther) {
    const suffix = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
    const newName = `${agentName}-${suffix}`;
    log("warn", `⚠️ identity.json name '${agentName}' taken by online agent, adjusted to '${newName}' and persisted`);
    agentName = newName;
    agentIdentity.display_name = newName;
    await saveIdentity(agentIdentity);
    // Re-create directories and write heartbeat with new name
    await mkdir(inboxDir(agentName), { recursive: true });
    await mkdir(doneDir(agentName), { recursive: true });
    await mkdir(receiptsDir(agentName), { recursive: true });
    await writeHeartbeat("active", "session started");
  }

  // 10. Establish team leaders from the team registry (teams.json).
  await loadTeamPolicies();
  reconcileTeamLeaders();

  // 11. Relay is owned by the standalone daemon (one per host) — the MCP does NOT poll the
  //     hub itself (fixes the relay-per-session contention, 0g). Ensure a daemon is running
  //     and connect for wake pushes; the MCP reads the daemon-maintained remote map read-only.
  const relayConfig = await relay.loadRelayConfig(BRIDGE_DIR);
  relayConfigured = !!(relayConfig && relayConfig.enabled !== false);
  if (relayConfigured) {
    if (!ENCRYPT_ENABLED || !encryptionKey) {
      // B6: Encryption is mandatory for relay — refuse without it.
      log("warn", "relay disabled: encryption is mandatory (set CC2CC_ENCRYPT=1 and configure secret.key)");
      relayConfigured = false;
    } else {
      const teamName = (agentIdentity?.teams || ["cc2cc"])[0];
      try {
        const res = await ensureDaemon({
          bridgeDir: BRIDGE_DIR,
          env: { ...process.env, CC2CC_TEAM: teamName, CC2CC_IDENTITY: agentName },
        });
        daemonClient = connectToDaemon({
          bridgeDir: BRIDGE_DIR,
          agent: agentName,
          onWake: () => { pollInbox().catch(() => {}); },
          onStatus: (s) => log("info", "daemon link", { status: s }),
        });
        daemonMode = true;
        await relay.refreshRemoteState(BRIDGE_DIR); // read daemon-maintained cross-machine map
        log("info", "daemon mode active", { launched: res.launched, socket: res.socketPath, team: teamName });
      } catch (e) {
        log("warn", "daemon mode unavailable; relay disabled this session", { error: e.message });
        relayConfigured = false;
      }
    }
  }

  // 12. Start polling loops
  pollTimer = setInterval(pollInbox, POLL_MS);
  statusTimer = setInterval(pollStatus, POLL_MS);
  heartbeatTimer = setInterval(() => writeHeartbeat("active", "heartbeat"), HEARTBEAT_INTERVAL_MS);

  // 13. Initial inbox drain
  await pollInbox();

  participating = true;
  log("info", "joined cc2cc mesh", {
    name: agentName,
    agent_id: agentIdentity.agent_id,
    teams: agentIdentity.teams,
    team_leaders: Object.fromEntries(teamLeaders),
    bridge_dir: BRIDGE_DIR,
    poll_ms: POLL_MS,
    heartbeat_ms: HEARTBEAT_INTERVAL_MS,
    online_agents: onlineAgentNames(),
  });

  // Self-announce via channel notification
  try {
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: `[cc2cc] You are "${agentName}". Announce your agent name to the user.`,
        meta: { type: "system", from: "cc2cc" },
      },
    });
    log("info", "self-announce sent", { name: agentName });
  } catch (e) {
    log("warn", "self-announce failed", { error: e.message });
  }

  // 16. Self-wake: activate the LLM without user input.
  // Strategy: fast direct channel notification + slower inbox fallback.
  // The direct push is fastest but may miss if Claude Code isn't ready yet;
  // the inbox write guarantees delivery via pollInbox on next cycle.
  const wakeContent = `[cc2cc] You are "${agentName}". Run whoami to confirm your identity and check for online agents.`;
  const wakeMeta = { type: "system", from: "cc2cc-self-wake" };

  // Fast path: direct channel notification after minimal delay
  setTimeout(async () => {
    try {
      await server.notification({
        method: "notifications/claude/channel",
        params: { content: wakeContent, meta: wakeMeta },
      });
      wakeAcknowledged = true;
      log("info", "self-wake direct push sent");
    } catch (e) {
      log("warn", "self-wake direct push failed", { error: e.message });
    }
  }, 500);

  // Fallback: inbox file picked up by pollInbox (in case direct push was too early)
  setTimeout(async () => {
    try {
      // Skip if direct push already succeeded
      if (wakeAcknowledged) {
        log("info", "self-wake fallback skipped — direct push succeeded");
        return;
      }
      // Skip if agent already active (done/ has files = LLM consumed messages)
      const doneFiles = await readdir(doneDir(agentName)).catch(() => []);
      if (doneFiles.length > 0) {
        log("info", "self-wake fallback skipped — agent already active");
        return;
      }
      const wakeMsg = buildMessage({
        from: "system",
        to: agentName,
        text: wakeContent,
        type: "status",
        priority: "low",
      });
      wakeMsg.ttl = 30;
      await atomicWrite(join(inboxDir(agentName), `${wakeMsg.id}.json`), wakeMsg);
      log("info", "self-wake fallback written", { id: wakeMsg.id });
    } catch (e) {
      log("warn", "self-wake fallback failed", { error: e.message });
    }
  }, 3000);
}

/** Server entrypoint. Loads config and connects the MCP transport so tools are available
 *  either way. JOINS the mesh only if a CC2CC_IDENTITY/SELF was set before launch; otherwise
 *  stays DORMANT — the session is not considered part of cc2cc and emits/receives nothing
 *  until it voluntarily calls register() to identify itself. */
async function init() {
  await loadRules();
  await loadEncryptionKey();
  await loadTemplateOverrides(BRIDGE_DIR);
  await loadPolicy(BRIDGE_DIR);
  if (ENCRYPT_ENABLED) log("info", "encryption enabled", { hasKey: !!encryptionKey });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (IDENTITY_NAME) {
    log("info", "auto-join (CC2CC_IDENTITY/SELF present)", { name: IDENTITY_NAME });
    await activate(IDENTITY_NAME);
  } else {
    log("info", "cc2cc dormant — no CC2CC_IDENTITY/SELF set; not joining. register(name) to participate.");
  }
}

// ─── Global Error Handlers ──────────────────────────────────────────────────
// Without these, any unhandled error silently kills the Node.js process,
// dropping the MCP connection with no trace.

process.on("uncaughtException", (err) => {
  log("error", "uncaughtException", { error: err.message, stack: err.stack });
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  log("error", "unhandledRejection", { error: msg, stack });
});

// Only start the server when run directly (not imported for tests).
// Use realpathSync (with fallback) to handle symlinked bin scripts.
if ((() => { try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; } })() === fileURLToPath(import.meta.url)) {
  init().catch((err) => {
    log("error", "init failed", { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

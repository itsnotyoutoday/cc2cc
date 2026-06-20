/**
 * CC2CC Relay Client Module
 *
 * Cross-machine message relay. Talks to a relay_hub.py (FastAPI) service.
 *
 * Encryption is mandatory for relay — server.mjs enforces CC2CC_ENCRYPT=1
 * before starting this client.
 */

import { readFile, mkdir, writeFile, readdir, rm } from "fs/promises";
import { join, basename } from "path";
import { randomUUID } from "crypto";

// ─── State ───────────────────────────────────────────────────────────────────

let config = null;            // relay.json contents
let remoteTeams = new Map();   // team → { machine_id, agents: {name: {status_text}}, polled_at }
let relayEnabled = false;
let pollTimer = null;
let registerInterval = null;
let heartbeatInterval = null;
let bridgeDir = null;
let localAgentName = null;    // B3: our own agent name (for self-team inbound routing)

// Encryption — set by server.mjs before client starts
let _encryptFn = null;          // text ⇒ encrypted_text

// ─── H2: Redelivery Dedup ────────────────────────────────────────────────────

const seenMessageIds = new Set();
const MAX_SEEN_IDS = 10000;

function hasSeenMessage(msgIdentity) {
  if (seenMessageIds.has(msgIdentity)) return true;
  seenMessageIds.add(msgIdentity);
  if (seenMessageIds.size > MAX_SEEN_IDS) {
    // Evict oldest entries (Set iteration order is insertion order)
    const toDelete = [...seenMessageIds].slice(0, seenMessageIds.size - MAX_SEEN_IDS);
    for (const id of toDelete) seenMessageIds.delete(id);
  }
  return false;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const REGISTER_INTERVAL_MS = 15000;
const POLL_MS = 3000;
const KEEPALIVE_INTERVAL_MS = 5000;
const RELAY_CONFIG_FILE = "relay.json";
const REMOTE_STATE_FILE = "remote-teams.json"; // local DB persisting the cross-machine map
// Two-tier retention: a remote team is ACTIVE if seen within ACTIVE_MS, otherwise KNOWN
// (kept, shown offline) until EXPIRE_MS of total silence, then purged from the local DB.
// Env-overridable (ms) so this is testable with short windows.
const REMOTE_ACTIVE_MS = Number(process.env.CC2CC_REMOTE_ACTIVE_MS) || 60000;        // 60s
const REMOTE_EXPIRE_MS = Number(process.env.CC2CC_REMOTE_EXPIRE_MS) || 4 * 24 * 3600 * 1000; // ~4 days
const HEARTBEAT_STALE_S = 15; // v3.6: max age for agent roster entries

// ─── Config ──────────────────────────────────────────────────────────────────

const CONNECTIONS_FILE = "connections.json";

export async function loadRelayConfig(bridgeDir) {
  // Prefer connections.json (self identity + connection registry); fall back to relay.json.
  // self.id = this instance's UUID (distinct from host → many daemons per machine);
  // self.name = human label. Active hub = the first enabled "server" connection.
  try {
    const conns = JSON.parse(await readFile(join(bridgeDir, CONNECTIONS_FILE), "utf8"));
    const self = conns.self || {};
    const server = (conns.connections || []).find((c) => c.type === "server" && c.enabled !== false);
    config = {
      machine_id: self.id || randomUUID(),
      name: self.name || self.id || "node",
      self_type: self.type || "client",
      connections: conns.connections || [],
      hub_url: server ? `http://${server.address}:${server.port}`.replace(/\/$/, "") : null,
      token: server ? server.token : null,
      hub_id: server ? server.id : null,
      // a node with no outbound server connection (a pure server) has nothing to poll
      enabled: server ? (conns.enabled !== false) : false,
    };
    return config;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  // Legacy single-hub relay.json
  const path = join(bridgeDir, RELAY_CONFIG_FILE);
  try {
    const raw = await readFile(path, "utf8");
    config = JSON.parse(raw);
    if (!config.machine_id) config.machine_id = randomUUID();
    if (!config.name) config.name = config.machine_id;
    return config;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function saveRelayConfig(bridgeDir, cfg) {
  const path = join(bridgeDir, RELAY_CONFIG_FILE);
  if (!cfg.machine_id) {
    cfg.machine_id = `machine-${randomUUID().slice(0, 8)}`;
  }
  await writeFile(path, JSON.stringify(cfg, null, 2), "utf8");
  config = cfg;
}

export function isRelayEnabled() {
  return relayEnabled && config && config.enabled !== false;
}

export function setEncryptionFunction(fn) {
  _encryptFn = fn;
}
/** Read back the stored encryption function (for test verification). */
export function getEncryptionFunction() {
  return _encryptFn;
}

export function getConfigToken() {
  return config?.token || null;
}

// ─── Register Tool Handler ───────────────────────────────────────────────────

export async function handleRegisterRelay(bridgeDir, args) {
  const { hub_url, token, enabled } = args;

  if (!hub_url) return { content: [{ type: "text", text: "Missing required field: hub_url" }], isError: true };

  const cfg = {
    hub_url: hub_url.replace(/\/$/, ""),
    machine_id: config?.machine_id || `machine-${randomUUID().slice(0, 8)}`,
    token: token || config?.token || "",
    enabled: enabled !== false,
    poll_interval_ms: POLL_MS,
  };

  if (cfg.enabled) {
    try {
      const res = await fetch(`${cfg.hub_url}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // NOTE: agent roster is intentionally NOT sent here (registers with empty
        // agents on the Hub). Cross-machine agent-level visibility is STUBBED until
        // v3.6 §3 link #1, which will read local agents from the status dir and fold
        // them into the keepalive payload. See SPEC-v3.6-ADDENDUM-STATUS.md §3.
        body: JSON.stringify({
          token: cfg.token,
          machine_id: cfg.machine_id,
          team: args.team || "cc2cc",
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text", text: `Hub registration failed: ${res.status} ${err}` }], isError: true };
      }
    } catch (err) {
      return { content: [{ type: "text", text: `Cannot reach Hub at ${cfg.hub_url}: ${err.message}` }], isError: true };
    }
  }

  await saveRelayConfig(bridgeDir, cfg);
  return { content: [{ type: "text", text: `Relay configured: ${cfg.hub_url} (machine: ${cfg.machine_id}, enabled: ${cfg.enabled})` }] };
}

// ─── Hub API Calls ───────────────────────────────────────────────────────────

async function apiPost(url, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hub ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.json();
}

export async function relayRegister(hubUrl, token, machineId, teamName) {
  return await apiPost(`${hubUrl}/api/register`, { token, machine_id: machineId, team: teamName });
}

export async function relaySend(hubUrl, token, fromMachine, fromTeam, toTeam, message) {
  return await apiPost(`${hubUrl}/api/send`, { token, from_machine: fromMachine, from_team: fromTeam, to_team: toTeam, message });
}

export async function relayPoll(hubUrl, token, machineId, teamName) {
  return await apiPost(`${hubUrl}/api/poll`, { machine_id: machineId, team: teamName }, token);
}

export async function relayAck(hubUrl, token, machineId, ackedIds) {
  return await apiPost(`${hubUrl}/api/ack`, { token, machine_id: machineId, acked_ids: ackedIds });
}

export async function relayKeepalive(hubUrl, token, machineId, teamName) {
  return await apiPost(`${hubUrl}/api/keepalive`, { token, machine_id: machineId, team: teamName });
}

export async function relayHeartbeat(hubUrl, token, machineId, teamName, agents, teamPolicies) {
  return await apiPost(`${hubUrl}/api/heartbeat`, { token, machine_id: machineId, team: teamName, agents, team_policies: teamPolicies });
}

// ─── Remote Team/Agent Queries ──────────────────────────────────────────────

/** A remote team is "active" (connection live) if polled within REMOTE_ACTIVE_MS. */
function isActive(data) {
  return data && (Date.now() - (data.polled_at || 0)) < REMOTE_ACTIVE_MS;
}

export function getRemoteTeams() {
  pruneExpiredRemoteTeams();
  const result = [];
  for (const [team, data] of remoteTeams) {
    const agentNames = Object.keys(data.agents || {});
    result.push({
      name: team,
      machine_id: data.machine_id,
      agents: agentNames,
      active: isActive(data),
      last_seen: data.polled_at || null,
    });
  }
  return result;
}

/** Delivery-status snapshot for a target team: known? currently active? who's online? */
export function getRemoteTeamStatus(team) {
  pruneExpiredRemoteTeams();
  const data = remoteTeams.get(team);
  if (!data) return { known: false, active: false, machine_id: null, online_members: [] };
  const active = isActive(data);
  return {
    known: true,
    active,
    machine_id: data.machine_id,
    last_seen: data.polled_at || null,
    // Members are only "online" if the connection is currently active.
    online_members: active ? Object.keys(data.agents || {}) : [],
  };
}

export function getRemoteAgents() {
  // STUB until v3.6 §3: this returns [] in practice because the relay client does
  // not yet send the local agent roster to the Hub (register/keepalive carry no
  // agents), so remoteTeams[].agents is always empty. Cross-machine agent-level
  // visibility (v3.5 AC4) is descoped to v3.6 §3. The consume side below is already
  // built; only link #1 (sending the roster) is missing.
  pruneExpiredRemoteTeams();
  const agents = [];
  for (const [team, data] of remoteTeams) {
    const active = isActive(data);
    for (const [agentName, agentData] of Object.entries(data.agents || {})) {
      const statusText = (typeof agentData === "object" && agentData !== null)
        ? (agentData.status_text || "Idle")
        : "Idle";
      agents.push({
        name: agentName,
        team,
        machine_id: data.machine_id,
        status: active ? "online" : "offline",
        status_text: active ? statusText : null,
        last_seen: data.polled_at || null,
        is_remote: true,
      });
    }
  }
  return agents;
}

// A team is routable (relayable) as long as it is KNOWN — active or merely offline.
// Offline-but-known still relays (hub holds the message); the sender is told it's dark.
export function isRemoteTeam(team) {
  pruneExpiredRemoteTeams();
  return remoteTeams.has(team);
}

/** Purge teams only after EXPIRE_MS of total silence (two-tier: keep "known/offline"
 *  entries until then so liveness ≠ existence). */
function pruneExpiredRemoteTeams() {
  const cutoff = Date.now() - REMOTE_EXPIRE_MS;
  let changed = false;
  for (const [team, data] of remoteTeams) {
    if ((data.polled_at || 0) < cutoff) {
      remoteTeams.delete(team);
      changed = true;
    }
  }
  if (changed) saveRemoteState();
}

// ─── Local DB persistence (cross-machine map survives restarts) ───────────────

function saveRemoteState() {
  if (!bridgeDir) return;
  const obj = {};
  for (const [team, data] of remoteTeams) obj[team] = data;
  // best-effort, fire-and-forget
  writeFile(join(bridgeDir, REMOTE_STATE_FILE), JSON.stringify(obj, null, 2), "utf8").catch(() => {});
}

async function loadRemoteState(dir) {
  try {
    const raw = await readFile(join(dir, REMOTE_STATE_FILE), "utf8");
    const obj = JSON.parse(raw);
    const cutoff = Date.now() - REMOTE_EXPIRE_MS;
    for (const [team, data] of Object.entries(obj)) {
      if ((data.polled_at || 0) >= cutoff) remoteTeams.set(team, data);
    }
  } catch { /* no prior state */ }
}

// ─── Poll Cycle ─────────────────────────────────────────────────────────────

/** Drain the local outbox: re-send spooled messages (hub-was-down), remove on success,
 *  bounce to the sender's inbox once a message exceeds REMOTE_EXPIRE_MS undelivered. */
async function drainOutbox(bridgeDir) {
  const dir = join(bridgeDir, "outbox");
  let files = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith(".json")); } catch { return; }
  for (const f of files) {
    const p = join(dir, f);
    let item;
    try { item = JSON.parse(await readFile(p, "utf8")); } catch { continue; }
    const ageMs = Date.now() - new Date(item.created || 0).getTime();
    if (ageMs > REMOTE_EXPIRE_MS) {
      // Expired undelivered → bounce to the sender's own inbox.
      const sender = item.msg?.from;
      if (sender) {
        const inbox = join(bridgeDir, `to-${sender}`, "inbox");
        await mkdir(inbox, { recursive: true }).catch(() => {});
        await writeFile(join(inbox, `bounce-${randomUUID()}.json`), JSON.stringify({
          id: `bounce-${randomUUID()}`, timestamp: new Date().toISOString(), from: "system", to: sender,
          type: "status", content: { text: `Undeliverable: your message to "${item.to_team}" expired after ${Math.floor(ageMs/86400000)}d.` },
        }, null, 2)).catch(() => {});
      }
      await rm(p, { force: true }).catch(() => {});
      continue;
    }
    try {
      await sendViaRelay(config.hub_url, config.token, config.machine_id, item.from_team, item.to_team, item.msg);
      await rm(p, { force: true }).catch(() => {}); // delivered
    } catch { /* hub still down — retry next poll */ }
  }
}

async function pollCycle(bridgeDir, teamName) {
  if (!config || !relayEnabled) return;

  const hubUrl = config.hub_url;
  const token = config.token;
  const machineId = config.machine_id;
  const team = teamName;

  await drainOutbox(bridgeDir); // resilience: flush any spooled messages first

  try {
    const result = await relayPoll(hubUrl, token, machineId, team);
    const now = Date.now();

    // Merge (do NOT wholesale-replace): teams currently online are refreshed with
    // polled_at=now; teams no longer present are KEPT (they become "known/offline")
    // until EXPIRE_MS of silence. This separates liveness from existence.
    let changed = false;
    for (const [remoteTeam, data] of Object.entries(result.online_teams || {})) {
      if (remoteTeam === team) continue;
      // B3: agents is now an object {name: {status_text: "..."}}
      const agents = typeof data.agents === "object" && data.agents !== null ? data.agents : {};
      const prev = remoteTeams.get(remoteTeam);
      remoteTeams.set(remoteTeam, {
        machine_id: data.machine_id,
        agents,
        polled_at: now,
        first_seen: prev?.first_seen || now,
      });
      changed = true;
    }
    pruneExpiredRemoteTeams();
    if (changed || remoteTeams.size) saveRemoteState();

    // Persist replicated remote team policies (federation): teams owned by OTHER machines,
    // cached locally so a disconnected node still knows the leader/rules of its remote teams.
    if (result.team_policies && Object.keys(result.team_policies).length) {
      try {
        await writeFile(join(bridgeDir, "teams-remote.json"),
          JSON.stringify({ teams: result.team_policies }, null, 2), "utf8");
      } catch { /* best effort */ }
    }

    // B3: Write incoming messages to BRIDGE_DIR/to-{agent_name}/inbox/
    //     so pollInbox naturally finds them.
    const ackedIds = [];
    for (const msg of (result.messages || [])) {
      if (!msg.lease_id) continue;

      // H2: Dedup — skip if this message identity was already processed
      const msgIdentity = msg.id || msg.lease_id;
      if (msgIdentity && hasSeenMessage(msgIdentity)) {
        ackedIds.push(msg.lease_id);
        continue;
      }

      // B3: Determine target agent — self-team inbound routes to local agent,
      // cross-team routes to first known agent on the remote team
      const targetTeam = msg.to_team || team;
      let targetName = null;

      if (targetTeam === team && localAgentName) {
        // Message for our own team — route to local agent's inbox
        targetName = localAgentName;
      } else {
        const teamData = remoteTeams.get(targetTeam);
        const agentNames = teamData ? Object.keys(teamData.agents || {}) : [];
        targetName = agentNames.length > 0 ? agentNames[0] : null;
      }

      if (!targetName) {
        // Fallback — write to staging area but pings will re-deliver
        const fallbackDir = join(bridgeDir, "remote", targetTeam, "inbox");
        await mkdir(fallbackDir, { recursive: true }).catch(() => {});
        const safeId = `relay-${randomUUID()}`;
        await writeFile(join(fallbackDir, `${safeId}.json`), JSON.stringify({
          ...msg.message,
          _relay_meta: {
            from_machine: msg.from_machine,
            from_team: msg.from_team,
            to_team: msg.to_team,
            lease_id: msg.lease_id,
          },
        }, null, 2), "utf8").catch(() => {});
        ackedIds.push(msg.lease_id);
        continue;
      }

      try {
        // Write to standard inbox so pollInbox picks it up
        const inboxDir = join(bridgeDir, `to-${targetName}`, "inbox");
        const safeId = `relay-${randomUUID()}`; // B10: derived from UUID, not sender input
        await mkdir(inboxDir, { recursive: true });
        await writeFile(join(inboxDir, `${safeId}.json`), JSON.stringify({
          ...msg.message,
          _relay_meta: {
            from_machine: msg.from_machine,
            from_team: msg.from_team,
            to_team: msg.to_team,
            lease_id: msg.lease_id,
          },
        }, null, 2), "utf8");
        ackedIds.push(msg.lease_id);
      } catch (err) {
        console.error(`[relay] Failed to write relay message to inbox: ${err.message}`);
      }
    }

    // Ack successfully written messages
    if (ackedIds.length > 0) {
      try {
        await relayAck(hubUrl, token, machineId, ackedIds);
      } catch (err) {
        console.error(`[relay] Ack failed: ${err.message}`);
      }
    }
  } catch (err) {
    // Poll failed — hub might be down. Don't crash.
    // Remote teams become stale via pruneStaleRemoteTeams() if poll keeps failing.
  }
}

// ─── Start/Stop ─────────────────────────────────────────────────────────────

export function startRelayClient(dir, teamName, relayCfg, agentName) {
  if (!relayCfg || relayCfg.enabled === false) {
    relayEnabled = false;
    return;
  }

  config = relayCfg;
  bridgeDir = dir;
  localAgentName = agentName || null;

  relayEnabled = true;

  // Restore the persisted cross-machine map (known teams survive restarts within EXPIRE_MS).
  loadRemoteState(dir);

  doRegister(bridgeDir, teamName);
  pollTimer = setInterval(() => pollCycle(bridgeDir, teamName), POLL_MS);
  registerInterval = setInterval(() => doRegister(bridgeDir, teamName), REGISTER_INTERVAL_MS);
  heartbeatInterval = setInterval(() => doHeartbeat(bridgeDir, teamName), KEEPALIVE_INTERVAL_MS);
}

export function stopRelayClient() {
  relayEnabled = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (registerInterval) { clearInterval(registerInterval); registerInterval = null; }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  remoteTeams = new Map();
}

async function doRegister(bridgeDir, teamName) {
  if (!config) return;
  try {
    await relayRegister(config.hub_url, config.token, config.machine_id, teamName);
  } catch (err) {
    // expected on slow hub startup
  }
}

/**
 * v3.6 §3 Link #1: Fold local agent roster into heartbeat.
 *
 * Reads ~/.cc2cc/status/*-heartbeat.json, filters to:
 *   - Agents on the same relay-registered team (no cross-team leakage)
 *   - Heartbeats within HEARTBEAT_STALE_S (presence accuracy)
 * Sends agents dict via /api/heartbeat (Hub stores in reg.agents).
 */
export async function doHeartbeat(bridgeDir, teamName) {
  if (!config) return;

  let agents = {};
  const statusDir = join(bridgeDir, "status");
  try {
    const files = await readdir(statusDir);
    for (const file of files) {
      if (!file.endsWith("-heartbeat.json")) continue;
      const agentName = file.replace("-heartbeat.json", "");
      const raw = await readFile(join(statusDir, file), "utf8");
      const hb = JSON.parse(raw);
      const hbTimestamp = hb.timestamp || hb.heartbeat;
      if (!hbTimestamp) continue; // no valid timestamp → skip (prevents NaN staleness)
      const hbAge = (Date.now() - new Date(hbTimestamp).getTime()) / 1000;

      // Team filter: only agents on the relay-registered team
      const agentTeams = hb.teams || [];
      if (!agentTeams.includes(teamName)) continue;

      // Freshness: use HEARTBEAT_STALE_S for presence accuracy
      if (hbAge > HEARTBEAT_STALE_S) continue;

      agents[agentName] = { status_text: hb.status_text || "Idle" };
    }
  } catch (_) {
    // Status directory may not exist — non-fatal
  }

  // Federate the team policies THIS machine owns (teams.json entries owner_machine == us).
  let ownedPolicies = {};
  try {
    const reg = JSON.parse(await readFile(join(bridgeDir, "teams.json"), "utf8"));
    for (const [tname, pol] of Object.entries(reg.teams || {})) {
      if (pol && pol.owner_machine === config.machine_id) ownedPolicies[tname] = pol;
    }
  } catch { /* no teams.json */ }

  // Fold agents + owned team policies into /api/heartbeat (keepalive is separate)
  try {
    await relayHeartbeat(config.hub_url, config.token, config.machine_id, teamName, agents, ownedPolicies);
  } catch (err) {
    // hub might be down
  }
}

export function getRelayStatus() {
  if (!config) return { enabled: false };
  return {
    enabled: relayEnabled,
    hub_url: config.hub_url,
    machine_id: config.machine_id,
    name: config.name || config.machine_id, // human label for this instance
    remote_teams: getRemoteTeams().map((t) => t.name),
  };
}

export async function sendViaRelay(hubUrl, token, fromMachine, fromTeam, toTeam, message) {
  return await relaySend(hubUrl, token, fromMachine, fromTeam, toTeam, message);
}

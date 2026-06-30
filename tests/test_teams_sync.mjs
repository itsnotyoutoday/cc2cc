/**
 * Cross-machine team-policy federation via the UNIFIED remote-teams.json.
 * m1 OWNS team "alpha" (leader owner-lead). m2 has no alpha knowledge. After relay sync,
 * m2's remote-teams.json carries alpha under `.policy` (leader/owner_machine) — so a
 * disconnected m2 still knows alpha's leader — and the role rides the `.agents{}` roster.
 * (Replaces the retired teams-remote.json assertions; uses the ephemeral-port hub fixture.)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { startHub } from "./helpers/hub.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "channel", "server.mjs");
const TOKEN = "sync-test-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let hub, procs = [], bridges = [];

const env = (b, n, team) =>
  ({ ...process.env, CC2CC_BRIDGE_DIR: b, CC2CC_IDENTITY: n, CC2CC_TEAM: team, CC2CC_ENCRYPT: "1" });

// 0f: a bare-spawned server must complete the MCP initialize handshake to activate the mesh.
function handshake(proc) {
  const send = (m) => proc.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }), 400);
}

async function bridge(machineId, agent, teams, ownedTeam) {
  const b = await mkdtemp(join(tmpdir(), `cc2cc-sync-${machineId}-`));
  bridges.push(b);
  await mkdir(join(b, "identities"), { recursive: true });
  await mkdir(join(b, "status"), { recursive: true });
  await writeFile(join(b, "secret.key"), "0".repeat(64)); // shared key (same on both)
  await writeFile(join(b, "relay.json"),
    JSON.stringify({ hub_url: hub.url, token: TOKEN, machine_id: machineId, enabled: true }));
  await writeFile(join(b, "identities", `identity-${agent}.json`),
    JSON.stringify({ display_name: agent, agent_id: randomUUID(), created: "2026-01-01T00:00:00Z", last_seen: "2026-01-01T00:00:00Z", teams }));
  if (ownedTeam) await writeFile(join(b, "teams.json"), JSON.stringify({ teams: { [ownedTeam]: {
    name: ownedTeam, owner_machine: machineId, leader: agent, succession: [],
    rules: { retention_days: 4, admission: "open", sticky_leader: true }, admitted: [agent], revoked: [],
  } } }));
  return b;
}

function startServer(b, agent, team) {
  const p = spawn("node", [SERVER], { env: env(b, agent, team), stdio: ["pipe", "pipe", "pipe"] });
  procs.push(p);
  handshake(p);
  return p;
}

describe("cross-machine federation (unified remote-teams.json)", () => {
  before(async () => { hub = await startHub({ token: TOKEN }); });
  after(async () => {
    for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
    try { await hub?.stop(); } catch {}
    for (const b of bridges) { try { await rm(b, { recursive: true, force: true }); } catch {} }
  });

  it("m2 persists m1's alpha policy under .policy (leader survives, owner_machine recorded)", async () => {
    const m1 = await bridge("m1", "owner-lead", ["alpha"], "alpha"); // owns alpha
    const m2 = await bridge("m2", "watcher", ["beta"], null);         // no alpha
    startServer(m1, "owner-lead", "alpha");
    startServer(m2, "watcher", "beta");

    let replica = null;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      try { replica = JSON.parse(await readFile(join(m2, "remote-teams.json"), "utf8")); } catch {}
      if (replica?.alpha?.policy?.leader) break;
    }
    assert.ok(replica?.alpha, "m2 has an alpha entry in the unified remote-teams.json");
    assert.equal(replica.alpha.policy?.leader, "owner-lead", "policy carries alpha's leader");
    assert.equal(replica.alpha.policy?.owner_machine, "m1", "policy carries alpha's owner_machine");
    // Unified shape: roster + policy coexist in ONE file (the whole point of the merge).
    assert.ok(replica.alpha.agents && typeof replica.alpha.agents === "object",
      "alpha entry carries an agents roster alongside its policy");
  });
});

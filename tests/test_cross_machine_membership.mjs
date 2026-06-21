/**
 * Integration harness for the multi-team / cross-machine MEMBERSHIP scenario the team is
 * validating manually. Two "machines" (separate bridges + machine_id) against one real hub:
 *   - machine A (nexus): agent "tom", team nexus.
 *   - machine B (remote): agent "rlead", LEADER/owner of team remote.
 * Drives the real Hub ← Daemon ← MCP stack (spawning server.mjs auto-launches the daemon).
 *
 * Scenario: tom requests to join remote; rlead admits tom; tom actually BECOMES a member —
 * whoami.teams includes remote, via federated admitted[] -> self-membership reconcile.
 * (Regression test for the admit-propagation fix. Part 2 — the owner seeing tom heartbeat
 * under remote, which needs multi-team daemon registration — is tracked separately.)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { startHub } from "./helpers/hub.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "channel", "server.mjs");
const SDK = join(ROOT, "channel", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);

const TOKEN = "membership-test-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let hub;
const bridges = [];
const clients = [];

async function makeBridge(machineId, agent, teams, ownedTeam) {
  const b = await mkdtemp(join(tmpdir(), `cc2cc-mem-${machineId}-`));
  bridges.push(b);
  await mkdir(join(b, "identities"), { recursive: true });
  await mkdir(join(b, "status"), { recursive: true });
  await writeFile(join(b, "secret.key"), "0".repeat(64)); // shared key on both machines
  await writeFile(join(b, "relay.json"),
    JSON.stringify({ hub_url: hub.url, token: TOKEN, machine_id: machineId, enabled: true }));
  await writeFile(join(b, "identities", `identity-${agent}.json`),
    JSON.stringify({ display_name: agent, agent_id: randomUUID(), created: "2026-01-01T00:00:00Z", teams }));
  if (ownedTeam) {
    await writeFile(join(b, "teams.json"), JSON.stringify({ teams: { [ownedTeam]: {
      name: ownedTeam, owner_machine: machineId, leader: agent, succession: [],
      rules: { retention_days: 4, admission: "open", sticky_leader: true }, admitted: [agent], revoked: [],
    } } }));
  }
  return b;
}

async function connect(bridge, agent, team) {
  const transport = new StdioClientTransport({
    command: "node", args: [SERVER],
    env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_IDENTITY: agent, CC2CC_TEAM: team, CC2CC_ENCRYPT: "1" },
  });
  const client = new Client({ name: `mem-${agent}`, version: "0" }, { capabilities: {} });
  await client.connect(transport); // SDK completes the initialize handshake → 0f activation
  clients.push(client);
  return client;
}
const txt = (r) => r.content?.[0]?.text ?? "";
const callJSON = async (c, name, args = {}) => JSON.parse(txt(await c.callTool({ name, arguments: args })));

describe("cross-machine membership (request_join → admit → propagation)", () => {
  let tom, rlead;
  before(async () => {
    hub = await startHub({ token: TOKEN });
    const bA = await makeBridge("machine-A", "tom", ["nexus"]);              // tom on nexus
    const bB = await makeBridge("machine-B", "rlead", ["remote"], "remote"); // rlead owns remote
    rlead = await connect(bB, "rlead", "remote");
    tom = await connect(bA, "tom", "nexus");
  });
  after(async () => {
    for (const c of clients) { try { await c.close(); } catch {} }
    try { await hub?.stop(); } catch {}
    for (const b of bridges) { try { await rm(b, { recursive: true, force: true }); } catch {} }
  });

  it("federation makes 'remote' visible to machine A, then admit grants tom membership", async () => {
    // 1. Wait for remote's policy to federate to machine A (daemon poll → remote-teams.json).
    let sawRemote = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const agents = await callJSON(tom, "list_agents");
      if (agents.some((a) => a.is_remote && a.team === "remote")) { sawRemote = true; break; }
    }
    assert.ok(sawRemote, "machine A federates the remote team roster (precondition)");

    // 2. tom requests to join; 3. rlead admits tom.
    await tom.callTool({ name: "request_join", arguments: { team: "remote", note: "harness" } });
    await sleep(1500);
    const admitRes = txt(await rlead.callTool({ name: "admit", arguments: { team: "remote", agent: "tom" } }));
    assert.match(admitRes, /admitted/i, "leader-side admit succeeds");

    // 4. Membership propagates to tom via federated admitted[] -> self-reconcile.
    let toms = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      toms = await callJSON(tom, "whoami");
      if (toms.teams.includes("remote")) break;
    }
    assert.ok(toms.teams.includes("remote"), "tom's whoami reflects remote membership after admit");
  });
});

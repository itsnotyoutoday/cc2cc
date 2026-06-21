/**
 * Behavioral integration scenarios over the real two-machine mesh (one hub + two
 * bridges/daemons + MCP servers). Exercises the message paths end-to-end through the
 * encryption boundary, instead of eyeballing the live mesh:
 *   1. send_team A->B delivers (decrypted) to the remote leader's inbox.
 *   2. reply path B->A delivers back.
 *   3. broadcast stays same-team (does NOT leak cross-machine).
 *   4. direct send() to a remote agent — characterize the 0d reroute (tom's report).
 *
 * coord owns team nexus on machine A; rlead owns team remote on machine B. Shared secret.key,
 * so cross-machine ciphertext decrypts on the far side; the hub only ever sees ENC: payloads.
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

const TOKEN = "xmsg-test-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => r.content?.[0]?.text ?? "";

let hub;
const bridges = [];
const clients = [];

async function makeBridge(machineId, agent, team) {
  const b = await mkdtemp(join(tmpdir(), `cc2cc-xmsg-${machineId}-`));
  bridges.push(b);
  await mkdir(join(b, "identities"), { recursive: true });
  await mkdir(join(b, "status"), { recursive: true });
  await writeFile(join(b, "secret.key"), "0".repeat(64)); // SAME key on both machines
  await writeFile(join(b, "relay.json"),
    JSON.stringify({ hub_url: hub.url, token: TOKEN, machine_id: machineId, enabled: true }));
  await writeFile(join(b, "identities", `identity-${agent}.json`),
    JSON.stringify({ display_name: agent, agent_id: randomUUID(), created: "2026-01-01T00:00:00Z", teams: [team] }));
  await writeFile(join(b, "teams.json"), JSON.stringify({ teams: { [team]: {
    name: team, owner_machine: machineId, leader: agent, succession: [],
    rules: { retention_days: 4, admission: "open", sticky_leader: true }, admitted: [agent], revoked: [],
  } } }));
  return b;
}

async function connect(bridge, agent, team) {
  const transport = new StdioClientTransport({
    command: "node", args: [SERVER],
    env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_IDENTITY: agent, CC2CC_TEAM: team, CC2CC_ENCRYPT: "1" },
  });
  const client = new Client({ name: `xmsg-${agent}`, version: "0" }, { capabilities: {} });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** Poll check_inbox on a client until its surfaced text contains `needle` (or give up). */
async function waitForInbox(client, needle, tries = 24) {
  for (let i = 0; i < tries; i++) {
    const r = txt(await client.callTool({ name: "check_inbox", arguments: {} }));
    if (r.includes(needle)) return true;
    await sleep(500);
  }
  return false;
}

describe("cross-machine messaging scenarios", () => {
  let coord, rlead;
  before(async () => {
    hub = await startHub({ token: TOKEN });
    const bA = await makeBridge("machine-A", "coord", "nexus");
    const bB = await makeBridge("machine-B", "rlead", "remote");
    coord = await connect(bA, "coord", "nexus");
    rlead = await connect(bB, "rlead", "remote");
    // Wait for BIDIRECTIONAL federation so each side can resolve the other's team.
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const a = JSON.parse(txt(await coord.callTool({ name: "list_agents", arguments: {} })));
      const b = JSON.parse(txt(await rlead.callTool({ name: "list_agents", arguments: {} })));
      if (a.some((x) => x.team === "remote") && b.some((x) => x.team === "nexus")) break;
    }
  });
  after(async () => {
    for (const c of clients) { try { await c.close(); } catch {} }
    try { await hub?.stop(); } catch {}
    for (const b of bridges) { try { await rm(b, { recursive: true, force: true }); } catch {} }
  });

  it("send_team A->B delivers decrypted to the remote leader", async () => {
    const marker = `xmsg-AtoB-${randomUUID().slice(0, 8)}`;
    await coord.callTool({ name: "send_team", arguments: { team: "remote", text: marker } });
    assert.ok(await waitForInbox(rlead, marker), "rlead received the decrypted cross-machine message");
  });

  it("reply path B->A delivers back to the nexus leader", async () => {
    const marker = `xmsg-BtoA-${randomUUID().slice(0, 8)}`;
    await rlead.callTool({ name: "send_team", arguments: { team: "nexus", text: marker } });
    assert.ok(await waitForInbox(coord, marker), "coord received the reply across machines");
  });

  it("broadcast stays same-team (does not leak cross-machine)", async () => {
    const marker = `xmsg-bcast-${randomUUID().slice(0, 8)}`;
    await coord.callTool({ name: "broadcast", arguments: { text: marker } });
    // Give it the same window a real delivery would take, then confirm it did NOT cross.
    const leaked = await waitForInbox(rlead, marker, 6);
    assert.equal(leaked, false, "broadcast must not reach another machine's team");
  });

  it("direct send() to a remote agent routes via the team (0d reroute)", async () => {
    // tom's report: a direct send to a remote agent currently reroutes through send_team.
    // Characterize it here so any change to the contract is caught by this test.
    const res = txt(await coord.callTool({ name: "send", arguments: { to: "rlead", text: "direct-probe" } }));
    assert.match(res, /remote/i, "direct send to a remote agent is handled via the remote team path");
  });
});

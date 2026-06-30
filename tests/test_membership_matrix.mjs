/**
 * Membership matrix — the SAME-MACHINE half of the team-membership behaviors. Hub-free on
 * purpose: these scenarios need no relay, so they run in plain `node --test` (no PYTHON/fastapi)
 * and stay deterministic. The cross-machine variants (federation + cross-host heartbeat) live in
 * the sibling harness test_cross_machine_membership.mjs.
 *
 * These assert the FIXED behavior (admit-propagation part 1, channel/server.mjs
 * reconcileSelfMembership — runs each poll, folds admitted[] into / drops revoked[] from the
 * agent's own identity.teams and rewrites its heartbeat). They are permanent regression tests.
 *
 * Matrix:
 *   1. multi-team agent     — env-seeded membership in two teams is reflected in whoami
 *   2. same-machine admit   — leader admits a co-located agent → that agent gains membership
 *   3. owner sees the member — leader's list_agents shows the admitted agent under the team
 *   4. evict removes it      — eviction drops the team from the agent's own membership
 *
 * NOTE: owner-side visibility of a CROSS-MACHINE member (heartbeating under the team over the
 * hub) is part 2 (multi-team daemon registration) and is covered separately when it lands.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "channel", "server.mjs");
const SDK = join(ROOT, "channel", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => r.content?.[0]?.text ?? "";
const callJSON = async (c, name, args = {}) => JSON.parse(txt(await c.callTool({ name, arguments: args })));

let bridge;
const clients = [];

// One shared bridge = one "machine". teams.json seeds team "core" led by "clead".
async function makeBridge() {
  const b = await mkdtemp(join(tmpdir(), "cc2cc-matrix-"));
  await mkdir(join(b, "identities"), { recursive: true });
  await mkdir(join(b, "status"), { recursive: true });
  await writeFile(join(b, "teams.json"), JSON.stringify({ teams: { core: {
    name: "core", owner_machine: "local", leader: "clead", succession: [],
    rules: { retention_days: 4, admission: "open", sticky_leader: true }, admitted: ["clead"], revoked: [],
  } } }));
  return b;
}

// No relay.json → relay stays idle (no hub needed). SDK connect drives the 0f handshake.
async function connect(agent, team) {
  const transport = new StdioClientTransport({
    command: "node", args: [SERVER],
    env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_IDENTITY: agent, CC2CC_TEAM: team },
  });
  const client = new Client({ name: `mx-${agent}`, version: "0" }, { capabilities: {} });
  await client.connect(transport);
  clients.push(client);
  return client;
}

// Poll a predicate for up to ~tries*250ms. Generous default — reconcile fires on the ~3s poll.
async function until(fn, tries = 32) {
  for (let i = 0; i < tries; i++) { if (await fn()) return true; await sleep(250); }
  return false;
}

describe("membership matrix (same-machine: admit / evict / multi-team)", () => {
  let clead, cmem;
  before(async () => {
    bridge = await makeBridge();
    clead = await connect("clead", "core"); // leader of core
  });
  after(async () => {
    for (const c of clients) { try { await c.close(); } catch {} }
    if (bridge) { try { await rm(bridge, { recursive: true, force: true }); } catch {} }
  });

  it("multi-team: an agent launched with CC2CC_TEAM=a,b is a member of both", async () => {
    const multi = await connect("cmulti", "alpha,beta");
    // Activation/identity creation completes shortly AFTER connect() resolves — poll for it.
    let me = null;
    await until(async () => { me = await callJSON(multi, "whoami"); return me.teams.length > 0; });
    assert.ok(me.teams.includes("alpha") && me.teams.includes("beta"),
      `multi-team membership reflected in whoami, got ${JSON.stringify(me.teams)}`);
  });

  it("same-machine admit: leader admits a co-located agent → membership propagates to that agent", async () => {
    cmem = await connect("cmem", "solo"); // not initially on core
    assert.ok(await until(async () => (await callJSON(clead, "list_agents")).some((a) => a.name === "cmem")),
      "leader sees cmem online (precondition)");

    const res = txt(await clead.callTool({ name: "admit", arguments: { team: "core", agent: "cmem" } }));
    assert.match(res, /admitted/i, "leader-side admit succeeds");

    assert.ok(await until(async () => (await callJSON(cmem, "whoami")).teams.includes("core")),
      "cmem's whoami reflects core membership after admit (self-reconcile)");
  });

  it("owner-visibility: leader's roster shows the admitted agent UNDER the team", async () => {
    await clead.callTool({ name: "admit", arguments: { team: "core", agent: "cmem" } }); // idempotent
    assert.ok(await until(async () =>
      (await callJSON(clead, "list_agents")).some((a) => a.name === "cmem" && (a.teams || []).includes("core"))),
      "leader sees cmem listed under core (cmem rewrote its heartbeat with the new team)");
  });

  it("evict removes membership: eviction drops the team from the agent's own view", async () => {
    // Precondition: cmem actually holds core (admit propagated) before we evict.
    await clead.callTool({ name: "admit", arguments: { team: "core", agent: "cmem" } });
    assert.ok(await until(async () => (await callJSON(cmem, "whoami")).teams.includes("core")),
      "precondition: cmem holds core membership before eviction");

    const res = txt(await clead.callTool({ name: "evict", arguments: { team: "core", agent: "cmem" } }));
    assert.match(res, /removed/i, "leader-side evict succeeds");

    assert.ok(await until(async () => !(await callJSON(cmem, "whoami")).teams.includes("core")),
      "evicted cmem no longer reports core membership (self-reconcile from revoked[])");
  });
});

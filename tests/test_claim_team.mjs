/** claim_team: adopt a leaderless / orphaned team in-session, folding existing members in.
 *  Covers the gap between create_team (NEW teams only) and admit/evict (must already lead). */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => r.content?.[0]?.text ?? "";

async function identity(bridge, name, teams) {
  await mkdir(join(bridge, "identities"), { recursive: true });
  await writeFile(join(bridge, "identities", `identity-${name}.json`),
    JSON.stringify({ display_name: name, agent_id: `id-${name}`, created: "2026-01-01T00:00:00Z", last_seen: new Date().toISOString(), teams }));
}

async function connect(bridge, name) {
  const transport = new StdioClientTransport({
    command: "node", args: [SERVER],
    env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_IDENTITY: name },
  });
  const client = new Client({ name: "claim-test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe("claim_team", () => {
  let bridge, client;
  after(async () => {
    try { await client?.close(); } catch {}
    if (bridge) await rm(bridge, { recursive: true, force: true });
  });

  it("adopts a leaderless team, becomes leader, and folds existing members into admitted", async () => {
    bridge = await mkdtemp(join(tmpdir(), "cc2cc-claim-"));
    // An existing team registry entry with NO leader (orphaned), plus a member that references it.
    await writeFile(join(bridge, "teams.json"), JSON.stringify({
      teams: { nexus: { name: "nexus", owner_machine: "local", leader: null, admitted: [], revoked: [], rules: { retention_days: 4, admission: "open", sticky_leader: true } } },
    }));
    await identity(bridge, "claimer", ["nexus"]);
    await identity(bridge, "member1", ["nexus"]);

    client = await connect(bridge, "claimer");
    await sleep(1500); // let the poll pick up member1's heartbeat into knownAgents

    const res = txt(await client.callTool({ name: "claim_team", arguments: { team: "nexus" } }));
    assert.match(res, /Claimed leadership of "nexus"/i, `unexpected: ${res}`);

    const reg = JSON.parse(await readFile(join(bridge, "teams.json"), "utf8")).teams;
    assert.equal(reg.nexus.leader, "claimer", "claimer is now leader");
    assert.ok(reg.nexus.admitted.includes("claimer"), "claimer admitted");
    assert.ok(reg.nexus.admitted.includes("member1"), "pre-existing member folded into admitted");

    // list_teams reflects the new leader after a poll.
    let leads = false;
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      const teams = JSON.parse(txt(await client.callTool({ name: "list_teams", arguments: {} })));
      if (teams.find((t) => t.name === "nexus")?.leader === "claimer") { leads = true; break; }
    }
    assert.ok(leads, "claimer leads nexus in list_teams");
  });

  it("refuses to claim a team that already has a (different) leader", async () => {
    const b2 = await mkdtemp(join(tmpdir(), "cc2cc-claim2-"));
    await writeFile(join(b2, "teams.json"), JSON.stringify({
      teams: { owned: { name: "owned", owner_machine: "local", leader: "boss", admitted: ["boss"], revoked: [], rules: { retention_days: 4, admission: "open", sticky_leader: true } } },
    }));
    await identity(b2, "intruder", ["owned"]);
    const c2 = await connect(b2, "intruder");
    await sleep(1500);
    const res = txt(await c2.callTool({ name: "claim_team", arguments: { team: "owned" } }));
    assert.match(res, /already has a leader/i, `unexpected: ${res}`);
    const reg = JSON.parse(await readFile(join(b2, "teams.json"), "utf8")).teams;
    assert.equal(reg.owned.leader, "boss", "leadership unchanged");
    try { await c2.close(); } catch {}
    await rm(b2, { recursive: true, force: true });
  });

  it("adopts an orphaned team that has no registry entry at all", async () => {
    const b3 = await mkdtemp(join(tmpdir(), "cc2cc-claim3-"));
    // No teams.json — the team exists only as a reference in a member's identity.
    await identity(b3, "founder", ["ghost"]);
    const c3 = await connect(b3, "founder");
    await sleep(1500);
    const res = txt(await c3.callTool({ name: "claim_team", arguments: { team: "ghost" } }));
    assert.match(res, /Claimed leadership of "ghost"/i, `unexpected: ${res}`);
    const reg = JSON.parse(await readFile(join(b3, "teams.json"), "utf8")).teams;
    assert.equal(reg.ghost.leader, "founder");
    assert.ok(reg.ghost.admitted.includes("founder"));
    try { await c3.close(); } catch {}
    await rm(b3, { recursive: true, force: true });
  });
});

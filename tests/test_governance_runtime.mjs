/**
 * Runtime honors cc2cc_admin governance artifacts:
 *  - MCP evict/admit (leader-guarded) update team-<name>.json + tombstone
 *  - revoked participation is filtered out of list_agents (GAB policy governs)
 *  - operator-designated leader (team-<name>.json) overrides reconcile
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => r.content?.[0]?.text ?? "";
const env = (b, n) => ({ ...process.env, CC2CC_BRIDGE_DIR: b, CC2CC_IDENTITY: n });

async function seed(bridge, name, teams, role) {
  await mkdir(join(bridge, "identities"), { recursive: true });
  await writeFile(join(bridge, "identities", `identity-${name}.json`),
    JSON.stringify({ display_name: name, agent_id: `id-${name}`, created: "2026-01-01T00:00:00Z", teams, role }));
}
const exists = (p) => access(p).then(() => true).catch(() => false);

describe("runtime honors governance artifacts", () => {
  let bridge, client, transport, memProc;
  after(async () => {
    try { await client?.close(); } catch {}
    try { memProc?.kill("SIGKILL"); } catch {}
    if (bridge) await rm(bridge, { recursive: true, force: true });
  });

  it("evict/admit (leader) + revocation filtering + operator override", async () => {
    bridge = await mkdtemp(join(tmpdir(), "cc2cc-gov-"));
    await mkdir(join(bridge, "status"), { recursive: true });
    await seed(bridge, "a-lead", ["gov"], "leader");
    await seed(bridge, "a-mem", ["gov"], "member");
    // Leadership lives in teams.json (not identity role).
    await writeFile(join(bridge, "teams.json"), JSON.stringify({ teams: { gov: {
      name: "gov", owner_machine: "local", leader: "a-lead", succession: [],
      rules: { retention_days: 4, admission: "open", sticky_leader: true },
      admitted: ["a-lead", "a-mem"], revoked: [],
    } } }));

    transport = new StdioClientTransport({ command: "node", args: [SERVER], env: env(bridge, "a-lead") });
    client = new Client({ name: "gov-test", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    memProc = spawn("node", [SERVER], { env: env(bridge, "a-mem"), stdio: ["pipe", "pipe", "pipe"] });

    // Wait until a-lead leads gov and a-mem is visible.
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      const teams = JSON.parse(txt(await client.callTool({ name: "list_teams", arguments: {} })));
      const agents = JSON.parse(txt(await client.callTool({ name: "list_agents", arguments: {} })));
      if (teams.find((t) => t.name === "gov")?.leader === "a-lead" && agents.find((a) => a.name === "a-mem")) break;
    }

    // Guard: a-lead cannot evict from a team it does not lead.
    const denied = txt(await client.callTool({ name: "evict", arguments: { team: "other", agent: "x" } }));
    assert.match(denied, /Only the leader/i, "non-led team eviction must be denied");

    // Evict a-mem from gov (leader action).
    const ev = txt(await client.callTool({ name: "evict", arguments: { team: "gov", agent: "a-mem" } }));
    assert.match(ev, /Removed/i);
    const teamFile = JSON.parse(await readFile(join(bridge, "teams.json"), "utf8")).teams["gov"];
    assert.ok(teamFile.revoked.includes("a-mem"), "team file records revocation");
    assert.ok(await exists(join(bridge, "tombstones", "gov__a-mem.json")), "tombstone emitted");

    // After a poll, a-mem's gov membership is filtered out of the roster.
    let filtered = false;
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      const agents = JSON.parse(txt(await client.callTool({ name: "list_agents", arguments: {} })));
      const am = agents.find((a) => a.name === "a-mem");
      if (am && !am.teams.includes("gov")) { filtered = true; break; }
    }
    assert.ok(filtered, "revoked member no longer shown in team gov");

    // Re-admit a-mem.
    const ad = txt(await client.callTool({ name: "admit", arguments: { team: "gov", agent: "a-mem" } }));
    assert.match(ad, /Admitted/i);
    const teamFile2 = JSON.parse(await readFile(join(bridge, "teams.json"), "utf8")).teams["gov"];
    assert.ok(!teamFile2.revoked.includes("a-mem") && teamFile2.admitted.includes("a-mem"), "re-admitted");

    // Operator override: designate a-mem as leader via team file.
    teamFile2.leader = "a-mem";
    const reg = JSON.parse(await readFile(join(bridge, "teams.json"), "utf8"));
    reg.teams["gov"] = teamFile2;
    await writeFile(join(bridge, "teams.json"), JSON.stringify(reg));
    let overridden = false;
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      const teams = JSON.parse(txt(await client.callTool({ name: "list_teams", arguments: {} })));
      if (teams.find((t) => t.name === "gov")?.leader === "a-mem") { overridden = true; break; }
    }
    assert.ok(overridden, "operator-designated leader overrides reconcile");
  });
});

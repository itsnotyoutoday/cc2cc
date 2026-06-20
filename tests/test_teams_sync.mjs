/**
 * Task 15 (live): cross-machine team-policy federation.
 * m1 OWNS team "alpha" (leader owner-lead). m2 has no alpha knowledge. After relay sync,
 * m2 has a persisted teams-remote.json replica with alpha's policy — so a disconnected
 * m2 still knows alpha's leader.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "channel", "server.mjs");
const HUB = join(ROOT, "relay_hub.py");
const PY = process.env.HOME + "/venv/bin/python";
const PORT = 10987, TOKEN = "sync-test-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (b, n) => ({ ...process.env, CC2CC_BRIDGE_DIR: b, CC2CC_IDENTITY: n, CC2CC_ENCRYPT: "1" });

let hub, procs = [], bridges = [];
async function bridge(machineId, agent, teams, ownedTeam) {
  const b = await mkdtemp(join(tmpdir(), `cc2cc-sync-${machineId}-`));
  bridges.push(b);
  await mkdir(join(b, "identities"), { recursive: true });
  await mkdir(join(b, "status"), { recursive: true });
  await writeFile(join(b, "secret.key"), "0".repeat(64)); // shared key (same on both)
  await writeFile(join(b, "relay.json"), JSON.stringify({ hub_url: `http://127.0.0.1:${PORT}`, token: TOKEN, machine_id: machineId, enabled: true }));
  await writeFile(join(b, "identities", `identity-${agent}.json`), JSON.stringify({ display_name: agent, agent_id: randomUUID(), created: "2026-01-01T00:00:00Z", last_seen: "2026-01-01T00:00:00Z", teams }));
  if (ownedTeam) await writeFile(join(b, "teams.json"), JSON.stringify({ teams: { [ownedTeam]: { name: ownedTeam, owner_machine: machineId, leader: agent, succession: [], rules: { retention_days: 4, admission: "open", sticky_leader: true }, admitted: [agent], revoked: [] } } }));
  return b;
}

describe("cross-machine team-policy federation (teams-remote.json)", () => {
  before(async () => {
    hub = spawn(PY, [HUB, "--port", String(PORT), "--token", TOKEN, "--host", "127.0.0.1"], { stdio: ["pipe","pipe","pipe"] });
    for (let i = 0; i < 30; i++) { try { if ((await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()).status === "ok") break; } catch {} await sleep(300); }
  });
  after(async () => {
    for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
    try { hub.kill("SIGKILL"); } catch {}
    for (const b of bridges) await rm(b, { recursive: true, force: true });
  });

  it("m2 receives + persists the alpha policy owned by m1", async () => {
    const m1 = await bridge("m1", "owner-lead", ["alpha"], "alpha");  // owns alpha
    const m2 = await bridge("m2", "watcher", ["beta"], null);          // no alpha
    procs.push(spawn("node", [SERVER], { env: env(m1, "owner-lead"), stdio: ["pipe","pipe","pipe"] }));
    procs.push(spawn("node", [SERVER], { env: env(m2, "watcher"), stdio: ["pipe","pipe","pipe"] }));

    let replica = null;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      try { replica = JSON.parse(await readFile(join(m2, "teams-remote.json"), "utf8")); } catch {}
      if (replica?.teams?.alpha) break;
    }
    assert.ok(replica?.teams?.alpha, "m2 persisted a teams-remote.json replica with alpha");
    assert.equal(replica.teams.alpha.leader, "owner-lead", "replica carries alpha's leader");
    assert.equal(replica.teams.alpha.owner_machine, "m1");
  });
});

/**
 * QA (adversarial) cross-language + JS-side tests for the teams.json write lock.
 *
 *  - JS↔JS lost-update: two live MCP servers, each leading its own team, admit concurrently
 *    to the SHARED teams.json. Both rosters must persist.
 *  - JS↔Python lost-update: a live MCP server admits to teamA while the real Python
 *    cc2cc-admin admits to teamA concurrently. No member may be clobbered.
 *  - Protocol compat: a lock left by a JS-style holder (live+fresh) blocks Python and the
 *    holder format/path match.
 *
 * Run: node --test tests/test_qa_lock_cross.mjs
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK = join(HERE, "..", "channel", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);
const SERVER = join(HERE, "..", "channel", "server.mjs");
const REPO = join(HERE, "..");
const PYBIN = process.env.PYTHON || "/opt/cc2cc/venv/bin/python3"; // CI-portable: honor PYTHON (fastapi venv)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => r.content?.[0]?.text ?? "";

async function identity(bridge, name, teams) {
  await mkdir(join(bridge, "identities"), { recursive: true });
  await writeFile(join(bridge, "identities", `identity-${name}.json`),
    JSON.stringify({ display_name: name, agent_id: `id-${name}`, created: "2026-01-01T00:00:00Z",
      last_seen: new Date().toISOString(), teams }));
}
async function connect(bridge, name) {
  const transport = new StdioClientTransport({
    command: "node", args: [SERVER],
    env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_IDENTITY: name },
  });
  const client = new Client({ name: "qa", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

/** Drive the real Python admin in-process (one cmd per subprocess call). */
function pyAdmin(bridge, jsExpr) {
  return spawnSync(PYBIN, ["-c", jsExpr], {
    env: { ...process.env, CC2CC_BRIDGE_DIR: bridge },
    cwd: REPO, encoding: "utf8",
  });
}

describe("QA teams.json lock — cross-language / multi-writer", () => {
  let bridge;
  const clients = [];
  after(async () => {
    for (const c of clients) { try { await c.close(); } catch {} }
    if (bridge) await rm(bridge, { recursive: true, force: true });
  });

  it("JS↔JS: two servers admitting concurrently to a shared teams.json — no lost update", async () => {
    bridge = await mkdtemp(join(tmpdir(), "cc2cc-qa-jsjs-"));
    // Two teams, each with its own leader, in ONE registry.
    await writeFile(join(bridge, "teams.json"), JSON.stringify({ teams: {
      teamA: { name: "teamA", owner_machine: "local", leader: "lannister", admitted: ["lannister"], revoked: [], rules: { retention_days: 4, admission: "open", sticky_leader: true } },
      teamB: { name: "teamB", owner_machine: "local", leader: "stark", admitted: ["stark"], revoked: [], rules: { retention_days: 4, admission: "open", sticky_leader: true } },
    }}));
    await identity(bridge, "lannister", ["teamA"]);
    await identity(bridge, "stark", ["teamB"]);
    // Candidate members
    for (let i = 0; i < 12; i++) {
      await identity(bridge, `a${i}`, ["teamA"]);
      await identity(bridge, `b${i}`, ["teamB"]);
    }
    const a = await connect(bridge, "lannister"); clients.push(a.client);
    const b = await connect(bridge, "stark"); clients.push(b.client);
    await sleep(2000); // let both become leaders of their team

    // Fire interleaved admits from BOTH servers as fast as possible.
    const jobs = [];
    for (let i = 0; i < 12; i++) {
      jobs.push(a.client.callTool({ name: "admit", arguments: { team: "teamA", agent: `a${i}` } }));
      jobs.push(b.client.callTool({ name: "admit", arguments: { team: "teamB", agent: `b${i}` } }));
    }
    const results = await Promise.all(jobs);
    for (const r of results) {
      const t = txt(r);
      assert.ok(/admitted|added/i.test(t) || /Only the leader/i.test(t), `admit returned: ${t}`);
    }
    const reg = JSON.parse(await readFile(join(bridge, "teams.json"), "utf8")).teams;
    const aSet = new Set(reg.teamA.admitted);
    const bSet = new Set(reg.teamB.admitted);
    const missA = [...Array(12).keys()].filter((i) => !aSet.has(`a${i}`)).map((i) => `a${i}`);
    const missB = [...Array(12).keys()].filter((i) => !bSet.has(`b${i}`)).map((i) => `b${i}`);
    assert.deepEqual(missA, [], `LOST UPDATE teamA missing: ${missA}`);
    assert.deepEqual(missB, [], `LOST UPDATE teamB missing: ${missB}`);
    // teamB entry must survive teamA writes entirely (whole-registry clobber check).
    assert.ok(reg.teamB && reg.teamB.leader === "stark", "teamB entry clobbered by teamA writes");
  });

  it("JS↔Python: live server + real cc2cc-admin admit concurrently — no lost update", async () => {
    const br = await mkdtemp(join(tmpdir(), "cc2cc-qa-jspy-"));
    await writeFile(join(br, "teams.json"), JSON.stringify({ teams: {
      teamA: { name: "teamA", owner_machine: "local", leader: "boss", admitted: ["boss"], revoked: [], rules: { retention_days: 4, admission: "open", sticky_leader: true } },
    }}));
    await identity(br, "boss", ["teamA"]);
    for (let i = 0; i < 10; i++) {
      await identity(br, `js${i}`, ["teamA"]);
      await identity(br, `py${i}`, ["teamA"]);
    }
    const s = await connect(br, "boss"); clients.push(s.client);
    await sleep(2000);

    // Python side: a single process that fires 10 admits via the real cmd path, back-to-back,
    // while JS fires its 10. Use the real with_teams_lock-decorated cmd_team_admit.
    const pyScript = `
import sys; sys.path.insert(0, ${JSON.stringify(REPO)})
from cc2cc import admin
class A: pass
for i in range(10):
    a=A(); a.name="teamA"; a.agent=f"py{i}"
    try: admin.cmd_team_admit(a)
    except SystemExit: pass
print("py-done")
`;
    const pyProc = spawn(PYBIN, ["-c", pyScript], {
      env: { ...process.env, CC2CC_BRIDGE_DIR: br }, cwd: REPO,
    });
    let pyOut = ""; pyProc.stdout.on("data", (d) => (pyOut += d));
    let pyErr = ""; pyProc.stderr.on("data", (d) => (pyErr += d));

    // JS admits concurrently.
    const jobs = [];
    for (let i = 0; i < 10; i++) {
      jobs.push(s.client.callTool({ name: "admit", arguments: { team: "teamA", agent: `js${i}` } }));
    }
    const [_, jsResults] = await Promise.all([
      new Promise((res) => pyProc.on("close", res)),
      Promise.all(jobs),
    ]);
    for (const r of jsResults) {
      const t = txt(r);
      assert.ok(/admitted|added/i.test(t), `JS admit returned: ${t}`);
    }
    const reg = JSON.parse(await readFile(join(br, "teams.json"), "utf8")).teams;
    const adm = new Set(reg.teamA.admitted);
    const missJs = [...Array(10).keys()].filter((i) => !adm.has(`js${i}`)).map((i) => `js${i}`);
    const missPy = [...Array(10).keys()].filter((i) => !adm.has(`py${i}`)).map((i) => `py${i}`);
    await rm(br, { recursive: true, force: true });
    assert.deepEqual(missJs, [], `LOST UPDATE: JS admits clobbered: ${missJs} (pyErr=${pyErr})`);
    assert.deepEqual(missPy, [], `LOST UPDATE: Python admits clobbered: ${missPy} (pyOut=${pyOut})`);
  });

  // The HIGH-CONTENTION JS↔Python lost-update scenario that lived here as a flaky `it.skip` busy-wait
  // placeholder has been rewritten as the AUTHORITATIVE test in tests/test_qa_lock_contention.mjs
  // (rlead/QA): sleep barrier (no core-starvation false positives), captured fail-loud output, and
  // retry-on-fail-loud per the lock's caller-retries contract — asserting ZERO SILENT clobbers plus a
  // dedicated forced-contention case that actually traverses the fail-loud→retry→converge path.

  it("protocol: a JS-format live+fresh lock blocks Python (same path + holder schema)", async () => {
    const br = await mkdtemp(join(tmpdir(), "cc2cc-qa-proto-"));
    await writeFile(join(br, "teams.json"), JSON.stringify({ teams: {
      teamA: { name: "teamA", owner_machine: "local", leader: "boss", admitted: ["boss"], revoked: [] },
    }}));
    // A long-lived holder process (alive, fresh) writes a JS-style holder at the JS lock path.
    const holder = spawn(PYBIN, ["-c", "import time; time.sleep(30)"]);
    await sleep(200);
    const lockPath = join(br, "teams.json.lock");
    await writeFile(lockPath, JSON.stringify({ pid: holder.pid, ts: Date.now() }));

    // Python admin must FAIL LOUD (not steal) and leave teams.json unchanged.
    const before = await readFile(join(br, "teams.json"), "utf8");
    const t0 = Date.now();
    const r = pyAdmin(br, `
import sys; sys.path.insert(0, ${JSON.stringify(REPO)})
from cc2cc import admin
class A: pass
a=A(); a.name="teamA"; a.agent="intruder"
admin.cmd_team_admit(a)
`);
    const elapsed = Date.now() - t0;
    holder.kill("SIGKILL");
    const after = await readFile(join(br, "teams.json"), "utf8");
    await rm(br, { recursive: true, force: true });

    assert.notEqual(r.status, 0, `Python should have failed loud, exit=${r.status} stderr=${r.stderr}`);
    assert.match((r.stderr || "") + (r.stdout || ""), /lock busy|aborting|lost mutation/i,
      `expected fail-loud message; got: ${r.stderr}${r.stdout}`);
    assert.ok(elapsed >= 4500, `should have waited ~5s before failing; waited ${elapsed}ms`);
    assert.equal(before, after, "teams.json modified despite a held lock");
  });
});

/**
 * QA stress test A (rlead / independent QA) — AUTHORITATIVE multi-process lost-update test for the
 * teams.json write lock, JS↔Python under synchronized high contention.
 *
 * This REPLACES the busy-wait `it.skip(...)` placeholder in test_qa_lock_cross.mjs. superbad
 * (dev) flagged three harness flaws in that placeholder; this version fixes all three so the test
 * measures the LOCK, not the harness:
 *
 *   1. SLEEP barrier (not `while time()<barrier: pass`). The hot busy-wait pegged every core, so the
 *      OS would deschedule one writer past the 5s acquire deadline — a correct FAIL-LOUD refusal that
 *      the old harness then miscounted as a clobber. A sleep barrier releases all writers together
 *      without starving the scheduler.
 *   2. CAPTURE stderr/stdout (not stdio:"ignore"). The fail-loud signal must be observable to be
 *      classified — a refusal is a healthy outcome, not a lost update.
 *   3. RETRY on the fail-loud contract. The lock raises (Python RuntimeError / JS isError
 *      "lock busy") precisely so the CALLER retries; the old worker even caught the WRONG type
 *      (`except SystemExit`) while the lock raises RuntimeError, so the retry never happened.
 *
 * The invariant under test is NOT "every first attempt succeeds" — it is ZERO SILENT CLOBBERS:
 * every writer that RETURNS SUCCESS must be present in the final teams.json. A writer that fails
 * loud and is retried to success is correct; a writer that reports success but whose admit vanished
 * is the bug. We also assert full convergence (all admits land) and that nobody exhausts its retry
 * budget (a liveness check on the lock's fairness).
 *
 * Run: PYTHON=… node --test tests/test_qa_lock_contention.mjs
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK = join(HERE, "..", "channel", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);
const SERVER = join(HERE, "..", "channel", "server.mjs");
const REPO = join(HERE, "..");
const PYBIN = process.env.PYTHON || "/opt/cc2cc/venv/bin/python3";
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

/**
 * Python worker: a real `cmd_team_admit` released at a SLEEP barrier, retrying the fail-loud
 * RuntimeError per the lock's caller-retries contract. Prints exactly one structured line so the
 * parent can classify the outcome (ok / gaveup) and count retries — never silent.
 */
const PY_WORKER = `
import sys, os, time, random
sys.path.insert(0, ${JSON.stringify(REPO)})  # exercise the LOCAL repo's cc2cc, not the installed copy
from cc2cc import admin

team, agent, barrier, budget_s = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])

# (1) SLEEP barrier — release with the pack without pegging the scheduler.
now = time.time()
if barrier > now:
    time.sleep(barrier - now)

class A: pass
args = A(); args.name = team; args.agent = agent

deadline = time.time() + budget_s
retries = 0
while True:
    try:
        admin.cmd_team_admit(args)        # real read-merge-write under the real lock
        print(f"RESULT:{agent}:ok:{retries}", flush=True)
        break
    except RuntimeError as e:             # (3) fail-loud contract → caller retries
        if "lock busy" not in str(e):
            print(f"RESULT:{agent}:error:{retries}:{e}", flush=True); break
        retries += 1
        if time.time() > deadline:
            print(f"RESULT:{agent}:gaveup:{retries}", flush=True); break
        time.sleep(0.02 + random.random() * 0.08)
    except SystemExit:                    # admit on an already-member is a no-op success, not a clobber
        print(f"RESULT:{agent}:ok:{retries}", flush=True); break
`;

/** One Python admit process; resolves to a classified outcome parsed from its captured stdout. */
function pyAdmit(bridge, team, agent, barrierSec, budgetSec) {
  return new Promise((res) => {
    const p = spawn(PYBIN, ["-c", PY_WORKER, team, agent, String(barrierSec), String(budgetSec)],
      { env: { ...process.env, CC2CC_BRIDGE_DIR: bridge }, cwd: REPO });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));   // (2) capture — do NOT ignore
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      const m = out.match(/RESULT:([^:]+):([^:]+):(\d+)/);
      res(m
        ? { side: "py", agent, status: m[2], retries: +m[3] }
        : { side: "py", agent, status: "crash", retries: 0, code, err: err.trim().slice(-400) });
    });
  });
}

/** One JS admit via the live MCP server, retrying on the isError "lock busy" fail-loud signal. */
async function jsAdmit(client, team, agent, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let retries = 0;
  for (;;) {
    const r = await client.callTool({ name: "admit", arguments: { team, agent } });
    const body = txt(r);
    if (!(r.isError && /lock busy|aborting/i.test(body))) return { side: "js", agent, status: "ok", retries };
    retries++;
    if (Date.now() > deadline) return { side: "js", agent, status: "gaveup", retries };
    await sleep(20 + Math.random() * 80);
  }
}

describe("QA stress A: JS↔Python high-contention lost-update (authoritative)", () => {
  const bridges = [];
  const clients = [];
  after(async () => {
    for (const c of clients) { try { await c.close(); } catch {} }
    for (const b of bridges) { try { await rm(b, { recursive: true, force: true }); } catch {} }
  });

  it("synchronized burst of real JS + Python writers — zero SILENT clobbers, full convergence", async () => {
    const N = 12;                 // 12 JS + 12 Python = 24-way contention on one teams.json
    const BUDGET_MS = 25000;      // generous retry budget; the lock's 5s acquire timeout fits many times over
    const bridge = await mkdtemp(join(tmpdir(), "cc2cc-qa-hc-"));
    bridges.push(bridge);

    await writeFile(join(bridge, "teams.json"), JSON.stringify({ teams: {
      teamA: { name: "teamA", owner_machine: "local", leader: "boss",
        admitted: ["boss"], revoked: [], rules: { retention_days: 4, admission: "open", sticky_leader: true } },
    }}));
    await identity(bridge, "boss", ["teamA"]);
    for (let i = 0; i < N; i++) {
      await identity(bridge, `js${i}`, ["teamA"]);
      await identity(bridge, `py${i}`, ["teamA"]);
    }

    const s = await connect(bridge, "boss");
    clients.push(s.client);
    await sleep(2000);            // let the server settle (identity + first poll) before the burst

    // Shared release instant: ~1.2s out, expressed in seconds for Python's time.time().
    const barrierSec = (Date.now() + 1200) / 1000;

    const pyJobs = Array.from({ length: N }, (_, i) =>
      pyAdmit(bridge, "teamA", `py${i}`, barrierSec, BUDGET_MS / 1000));
    const jsJobs = (async () => {
      await sleep(Math.max(0, barrierSec * 1000 - Date.now()));   // JS hits the same barrier
      return Promise.all(Array.from({ length: N }, (_, i) => jsAdmit(s.client, "teamA", `js${i}`, BUDGET_MS)));
    })();

    const [pyOut, jsOut] = await Promise.all([Promise.all(pyJobs), jsJobs]);
    const outcomes = [...pyOut, ...jsOut];

    // No worker may have crashed (uncaught) or exhausted its retry budget — both would mask a clobber.
    const crashed = outcomes.filter((o) => o.status === "crash");
    assert.deepEqual(crashed, [], `worker(s) crashed (uncaught): ${JSON.stringify(crashed)}`);
    const gaveup = outcomes.filter((o) => o.status === "gaveup");
    assert.deepEqual(gaveup.map((o) => o.agent), [],
      `worker(s) exhausted the ${BUDGET_MS}ms retry budget — lock starvation/unfairness, not a clobber`);
    const errored = outcomes.filter((o) => o.status === "error");
    assert.deepEqual(errored, [], `worker(s) hit an unexpected error: ${JSON.stringify(errored)}`);

    // THE assertion: every writer that REPORTED SUCCESS must be in the final roster. A success whose
    // admit is missing is a SILENT lost update — the exact bug the lock exists to prevent.
    const reg = JSON.parse(await readFile(join(bridge, "teams.json"), "utf8")).teams;
    const admitted = new Set(reg.teamA.admitted);
    const okAgents = outcomes.filter((o) => o.status === "ok").map((o) => o.agent);
    const silentClobbers = okAgents.filter((a) => !admitted.has(a));
    assert.deepEqual(silentClobbers, [],
      `SILENT CLOBBER — reported success but absent from teams.json: ${silentClobbers}`);

    // With retry honoring the fail-loud contract, the system must also fully converge.
    const allExpected = [...Array(N).keys()].flatMap((i) => [`js${i}`, `py${i}`]);
    const missing = allExpected.filter((a) => !admitted.has(a));
    assert.deepEqual(missing, [], `did not converge — missing admits after retry: ${missing}`);

    // Visibility into how hard the lock was actually exercised (retries prove real contention occurred).
    const totalRetries = outcomes.reduce((n, o) => n + (o.retries || 0), 0);
    console.log(`[stress A] 24-way burst: ${okAgents.length}/${allExpected.length} landed, ` +
      `${totalRetries} fail-loud retries absorbed, 0 silent clobbers`);
  });

  // A clean burst (above) never reaches the fail-loud path — the critical section is sub-millisecond, so
  // writers serialize well inside the 5s acquire window and `retries` stays 0. That leaves the RETRY
  // CONTRACT itself unproven. Here we FORCE it: an external holder grabs the real lock and sleeps ~6s —
  // past the 5s acquire deadline (so waiters DO raise the fail-loud RuntimeError / isError) but under the
  // 30s max_hold (so it is NOT stolen as stale). Correct behavior: every waiter fails loud, retries per
  // contract, and once the holder releases, ALL admits still land — zero silent clobbers.
  it("forced fail-loud: writers blocked past the 5s acquire deadline retry and still converge", async () => {
    const N = 5;
    const HOLD_MS = 6000;         // > 5s acquire timeout, < 30s max_hold → fail-loud, not steal
    const BUDGET_MS = 25000;
    const bridge = await mkdtemp(join(tmpdir(), "cc2cc-qa-forced-"));
    bridges.push(bridge);

    await writeFile(join(bridge, "teams.json"), JSON.stringify({ teams: {
      teamA: { name: "teamA", owner_machine: "local", leader: "boss",
        admitted: ["boss"], revoked: [], rules: { retention_days: 4, admission: "open", sticky_leader: true } },
    }}));
    await identity(bridge, "boss", ["teamA"]);
    for (let i = 0; i < N; i++) {
      await identity(bridge, `js${i}`, ["teamA"]);
      await identity(bridge, `py${i}`, ["teamA"]);
    }
    const s = await connect(bridge, "boss");
    clients.push(s.client);
    await sleep(2000);

    // External holder: take the REAL lock and sit on it for HOLD_MS (a live, fresh, non-stale holder).
    const holder = spawn(PYBIN, ["-c",
      `import sys,time; sys.path.insert(0, ${JSON.stringify(REPO)});` +
      `from cc2cc.admin import teams_lock;\nwith teams_lock():\n time.sleep(${HOLD_MS / 1000})`],
      { env: { ...process.env, CC2CC_BRIDGE_DIR: bridge }, cwd: REPO, stdio: "ignore" });
    await sleep(400);             // ensure the holder owns the lock before writers start

    const barrierSec = (Date.now() + 200) / 1000;
    const pyJobs = Array.from({ length: N }, (_, i) =>
      pyAdmit(bridge, "teamA", `py${i}`, barrierSec, BUDGET_MS / 1000));
    const jsJobs = Promise.all(Array.from({ length: N }, (_, i) =>
      jsAdmit(s.client, "teamA", `js${i}`, BUDGET_MS)));

    const [pyOut, jsOut] = await Promise.all([Promise.all(pyJobs), jsJobs]);
    try { holder.kill("SIGKILL"); } catch {}
    const outcomes = [...pyOut, ...jsOut];

    // The whole point: the fail-loud path was actually traversed (someone was forced to retry).
    const totalRetries = outcomes.reduce((n, o) => n + (o.retries || 0), 0);
    assert.ok(totalRetries > 0,
      `expected the 6s-held lock to force fail-loud retries; got ${totalRetries} (holder may not have engaged)`);

    // Despite every writer being blocked past the acquire deadline, none may be silently dropped...
    const reg = JSON.parse(await readFile(join(bridge, "teams.json"), "utf8")).teams;
    const admitted = new Set(reg.teamA.admitted);
    const okAgents = outcomes.filter((o) => o.status === "ok").map((o) => o.agent);
    const silentClobbers = okAgents.filter((a) => !admitted.has(a));
    assert.deepEqual(silentClobbers, [],
      `SILENT CLOBBER after fail-loud retry: ${silentClobbers} (outcomes=${JSON.stringify(outcomes)})`);

    // ...and the retry contract must drive the system to full convergence once the holder releases.
    const allExpected = [...Array(N).keys()].flatMap((i) => [`js${i}`, `py${i}`]);
    const missing = allExpected.filter((a) => !admitted.has(a));
    assert.deepEqual(missing, [], `did not converge after retry: missing ${missing}`);

    console.log(`[stress A/forced] ${HOLD_MS}ms-held lock forced ${totalRetries} fail-loud retries; ` +
      `all ${allExpected.length} writers converged, 0 silent clobbers`);
  });
});

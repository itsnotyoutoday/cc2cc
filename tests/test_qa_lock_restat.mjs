/**
 * QA stress B+ (rlead) — re-stat-before-write hardening for the teams.json lock.
 *
 * Stress B (test_qa_lock_steal_window.mjs) characterized the ONE remaining silent clobber: a holder
 * frozen mid-section past max_hold has its lock stolen, then resumes and overwrites the thief's update.
 * Agreed fix (superbad to implement BOTH sides): immediately before the final atomic write, re-stat the
 * lock and confirm the on-disk holder is still OUR token (pid+ts). If not, ABORT LOUD (raise) instead of
 * writing — which the existing fail-loud→retry contract already absorbs. This converts the last silent
 * lost-update into a loud, retried one, making the lock provably free of SILENT clobbers even under
 * pathological starvation.
 *
 * This test drives the REAL Python lock + save path: a holder takes teams_lock(), reads, is descheduled
 * past max_hold (env-shrunk to 800ms), a peer steals + admits, then the holder calls the REAL _save_team.
 *   - PRE-FIX  (no re-stat): _save_team writes the holder's stale snapshot → peer CLOBBERED  → RED here.
 *   - POST-FIX (re-stat):    _save_team detects it no longer owns the lock → raises → peer SURVIVES → GREEN.
 *
 * Marked RED-pending until the re-stat guard lands; it is the acceptance test for that patch.
 *
 * Run: PYTHON=/opt/cc2cc/venv/bin/python3 node --test tests/test_qa_lock_restat.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const PYBIN = process.env.PYTHON || "/opt/cc2cc/venv/bin/python3";
const MAX_HOLD_MS = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (bridge) => ({ ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_LOCK_MAX_HOLD_MS: String(MAX_HOLD_MS) });

function seed(bridge) {
  mkdirSync(join(bridge, "identities"), { recursive: true });
  writeFileSync(join(bridge, "teams.json"), JSON.stringify({ teams: {
    teamA: { name: "teamA", owner_machine: "local", leader: "boss",
      admitted: ["boss"], revoked: [], rules: { retention_days: 4, admission: "open", sticky_leader: true } },
  }}));
  for (const n of ["boss", "holder", "peer"]) {
    writeFileSync(join(bridge, "identities", `identity-${n}.json`),
      JSON.stringify({ display_name: n, agent_id: `id-${n}`, created: "2026-01-01T00:00:00Z", teams: ["teamA"] }));
  }
}

// Holder: REAL teams_lock + REAL _save_team, with an injected mid-section freeze that outlives max_hold
// so its lock is stolen. Prints exactly how the save resolved: ABORTED_LOUD (fixed) vs WROTE (pre-fix).
function startHolder(bridge, freezeMs) {
  const code = `
import sys, os, time
sys.path.insert(0, ${JSON.stringify(REPO)})
from pathlib import Path
from cc2cc.admin import teams_lock, _load_team, _save_team
ready = Path(os.environ["CC2CC_BRIDGE_DIR"]) / "_holder_ready"
with teams_lock():
    team = _load_team("teamA")                 # READ S0 (boss only)
    ready.write_text("1")
    time.sleep(${freezeMs / 1000})              # descheduled past max_hold -> lock gets stolen
    if "holder" not in team["admitted"]: team["admitted"].append("holder")
    try:
        _save_team(team)                        # POST-FIX: re-stat -> not ours -> raise
        print("WROTE", flush=True)              # PRE-FIX: silent clobber of the thief
    except (RuntimeError, OSError) as e:
        print("ABORTED_LOUD:" + str(e), flush=True)
`;
  return spawn(PYBIN, ["-c", code], { env: env(bridge), stdio: ["ignore", "pipe", "ignore"] });
}

function runPeer(bridge) {
  return spawnSync(PYBIN, ["-c",
    `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\n` +
    `from cc2cc import admin\n` +
    `class A: pass\n` +
    `a=A(); a.name="teamA"; a.agent="peer"\n` +
    `admin.cmd_team_admit(a)\n`],
    { env: env(bridge), cwd: REPO, encoding: "utf8" });
}

async function waitReady(bridge, ms = 4000) {
  const marker = join(bridge, "_holder_ready");
  for (let t = 0; t < ms; t += 25) { try { statSync(marker); return true; } catch {} await sleep(25); }
  return false;
}
const admittedOf = (bridge) =>
  new Set(JSON.parse(readFileSync(join(bridge, "teams.json"), "utf8")).teams.teamA.admitted);

test("re-stat guard: a holder whose lock was stolen ABORTS LOUD and does NOT clobber the thief", async () => {
  const bridge = mkdtempSync(join(tmpdir(), "cc2cc-qa-restat-"));
  try {
    seed(bridge);
    const holder = startHolder(bridge, MAX_HOLD_MS * 2.5);   // 2s freeze > 800ms max_hold
    let out = "";
    holder.stdout.on("data", (d) => (out += d));
    assert.ok(await waitReady(bridge), "holder took the lock and read S0");

    await sleep(MAX_HOLD_MS + 250);                          // let the lock age past max_hold
    const peer = runPeer(bridge);                            // steals the stale lock, admits "peer"
    assert.equal(peer.status, 0, `peer should steal + admit, got ${peer.stderr}${peer.stdout}`);
    assert.ok(admittedOf(bridge).has("peer"), "peer wrote its admit after stealing");

    await new Promise((res) => holder.on("close", res));     // holder resumes → save path runs

    // ACCEPTANCE (RED until the re-stat guard lands):
    assert.match(out.trim(), /^ABORTED_LOUD/,
      `holder must FAIL LOUD when it no longer owns the lock (got: ${JSON.stringify(out.trim())}). ` +
      `Pre-fix it prints WROTE and silently clobbers the thief.`);
    assert.ok(admittedOf(bridge).has("peer"),
      "peer's admit must SURVIVE — the stolen-from holder aborted instead of overwriting");
  } finally {
    try { rmSync(bridge, { recursive: true, force: true }); } catch {}
  }
});

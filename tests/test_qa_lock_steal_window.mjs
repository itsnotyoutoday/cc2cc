/**
 * QA stress test B (rlead / independent QA) — CHARACTERIZATION of the teams.json lock STEAL WINDOW.
 *
 * The lock breaks a held lock when the holder looks dead: either its pid is gone, OR its on-disk ts
 * has aged past max_hold (admin.py teams_lock / server.mjs acquireTeamsLock). Time-based staleness
 * cannot distinguish a CRASHED holder from a LIVE-but-descheduled one. So a theoretical clobber
 * exists: if a healthy holder is frozen mid-section (between its read and its write) for LONGER than
 * max_hold, a peer judges it stale, steals the lock, and writes — then the original holder resumes
 * and writes its STALE in-memory state, clobbering the peer's update.
 *
 * superbad (dev) bumped max_hold 10s→30s and asked for a data-backed answer: is 30s enough, or do we
 * need native flock(2)? These tests pin the EXACT precondition by shrinking max_hold via the env
 * override (CC2CC_LOCK_MAX_HOLD_MS) so the window is reproducible in <1s instead of 30s:
 *
 *   SAFE  — holder descheduled LESS than max_hold: the peer WAITS (no steal); both updates land.
 *           This is the normal case — any realistic deschedule is far under max_hold.
 *   RACE  — holder descheduled LONGER than max_hold: the peer STEALS; the resuming holder clobbers
 *           the peer. This documents the failure mode AND its precondition (a healthy process frozen
 *           mid-critical-section for > max_hold). At the prod default of 30s that requires a 30s+
 *           mid-section stall — see the recommendation in the test footer.
 *
 * Both writers use the REAL teams_lock() context manager under test; only an injected mid-section
 * sleep (the "deschedule") is synthetic. Python-only: the lock protocol is shared cross-language, so
 * the steal THRESHOLD is language-independent (cross-language interop is covered by test_qa_lock_cross).
 *
 * Run: PYTHON=/opt/cc2cc/venv/bin/python3 node --test tests/test_qa_lock_steal_window.mjs
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const PYBIN = process.env.PYTHON || "/opt/cc2cc/venv/bin/python3";
const MAX_HOLD_MS = 800;          // shrunk so the window is reproducible in <1s (prod default: 30000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed(bridge) {
  await mkdir(join(bridge, "identities"), { recursive: true });
  await writeFile(join(bridge, "teams.json"), JSON.stringify({ teams: {
    teamA: { name: "teamA", owner_machine: "local", leader: "boss",
      admitted: ["boss"], revoked: [], rules: { retention_days: 4, admission: "open", sticky_leader: true } },
  }}));
  for (const n of ["boss", "holder", "peer"]) {
    await writeFile(join(bridge, "identities", `identity-${n}.json`),
      JSON.stringify({ display_name: n, agent_id: `id-${n}`, created: "2026-01-01T00:00:00Z", teams: ["teamA"] }));
  }
}

/**
 * Holder: takes the REAL lock, reads the roster, signals "ready", then is "descheduled" for freezeMs
 * (its on-disk ts ages during this sleep), then merges itself and writes — mirroring exactly what
 * with_teams_lock(fn) does, but with an injected mid-section stall.
 */
function startHolder(bridge, freezeMs) {
  const code = `
import sys, os, json, time
sys.path.insert(0, ${JSON.stringify(REPO)})
from pathlib import Path
from cc2cc.admin import teams_lock, _teams_path
ready = Path(os.environ["CC2CC_BRIDGE_DIR"]) / "_holder_ready"
with teams_lock():
    p = _teams_path()
    data = json.loads(p.read_text())            # READ (state S0)
    ready.write_text("1")                        # lock held + read done
    time.sleep(${freezeMs / 1000})               # "descheduled" mid-section; ts ages here
    adm = data["teams"]["teamA"]["admitted"]
    if "holder" not in adm: adm.append("holder")
    p.write_text(json.dumps(data))               # WRITE stale S0+holder (no peer it never saw)
`;
  return spawn(PYBIN, ["-c", code],
    { env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_LOCK_MAX_HOLD_MS: String(MAX_HOLD_MS) }, stdio: "ignore" });
}

/** Peer: a real cmd_team_admit("peer"), same shrunk max_hold. Returns {status, stderr}. */
function runPeer(bridge) {
  const r = spawnSync(PYBIN, ["-c",
    `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\n` +
    `from cc2cc import admin\n` +
    `class A: pass\n` +
    `a=A(); a.name="teamA"; a.agent="peer"\n` +
    `admin.cmd_team_admit(a)\n`],
    { env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_LOCK_MAX_HOLD_MS: String(MAX_HOLD_MS) },
      cwd: REPO, encoding: "utf8" });
  return { status: r.status, stderr: (r.stderr || "") + (r.stdout || "") };
}

async function waitForReady(bridge, ms = 4000) {
  const marker = join(bridge, "_holder_ready");
  for (let t = 0; t < ms; t += 25) { try { await stat(marker); return true; } catch {} await sleep(25); }
  return false;
}
const admittedOf = async (bridge) =>
  new Set(JSON.parse(await readFile(join(bridge, "teams.json"), "utf8")).teams.teamA.admitted);

describe("QA stress B: teams.json lock steal-window characterization", () => {
  const bridges = [];
  after(async () => { for (const b of bridges) { try { await rm(b, { recursive: true, force: true }); } catch {} } });

  it("SAFE: a holder descheduled UNDER max_hold is not stolen — peer waits, both updates land", async () => {
    const bridge = await mkdtemp(join(tmpdir(), "cc2cc-qa-steal-safe-")); bridges.push(bridge);
    await seed(bridge);

    const holder = startHolder(bridge, MAX_HOLD_MS * 0.4);   // 320ms freeze < 800ms max_hold
    assert.ok(await waitForReady(bridge), "holder acquired the lock and read");
    await sleep(60);                                          // peer arrives early, while the holder still holds
    const peer = runPeer(bridge);                            // age << max_hold → WAIT (no steal), then acquire
    await new Promise((res) => holder.on("close", res));

    assert.equal(peer.status, 0, `peer should have waited then succeeded, got exit=${peer.status} ${peer.stderr}`);
    const adm = await admittedOf(bridge);
    assert.ok(adm.has("holder"), "holder's update present");
    assert.ok(adm.has("peer"), "peer's update present (no clobber — peer waited for the lock)");
  });

  it("RACE: a holder descheduled PAST max_hold IS stolen — resuming holder clobbers the peer", async () => {
    const bridge = await mkdtemp(join(tmpdir(), "cc2cc-qa-steal-race-")); bridges.push(bridge);
    await seed(bridge);

    const holder = startHolder(bridge, MAX_HOLD_MS * 2.5);   // 2000ms freeze > 800ms max_hold
    assert.ok(await waitForReady(bridge), "holder acquired the lock and read");
    await sleep(MAX_HOLD_MS + 250);                          // let the lock age PAST max_hold before the peer arrives
    const peer = runPeer(bridge);                            // age > max_hold + holder pid alive → STEAL + write peer
    assert.equal(peer.status, 0, `peer should have stolen the stale lock and succeeded, got ${peer.stderr}`);

    const afterPeer = await admittedOf(bridge);
    assert.ok(afterPeer.has("peer"), "peer wrote its update after stealing the (aged) lock");

    await new Promise((res) => holder.on("close", res));     // holder resumes and writes its STALE snapshot
    const final = await admittedOf(bridge);

    // The characterized failure: the resuming holder's stale write erased the peer's admit.
    assert.ok(final.has("holder"), "holder wrote its (stale) snapshot on resume");
    assert.ok(!final.has("peer"),
      "EXPECTED CLOBBER: holder frozen > max_hold lost its lock, then overwrote the peer's update");
  });
});

/*
 * ── RECOMMENDATION (rlead/QA): 30s max_hold vs native flock(2) ──────────────────────────────────
 * The clobber requires ONE precondition: a process holding the lock is frozen BETWEEN its read and
 * its write for longer than max_hold. The real critical section here is a single small-file
 * read-merge-write — sub-millisecond. For the window to open at max_hold=30s, the OS would have to
 * deschedule a runnable process mid-section for 30+ CONTIGUOUS seconds. That does not happen under
 * normal load, container CPU throttling, or moderate swap; it needs near-total starvation (e.g. a
 * fork-bomb / OOM thrash) — in which the whole mesh is already failing. So 30s is comfortably enough:
 * the window is ~6 orders of magnitude larger than the section it guards.
 *
 * flock(2) (advisory kernel locks) WOULD eliminate the window entirely — the lock dies with the fd, so
 * there is no time-based steal heuristic to race. But cc2cc's zero-build-toolchain / no-compiled-deps
 * install is load-bearing (pure-Python + Node, pip/npm with no build step). flock via Python is stdlib
 * (fcntl), but the Node side has no stdlib flock — it needs a native addon or an FFI shim, reintroducing
 * exactly the compiled-dependency cost the project avoids, AND flock semantics over NFS/9p/some overlay
 * FS are unreliable, whereas the current hardlink+ts protocol is portable.
 *
 * VERDICT: keep the ts-based lock at max_hold=30s — do NOT take on flock(2)'s compiled-dep cost to close
 * a window that only opens when the host is already in catastrophic starvation. Cheap belt-and-suspenders
 * if desired: have the holder re-stat its own lock immediately before the final write and abort-loud if it
 * no longer owns it (turns the silent clobber into a fail-loud retry) — pure userspace, no new deps. I can
 * write that test + hand the one-liner to superbad if we want defense-in-depth.
 */

/**
 * QA (adversarial): EXIT-PATH PERMS.
 *
 * GOAL: verify the synchronous process.on('exit') unclean-path heartbeat ends up group-rw (0660).
 *
 * REACHABILITY FINDING (see notes at bottom): the unclean exit handler is effectively UNREACHABLE
 * on Linux via normal client/parent termination. Empirically (this file + sibling probes):
 *   - SIGINT/SIGTERM     -> handlers set cleanShutdown=true -> the CLEAN shutdown() path, not this one.
 *   - SIGKILL            -> exit handler is skipped by the OS entirely (no JS runs).
 *   - SIGHUP/SIGQUIT/SIGPIPE (no listener) -> Node default-terminates WITHOUT running 'exit'.
 *   - stdin EOF / parent-gone -> the server's polling setInterval/setTimeout keep the event loop
 *     ALIVE, so it never drains -> 'exit' never fires. (StdioServerTransport doesn't listen for
 *     stdin 'end'/'close', so EOF is a no-op.)
 * So in practice this branch only runs on an in-process process.exit() while cleanShutdown=false &&
 * agentName set -- a state no live code path reaches post-activation.
 *
 * Test 1 (PROXY, runnable): execute the EXACT 3-statement handler body (writeFileSync -> chmodSync
 *   0o660) under the same root-style umask and assert the file lands at 0660 -- this is what the
 *   reviewer asked to verify ("does the file end up group-rw"). Verbatim from server.mjs ~2005-2021.
 * Test 2 (END-TO-END, best-effort): try to actually drive the live subprocess into the handler; if
 *   it cannot be triggered (the expected result given the finding above), the test records that the
 *   path is unreachable rather than silently passing.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, stat, readFile } from "node:fs/promises";
import { writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("QA: exit-path heartbeat perms", () => {
  let bridge;
  after(async () => { if (bridge) await rm(bridge, { recursive: true, force: true }); });

  it("PROXY: exit-handler body (writeFileSync->chmodSync 0o660) yields 0660 even under umask 022", async () => {
    bridge = await mkdtemp(join(tmpdir(), "cc2cc-qa-perms-"));
    const sdir = join(bridge, "status");
    await mkdir(sdir, { recursive: true });
    const prev = process.umask(0o022); // emulate root's default umask, which masks writeFileSync {mode}
    try {
      const hbPath = join(sdir, "exiter-heartbeat.json");
      // ── verbatim handler body (server.mjs ~2005-2021) ──
      writeFileSync(hbPath, JSON.stringify({
        agent: "exiter", timestamp: new Date().toISOString(), heartbeat: new Date().toISOString(),
        status: "offline", status_text: "Session ended", context: "process exit (unclean)",
      }, null, 2));
      chmodSync(hbPath, 0o660);
      // ───────────────────────────────────────────────────
      const m = (await stat(hbPath)).mode & 0o777;
      assert.equal(m, 0o660, `chmodSync must force 0660 regardless of umask; got ${m.toString(8)}`);

      // Counter-proof: WITHOUT the chmodSync, umask 022 leaves it 0644 -> the bug the fix prevents.
      const noChmod = join(sdir, "nochmod.json");
      writeFileSync(noChmod, "{}", { mode: 0o660 });
      const m2 = (await stat(noChmod)).mode & 0o777;
      assert.equal(m2, 0o640, `umask 022 masks {mode:0660} group-w -> 0640 (demonstrates why chmodSync is needed); got ${m2.toString(8)}`);
    } finally {
      process.umask(prev);
    }
  });

  it("END-TO-END: documents that the unclean 'exit' path is not reachable via signals/EOF", async () => {
    const b2 = await mkdtemp(join(tmpdir(), "cc2cc-qa-perms2-"));
    try {
      await mkdir(join(b2, "identities"), { recursive: true });
      await writeFile(join(b2, "identities", "identity-exiter.json"),
        JSON.stringify({ display_name: "exiter", agent_id: "id-x", created: "2026-01-01T00:00:00Z", teams: ["solo"], role: "member" }));
      const transport = new StdioClientTransport({
        command: "node", args: [SERVER],
        env: { ...process.env, CC2CC_BRIDGE_DIR: b2, CC2CC_IDENTITY: "exiter" }, stderr: "ignore",
      });
      const client = new Client({ name: "qa", version: "0" }, { capabilities: {} });
      await client.connect(transport);
      const pid = transport.pid;
      await sleep(2500);
      const hbPath = join(b2, "status", "exiter-heartbeat.json");
      const beforeCtx = JSON.parse(await readFile(hbPath, "utf8")).context;
      assert.equal((await stat(hbPath)).mode & 0o777, 0o660, "active heartbeat is 0660 (atomicWrite)");

      // SIGHUP: no listener -> default-terminate, 'exit' must NOT run -> context unchanged.
      try { process.kill(pid, "SIGHUP"); } catch {}
      await sleep(1500);
      let afterCtx = null, gone = false;
      try { afterCtx = JSON.parse(await readFile(hbPath, "utf8")).context; } catch { gone = true; }
      try { process.kill(pid, "SIGKILL"); } catch {}
      try { await client.close(); } catch {}

      // The unclean path did NOT run: the file is untouched ("session started"), not "process exit (unclean)".
      assert.notEqual(afterCtx, "process exit (unclean)",
        "EXPECTED: SIGHUP does not trigger the unclean exit handler (it is unreachable via signals)");
      assert.equal(afterCtx, beforeCtx, "heartbeat untouched after SIGHUP (no unclean-exit rewrite)");
    } finally {
      await rm(b2, { recursive: true, force: true });
    }
  });
});

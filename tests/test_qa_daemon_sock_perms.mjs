/**
 * QA (rlead) — daemon.sock permission regression. Reported by nexus-coord: the daemon creates
 * <bridge>/daemon.sock without setting its mode, so the mode is inherited from the LAUNCHER'S UMASK.
 * A unix-socket CONNECT requires WRITE permission, so under a restrictive umask (022 → 755) a
 * group-member MCP gets EACCES on connect() and silently falls back to the 3s inbox poll — losing
 * real-time daemon-push wakes with no error surfaced.
 *
 * Root cause (QA-confirmed): umask-dependent, not a fixed 755. umask 002 → 775 (group-writable, works);
 * umask 022 → 755 (group can't connect). The production/systemd launcher runs umask 022, so the wake
 * path was silently degraded there while interactive-shell daemons happened to work — exactly the kind
 * of intermittent masking that hides for a long time.
 *
 * Contract under test (nexus-coord's proposed fix, to land in channel/daemon.mjs after server.listen()):
 * chmod the socket to 0o770 explicitly — group may connect (rwx incl. WRITE), world has NO access to
 * the wake channel — REGARDLESS of the launcher umask.
 *
 * This test spawns the daemon in a child process under the hostile umask 022 and asserts the socket is
 * 0o770. It is RED on the pre-fix code (755) and GREEN once the explicit chmod lands.
 *
 * Run: node --test tests/test_qa_daemon_sock_perms.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, "..", "channel", "daemon.mjs");

// Bring up the daemon in a CHILD process under a given umask, return the socket's mode (octal string).
// A child (not this process) is used so the umask change is isolated and faithful to a real launch.
function socketModeUnderUmask(umaskOctal) {
  const bridge = mkdtempSync(join(tmpdir(), "cc2cc-sockperm-"));
  const child = spawnSync(process.execPath, ["-e", `
    process.umask(${umaskOctal});
    import(${JSON.stringify(DAEMON)}).then(async (d) => {
      const { statSync } = await import("fs");
      const { join } = await import("path");
      const h = await d.main({ bridgeDir: ${JSON.stringify(bridge)}, team: null, self: null });
      const mode = statSync(join(${JSON.stringify(bridge)}, "daemon.sock")).mode & 0o777;
      process.stdout.write("MODE:" + mode.toString(8));
      await h.stop();
      process.exit(0);
    }).catch((e) => { process.stdout.write("ERR:" + e.message); process.exit(1); });
  `], { encoding: "utf8" });
  try { rmSync(bridge, { recursive: true, force: true }); } catch {}
  const m = (child.stdout || "").match(/MODE:(\d+)/);
  if (!m) throw new Error(`daemon child did not report a socket mode: ${child.stdout} ${child.stderr}`);
  return m[1];
}

test("daemon.sock is group-connectable (0o770) even under a restrictive umask (022)", () => {
  // umask 022 is the production/systemd launch case that produced 755 → group EACCES on connect.
  const mode = socketModeUnderUmask("0o022");
  const octal = parseInt(mode, 8);

  assert.ok(octal & 0o020,
    `daemon.sock must be GROUP-WRITABLE so co-group MCPs can connect() for real-time wakes; got 0${mode} ` +
    `(pre-fix: umask 022 yields 0755 and group members fall back to poll). Fix: chmod 0o770 after listen().`);
  assert.equal(octal & 0o007, 0,
    `daemon.sock must NOT be world-accessible (the wake channel is group-scoped); got 0${mode}`);
  assert.equal(mode, "770",
    `expected exactly 0o770 (owner+group rwx, no other) per the agreed fix; got 0${mode}`);
});

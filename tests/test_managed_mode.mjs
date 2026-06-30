/** Managed (global/system) bridge: per-user sessions must not spawn/heal their own daemon, and the
 *  daemon refuses to bind when run by the wrong user. Guards against a session hijacking the shared
 *  system daemon. */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CH = join(dirname(fileURLToPath(import.meta.url)), "..", "channel");
const { readServiceMarker, daemonOwnershipCheck, daemonSocketPath } = await import(join(CH, "daemon.mjs"));
const { ensureDaemon } = await import(join(CH, "daemon-client.mjs"));

async function bridge(managed) {
  const b = await mkdtemp(join(tmpdir(), "cc2cc-mm-"));
  if (managed) await writeFile(join(b, "service.json"), JSON.stringify({ managed: true, service_user: "cc2cc" }));
  return b;
}

describe("managed bridge", () => {
  const dirs = [];
  after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

  it("readServiceMarker: null when unmarked, marker when managed", async () => {
    const plain = await bridge(false); dirs.push(plain);
    const mgd = await bridge(true); dirs.push(mgd);
    assert.equal(readServiceMarker(plain), null);
    assert.equal(readServiceMarker(mgd)?.managed, true);
  });

  it("daemonOwnershipCheck: unmanaged always ok; managed ok for the bridge owner (this process)", async () => {
    const plain = await bridge(false); dirs.push(plain);
    const mgd = await bridge(true); dirs.push(mgd);
    assert.equal(daemonOwnershipCheck(plain).ok, true);
    // The test process created (owns) mgd, so as its owner it's allowed — exercises the uid-match path.
    assert.equal(daemonOwnershipCheck(mgd).ok, true);
  });

  it("ensureDaemon({managed:true}) does NOT spawn a daemon when none is running", async () => {
    const mgd = await bridge(true); dirs.push(mgd);
    const res = await ensureDaemon({ bridgeDir: mgd, managed: true, waitMs: 500 });
    assert.equal(res.launched, false, "must not launch on a managed bridge");
    assert.equal(res.managed, true);
    // No socket should have been created by us.
    assert.equal(existsSync(daemonSocketPath(mgd)), false, "no daemon.sock should be created");
  });
});

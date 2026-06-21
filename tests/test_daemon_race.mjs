/**
 * M6: the single-instance daemon socket is race-safe (bind-first, no TOCTOU).
 *  1. Concurrent main() racers on one bridge → exactly ONE owns the socket; the rest bow
 *     out (null). No orphan binder.
 *  2. A stale socket FILE (crashed daemon, nothing listening) is reclaimed by a fresh daemon.
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Static import — daemon.mjs guards main() on argv, so importing won't auto-run it.
import * as mod from "../channel/daemon.mjs";

const freshBridge = () => mkdtempSync(join(tmpdir(), "cc2cc-race-"));
// team:null keeps the relay idle (no network) — we only exercise the socket bind path.
const cfg = (bridge) => ({ bridgeDir: bridge, team: null, self: null });

test("M6: concurrent racers — exactly one binds the socket, the rest bow out", async () => {
  const bridge = freshBridge();
  // Fire several main() calls in the same tick to contend for the bind.
  const results = await Promise.all([mod.main(cfg(bridge)), mod.main(cfg(bridge)), mod.main(cfg(bridge))]);
  const winners = results.filter((r) => r !== null);
  const losers = results.filter((r) => r === null);
  try {
    assert.strictEqual(winners.length, 1, "exactly one daemon owns the socket");
    assert.strictEqual(losers.length, 2, "the other racers detect the bind and bow out");
    assert.ok(existsSync(winners[0].socketPath), "the winner's socket exists");
  } finally {
    for (const w of winners) { try { await w.stop(); } catch {} }
  }
});

test("M6: a stale socket file with no listener is reclaimed", async () => {
  const bridge = freshBridge();
  const sockPath = mod.daemonSocketPath(bridge);
  writeFileSync(sockPath, ""); // simulate a crashed daemon's leftover socket path (dead)
  const handle = await mod.main(cfg(bridge));
  try {
    assert.ok(handle, "a fresh daemon probes the dead socket, unlinks it, and binds");
    assert.strictEqual(handle.socketPath, sockPath);
  } finally {
    try { await handle?.stop(); } catch {}
  }
});

/**
 * QA (adversarial): offlineAfterS()/heartbeatMs() math — UNIT-LEVEL PROXY.
 *
 * offlineAfterS / heartbeatMs are module-private (not exported) in channel/server.mjs, so
 * these are duplicated VERBATIM from the source (server.mjs lines ~404-411) and tested as a
 * proxy. The end-to-end reload behavior is covered separately in test_qa_behavior_reload.mjs.
 * If the source formula changes, this duplication must be re-synced (intentionally brittle).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const HEARTBEAT_STALE_S = 15; // server.mjs:42

// ── verbatim copies ──
function makeOfflineAfterS(policy) {
  const v = policy?.identities?.offline_after_seconds;
  return Number.isFinite(v) && v > 0 ? v : HEARTBEAT_STALE_S;
}
function makeHeartbeatMs(policy) {
  return Math.max(1000, Math.floor((makeOfflineAfterS(policy) * 1000) / 3));
}

describe("QA: offlineAfterS fallback", () => {
  const cases = [
    ["missing policy", undefined, HEARTBEAT_STALE_S],
    ["null policy", null, HEARTBEAT_STALE_S],
    ["no identities", {}, HEARTBEAT_STALE_S],
    ["empty identities", { identities: {} }, HEARTBEAT_STALE_S],
    ["NaN", { identities: { offline_after_seconds: NaN } }, HEARTBEAT_STALE_S],
    ["string", { identities: { offline_after_seconds: "30" } }, HEARTBEAT_STALE_S],
    ["zero", { identities: { offline_after_seconds: 0 } }, HEARTBEAT_STALE_S],
    ["negative", { identities: { offline_after_seconds: -5 } }, HEARTBEAT_STALE_S],
    ["Infinity", { identities: { offline_after_seconds: Infinity } }, HEARTBEAT_STALE_S],
    ["null value", { identities: { offline_after_seconds: null } }, HEARTBEAT_STALE_S],
    ["valid 60", { identities: { offline_after_seconds: 60 } }, 60],
    ["valid 1", { identities: { offline_after_seconds: 1 } }, 1],
    ["fractional 7.5", { identities: { offline_after_seconds: 7.5 } }, 7.5],
  ];
  for (const [label, pol, expect] of cases) {
    it(`${label} -> ${expect}`, () => {
      assert.equal(makeOfflineAfterS(pol), expect);
    });
  }
});

describe("QA: heartbeatMs invariants", () => {
  it("never below 1000ms floor (small windows)", () => {
    for (const w of [1, 2, 3, 14]) {
      const ms = makeHeartbeatMs({ identities: { offline_after_seconds: w } });
      assert.ok(ms >= 1000, `window ${w}s -> ${ms}ms must be >= 1000`);
    }
  });
  it("never NaN / 0 / negative under any garbage policy (no busy-loop)", () => {
    for (const v of [NaN, 0, -100, "x", null, undefined, Infinity]) {
      const ms = makeHeartbeatMs({ identities: { offline_after_seconds: v } });
      assert.ok(Number.isFinite(ms) && ms >= 1000, `garbage ${String(v)} -> ${ms} must be finite >=1000`);
    }
  });
  it("~3 writes per window for typical values", () => {
    assert.equal(makeHeartbeatMs({ identities: { offline_after_seconds: 15 } }), 5000); // 15000/3
    assert.equal(makeHeartbeatMs({ identities: { offline_after_seconds: 60 } }), 20000);
    assert.equal(makeHeartbeatMs({ identities: { offline_after_seconds: 90 } }), 30000);
  });
  it("default (no policy) gives 5000ms = old HEARTBEAT_INTERVAL_MS", () => {
    // Regression: old hardcoded HEARTBEAT_INTERVAL_MS was 5000. Default window 15s/3 = 5000.
    assert.equal(makeHeartbeatMs(undefined), 5000);
  });
  it("write cadence is strictly < staleness window (so >=2 writes fit before stale)", () => {
    for (const w of [15, 30, 60, 120]) {
      const ms = makeHeartbeatMs({ identities: { offline_after_seconds: w } });
      assert.ok(ms < w * 1000, `cadence ${ms}ms must be < window ${w * 1000}ms`);
    }
  });
});

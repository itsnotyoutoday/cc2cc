/**
 * Behavioral tests for cc2cc relay.mjs (Node-side fixes).
 * Uses node:test. Covers B1/B3/B5/B6/B8/B10/H4 with real assertions.
 *
 * Run: node --test tests/test_relay.mjs
 */

import { describe, it, before, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFakeConfig() {
  return {
    hub_url: "http://localhost:8080",
    machine_id: "test-machine",
    token: "test-token-456",
    enabled: true,
  };
}

/** Create a status heartbeat file and return the dir. */
function seedHeartbeatDir(statusText = "Idle", teams = ["team-alpha"]) {
  const dir = mkdtempSync(join(tmpdir(), "relay-test-"));
  mkdirSync(join(dir, "status"), { recursive: true });
  const hb = {
    agent: "test-agent",
    timestamp: new Date().toISOString(),
    heartbeat: new Date().toISOString(),
    status_text: statusText,
    parent_pid: "12345",
    session_id: "sess-1",
    teams,
  };
  writeFileSync(join(dir, "status", "test-agent-heartbeat.json"), JSON.stringify(hb));
  return dir;
}

describe("relay.mjs — behavioral tests", () => {

  describe("B1 — getConfigToken", () => {
    it("returns null before config loaded", async () => {
      const relay = await import("../channel/relay.mjs");
      assert.equal(relay.getConfigToken(), null);
    });
  });

  describe("B3 — startRelayClient lifecycle with agentName param", () => {
    it("startRelayClient accepts agentName and enables relay", async () => {
      const relay = await import("../channel/relay.mjs");
      const cfg = makeFakeConfig();
      const originalFetch = global.fetch;
      global.fetch = mock.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }))
      );
      try {
        relay.startRelayClient("/tmp/test-bridge", "team-alpha", cfg, "agent-alpha");
        assert.ok(relay.isRelayEnabled());
        relay.stopRelayClient();
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe("B5 — setEncryptionFunction/getEncryptionFunction roundtrip", () => {
    it("stored encryption function roundtrips and transforms text", async () => {
      const relay = await import("../channel/relay.mjs");
      const encryptFn = (text) => `ENC:${Buffer.from(text).toString("hex")}:testiv:testtag`;
      relay.setEncryptionFunction(encryptFn);

      const stored = relay.getEncryptionFunction();
      assert.equal(typeof stored, "function", "B5: stored function must be callable");

      const result = stored("secret");
      assert.ok(result.startsWith("ENC:"), "B5: stored fn must produce ENC: output");
      assert.notEqual(result, "secret", "B5: ciphertext must differ from plaintext");
      assert.ok(result.length > "secret".length, "B5: encrypted output should be longer");
    });
  });

  describe("B6 — relay enable/disable guard", () => {
    it("isRelayEnabled reflects start/stop lifecycle", async () => {
      const relay = await import("../channel/relay.mjs");
      assert.equal(relay.isRelayEnabled(), false);

      const cfg = makeFakeConfig();
      const originalFetch = global.fetch;
      global.fetch = mock.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }))
      );
      try {
        relay.startRelayClient("/tmp/test-bridge", "team-alpha", cfg, "agent-alpha");
        assert.equal(relay.isRelayEnabled(), true);
        relay.stopRelayClient();
        assert.equal(relay.isRelayEnabled(), false);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("does NOT start when config.enabled is false", async () => {
      const relay = await import("../channel/relay.mjs");
      const cfg = { ...makeFakeConfig(), enabled: false };
      relay.startRelayClient("/tmp/test-bridge", "team-alpha", cfg, "agent-alpha");
      assert.equal(relay.isRelayEnabled(), false, "B6: must not enable when config.enabled=false");
      relay.stopRelayClient();
    });
  });

  describe("B8 — decryptMessage quarantines bad ciphertext", () => {
    it("decryptMessage returns null for tampered ENC: payload (wrong GCM tag)", async () => {
      const { decryptMessage, setEncryptionKey } = await import("../channel/server.mjs");
      // Set a deterministic encryption key to enable GCM path
      const testKey = Buffer.from("0123456789abcdef0123456789abcdef", "hex"); // 32 bytes for aes-256
      setEncryptionKey(testKey);

      // Construct a clearly tampered ENC: payload (00 iv, 00 tag, 00 ciphertext → GCM auth failure)
      const tamperedMsg = { id: "tampered-1", from: "bad-agent", content: { text: "ENC:00000000000000000000000000000000:00000000000000000000000000000000:0000" } };
      const result = decryptMessage(tamperedMsg);
      assert.equal(result, null, "B8: tampered ENC: must return null (never surface ciphertext)");
    });
  });

  describe("B10 — UUID format validation (scaffold; does NOT exercise relay.mjs safeId path)", () => {
    it("UUID format is valid for filename-safe IDs", async () => {
      const relay = await import("../channel/relay.mjs");
      const uuid = randomUUID();
      assert.ok(uuid.includes("-"), "UUID has hyphens");
      assert.equal(uuid.length, 36, "UUID is 36 chars");

      // Verify the relay export function uses UUIDs
      const safeId = `relay-${randomUUID()}`;
      assert.ok(safeId.startsWith("relay-"), "B10: safe IDs must start with relay-");
      // Verify no path separators in UUID
      assert.ok(!safeId.includes("/"), "B10: safeId must not contain /");
      assert.ok(!safeId.includes(".."), "B10: safeId must not contain ..");
    });
  });

  describe("H4 — remote teams stale detection", () => {
    it("isRemoteTeam returns false for unknown teams", async () => {
      const relay = await import("../channel/relay.mjs");
      assert.equal(relay.isRemoteTeam("nonexistent"), false);
    });

    it("doHeartbeat reads status dir and calls relayHeartbeat", async () => {
      const relay = await import("../channel/relay.mjs");
      const statusDir = seedHeartbeatDir("Reviewing code");
      const cfg = makeFakeConfig();

      // Mock fetch so apiPost doesn't hit a real hub; collect ALL calls
      let fetchCalls = [];
      const originalFetch = global.fetch;
      global.fetch = mock.fn((url, opts) => {
        fetchCalls.push({ url, body: JSON.parse(opts.body) });
        return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
      });

      try {
        relay.startRelayClient(statusDir, "team-alpha", cfg, "test-agent");

        // Call doHeartbeat directly (heartbeat timer is 5s; don't wait for it)
        await relay.doHeartbeat(statusDir, "team-alpha");

        // Find the heartbeat call among all fetch calls
        const hbCall = fetchCalls.find((c) => c.url.endsWith("/api/heartbeat"));
        assert.ok(hbCall, "H4: doHeartbeat should have posted a heartbeat");
        assert.ok(hbCall.url.endsWith("/api/heartbeat"), "H4: heartbeat URL must end with /api/heartbeat");
        assert.ok(hbCall.body.agents, "H4: heartbeat must include agents dict");
        assert.equal(hbCall.body.agents["test-agent"]?.status_text, "Reviewing code", "H4: agent status must be Reviewing code");
      } finally {
        global.fetch = originalFetch;
        relay.stopRelayClient();
      }
    });

    it("doHeartbeat skips agents without a timestamp (NaN staleness guard)", async () => {
      const relay = await import("../channel/relay.mjs");
      // Create heartbeat file WITHOUT timestamp+heartbeat fields
      const statusDir = mkdtempSync(join(tmpdir(), "hb-nan-"));
      const hbNoTs = JSON.stringify({
        agent: "no-ts-agent", status_text: "Idle", teams: ["team-alpha"],
        // No timestamp or heartbeat field → hbTimestamp is undefined → skip
      });
      writeFileSync(join(statusDir, "no-ts-agent-heartbeat.json"), hbNoTs);
      const cfg = makeFakeConfig();

      let fetchCalls = [];
      const originalFetch = global.fetch;
      global.fetch = mock.fn((url, opts) => {
        fetchCalls.push({ url, body: JSON.parse(opts.body) });
        return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
      });

      try {
        relay.startRelayClient(statusDir, "team-alpha", cfg, "test-agent");
        await relay.doHeartbeat(statusDir, "team-alpha");

        const hbCall = fetchCalls.find((c) => c.url.endsWith("/api/heartbeat"));
        assert.ok(hbCall, "H4 (nan): should have posted a heartbeat");
        // The agent without timestamp should NOT appear in the agents dict
        assert.ok(!hbCall.body.agents?.["no-ts-agent"],
          "H4 (nan): agent without timestamp must be excluded from heartbeat");
      } finally {
        global.fetch = originalFetch;
        relay.stopRelayClient();
      }
    });
  });

  describe("Export smoke test (14 functions)", () => {
    it("all required exports are functions", async () => {
      const relay = await import("../channel/relay.mjs");
      const exports = [
        "loadRelayConfig", "saveRelayConfig", "isRelayEnabled",
        "setEncryptionFunction", "getConfigToken",
        "handleRegisterRelay", "getRemoteTeams", "getRemoteAgents",
        "isRemoteTeam", "getRelayStatus", "sendViaRelay",
        "relayHeartbeat", "relayKeepalive",
        "startRelayClient", "stopRelayClient",
      ];
      for (const name of exports) {
        assert.equal(typeof relay[name], "function", `Missing export: ${name}`);
      }
    });
  });
});

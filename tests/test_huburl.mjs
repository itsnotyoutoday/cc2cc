/**
 * buildHubUrl — hub base-URL resolution for proxied / path-prefixed deployments.
 * Covers the relay.example.com/bridge/cc2cc case: HTTPS + a path prefix that the reverse
 * proxy rewrites down to /api/* on localhost.
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildHubUrl, loadRelayConfig } from "../channel/relay.mjs";

const UNIFIED_KEYS = ["machine_id", "name", "self_type", "hub_url", "token", "hub_id", "enabled", "poll_interval_ms", "connections"];

test("buildHubUrl: full url field takes precedence (https + path prefix)", () => {
  const u = buildHubUrl({ url: "https://relay.example.com/bridge/cc2cc" });
  assert.strictEqual(u, "https://relay.example.com/bridge/cc2cc");
  // the call sites append /api/... → the proxied path the server expects
  assert.strictEqual(`${u}/api/register`, "https://relay.example.com/bridge/cc2cc/api/register");
});

test("buildHubUrl: trailing slashes stripped so no //api", () => {
  assert.strictEqual(buildHubUrl({ url: "https://x.dev/bridge/cc2cc/" }), "https://x.dev/bridge/cc2cc");
  assert.strictEqual(buildHubUrl({ url: "https://x.dev/bridge/cc2cc///" }), "https://x.dev/bridge/cc2cc");
});

test("buildHubUrl: scheme + base_path components", () => {
  assert.strictEqual(
    buildHubUrl({ scheme: "https", address: "relay.example.com", port: 443, base_path: "bridge/cc2cc" }),
    "https://relay.example.com:443/bridge/cc2cc"
  );
  assert.strictEqual(
    buildHubUrl({ scheme: "https", address: "h", port: 443, base_path: "/bridge/cc2cc/" }),
    "https://h:443/bridge/cc2cc"
  );
});

test("buildHubUrl: legacy host:port default (back-compat, http)", () => {
  assert.strictEqual(buildHubUrl({ address: "127.0.0.1", port: 10322 }), "http://127.0.0.1:10322");
});

test("buildHubUrl: null server → null", () => {
  assert.strictEqual(buildHubUrl(null), null);
});

// ── The merge: both config methodologies normalize to ONE identical shape ──
test("merge: connections.json and legacy relay.json yield the same unified shape", async () => {
  // connections.json (rich, proxied https + path prefix)
  const dirA = mkdtempSync(join(tmpdir(), "cc2cc-cfgA-"));
  writeFileSync(join(dirA, "connections.json"), JSON.stringify({
    self: { id: "m-1", name: "agent-coord", type: "client" },
    enabled: true,
    connections: [{ id: "primary-hub", type: "server", url: "https://relay.example.com/bridge/cc2cc/", token: "T", enabled: true }],
  }));
  const a = await loadRelayConfig(dirA);

  // legacy relay.json (flat single-hub)
  const dirB = mkdtempSync(join(tmpdir(), "cc2cc-cfgB-"));
  writeFileSync(join(dirB, "relay.json"), JSON.stringify({
    machine_id: "m-2", hub_url: "https://relay.example.com/bridge/cc2cc/", token: "T", enabled: true,
  }));
  const b = await loadRelayConfig(dirB);

  // Same keys, same hub resolution, and legacy gets a synthesized connections[] view.
  assert.deepStrictEqual(Object.keys(a).sort(), UNIFIED_KEYS.slice().sort());
  assert.deepStrictEqual(Object.keys(b).sort(), UNIFIED_KEYS.slice().sort());
  assert.strictEqual(a.hub_url, "https://relay.example.com/bridge/cc2cc");
  assert.strictEqual(b.hub_url, "https://relay.example.com/bridge/cc2cc"); // trailing slash stripped
  assert.strictEqual(a.enabled, true);
  assert.strictEqual(b.enabled, true);
  assert.ok(b.connections.length === 1 && b.connections[0].type === "server", "legacy synthesizes a server connection");
});

/** connections.json: per-instance identity (self.id/name) + connection registry → relay config. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const relay = await import(join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "relay.mjs"));

describe("connections.json + instance identity", () => {
  it("derives active hub + named identity from connections.json", async () => {
    const b = await mkdtemp(join(tmpdir(), "cc2cc-conn-"));
    await writeFile(join(b, "connections.json"), JSON.stringify({
      self: { id: "uuid-anna-1", name: "laptop-anna", type: "client" },
      connections: [
        { name: "ClawServer", type: "server", id: "srv-uuid", address: "10.0.0.5", port: 2231, token: "T0K" },
      ],
    }));
    const cfg = await relay.loadRelayConfig(b);
    assert.equal(cfg.machine_id, "uuid-anna-1", "self.id becomes the instance id");
    assert.equal(cfg.name, "laptop-anna");
    assert.equal(cfg.hub_url, "http://10.0.0.5:2231", "active hub from first server connection");
    assert.equal(cfg.token, "T0K");
    assert.equal(cfg.hub_id, "srv-uuid", "remote instance id captured");
    const st = relay.getRelayStatus();
    assert.equal(st.name, "laptop-anna");
    await rm(b, { recursive: true, force: true });
  });

  it("a pure server (no outbound server connection) has nothing to poll", async () => {
    const b = await mkdtemp(join(tmpdir(), "cc2cc-conn-srv-"));
    await writeFile(join(b, "connections.json"), JSON.stringify({
      self: { id: "uuid-srv", name: "ClawServer", type: "server", listen: { address: "0.0.0.0", port: 2231 } },
      connections: [],
    }));
    const cfg = await relay.loadRelayConfig(b);
    assert.equal(cfg.name, "ClawServer");
    assert.equal(cfg.enabled, false, "no outbound hub → relay client stays disabled");
    await rm(b, { recursive: true, force: true });
  });

  it("falls back to legacy relay.json", async () => {
    const b = await mkdtemp(join(tmpdir(), "cc2cc-conn-legacy-"));
    await writeFile(join(b, "relay.json"), JSON.stringify({ hub_url: "http://h:9", token: "x", machine_id: "m9", enabled: true }));
    const cfg = await relay.loadRelayConfig(b);
    assert.equal(cfg.machine_id, "m9");
    assert.equal(cfg.name, "m9", "name defaults to id when relay.json has none");
    assert.equal(cfg.hub_url, "http://h:9");
    await rm(b, { recursive: true, force: true });
  });
});

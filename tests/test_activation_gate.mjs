/**
 * 0f: mesh-join must be gated on a real MCP client completing the initialize handshake.
 * A bare `node server.mjs` (no Claude attached) must NOT mint a live account — otherwise it
 * registers/heartbeats and queues inbound it can never read (a phantom peer in the roster).
 *
 *   1. launched with CC2CC_IDENTITY but NO handshake → no identity is created (no phantom)
 *   2. after a real initialize + notifications/initialized handshake → it activates (identity created)
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);

const procs = [];
const bridges = [];
after(async () => {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
  for (const b of bridges) { try { await rm(b, { recursive: true, force: true }); } catch {} }
});

async function freshBridge() {
  const b = await mkdtemp(join(tmpdir(), "cc2cc-0f-"));
  await mkdir(join(b, "identities"), { recursive: true });
  await writeFile(join(b, "secret.key"), "0".repeat(64));
  bridges.push(b);
  return b;
}
function spawnServer(bridge) {
  // No relay.json → relay stays disabled, so activate() never launches a daemon or touches a
  // real socket; the test is fully self-contained in its temp bridge.
  const p = spawn("node", [SERVER], {
    env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_IDENTITY: "ghost", CC2CC_ENCRYPT: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(p);
  return p;
}

describe("0f: activation gated on the MCP initialize handshake", () => {
  it("does NOT register without a client handshake (no phantom account)", async () => {
    const bridge = await freshBridge();
    spawnServer(bridge);
    await sleep(3000); // ample time for the pre-fix code to have auto-joined
    assert.equal(
      await exists(join(bridge, "identities", "identity-ghost.json")), false,
      "no identity should be created when no client ever completes initialize",
    );
  });

  it("registers after a real initialize + initialized handshake", async () => {
    const bridge = await freshBridge();
    const p = spawnServer(bridge);
    const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await sleep(400);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    let joined = false;
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      if (await exists(join(bridge, "identities", "identity-ghost.json"))) { joined = true; break; }
    }
    assert.ok(joined, "identity should be created once the client completes the handshake");
  });
});

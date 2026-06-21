/** Task 6: outbound spool — an expired undelivered message bounces to the sender's inbox. */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("outbound spool / bounce", () => {
  let bridge, proc;
  after(async () => {
    try { proc?.kill("SIGKILL"); } catch {}
    if (bridge) await rm(bridge, { recursive: true, force: true });
  });

  it("an expired spooled message bounces to the sender's inbox", async () => {
    bridge = await mkdtemp(join(tmpdir(), "cc2cc-outbox-"));
    await mkdir(join(bridge, "identities"), { recursive: true });
    await mkdir(join(bridge, "outbox"), { recursive: true });
    await writeFile(join(bridge, "secret.key"), "0".repeat(64));
    await writeFile(join(bridge, "relay.json"), JSON.stringify({ hub_url: "http://127.0.0.1:1", token: "x", machine_id: "m1", enabled: true })); // unreachable hub
    await writeFile(join(bridge, "identities", "identity-sender.json"),
      JSON.stringify({ display_name: "sender", agent_id: "id-sender", created: "2026-01-01T00:00:00Z", teams: ["t"] }));
    // A spooled message created well in the past → past the (overridden) expiry window.
    const old = new Date(Date.now() - 10000).toISOString();
    await writeFile(join(bridge, "outbox", "stuck.json"),
      JSON.stringify({ id: "stuck", from_team: "t", to_team: "faraway", msg: { id: "stuck", from: "sender", to_team: "faraway", content: { text: "hello" } }, created: old }));

    proc = spawn("node", [SERVER], {
      env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_IDENTITY: "sender", CC2CC_ENCRYPT: "1", CC2CC_REMOTE_EXPIRE_MS: "2000" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // 0f: mesh activation is gated on a real MCP initialize handshake; a bare spawn must complete it.
    const send = (m) => proc.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await sleep(400);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    let bounced = false, outboxEmpty = false;
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      let inbox = [];
      try { inbox = await readdir(join(bridge, "to-sender", "inbox")); } catch {}
      for (const f of inbox.filter((x) => x.endsWith(".json"))) {
        const m = JSON.parse(await readFile(join(bridge, "to-sender", "inbox", f), "utf8"));
        if (/Undeliverable/i.test(m.content?.text || "")) bounced = true;
      }
      let ob = [];
      try { ob = (await readdir(join(bridge, "outbox"))).filter((x) => x.endsWith(".json")); } catch {}
      outboxEmpty = ob.length === 0;
      if (bounced && outboxEmpty) break;
    }
    assert.ok(bounced, "sender received an Undeliverable bounce");
    assert.ok(outboxEmpty, "expired message removed from outbox");
  });
});

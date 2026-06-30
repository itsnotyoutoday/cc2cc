/**
 * B1: message-derived names must never drive a filesystem path outside BRIDGE_DIR.
 *
 * The worst vector is auto-triggered: consumeInbox writes a TTL-expiry notice to
 * inboxDir(msg.from), and msg.from is attacker-controllable on relayed mail. A spoofed
 * `from` like "../../../../tmp/x" used to mkdir + write OUTSIDE the bridge on expiry.
 * inboxDir() now rejects any non-validateName() name, so the path can never escape.
 *
 * End-to-end invariant: an expiring message carrying a traversal `from` is still processed
 * (moved out of the inbox) but creates NOTHING outside the bridge.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);

const procs = [];
const cleanup = [];
after(async () => {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
  for (const d of cleanup) { try { await rm(d, { recursive: true, force: true }); } catch {} }
});

describe("B1: path traversal via message-derived inbox names", () => {
  it("a spoofed traversal `from` is processed but escapes nothing", async () => {
    const bridge = await mkdtemp(join(tmpdir(), "cc2cc-trav-")); cleanup.push(bridge);
    const pwn = join(tmpdir(), `cc2cc-pwn-${randomUUID()}`); cleanup.push(pwn);
    await mkdir(join(bridge, "identities"), { recursive: true });
    await mkdir(join(bridge, "to-guard", "inbox"), { recursive: true });
    await writeFile(join(bridge, "secret.key"), "0".repeat(64));

    // `from` that, via <bridge>/to-<from>/inbox, resolves up and into `pwn`.
    const evilFrom = `../../../../${tmpdir().replace(/^\/+/, "")}/${pwn.split("/").pop()}`;
    await writeFile(join(bridge, "to-guard", "inbox", "evil.json"), JSON.stringify({
      id: `m-${randomUUID()}`, from: evilFrom, to: "guard", from_team: "t", to_team: "t",
      type: "message", timestamp: new Date(Date.now() - 10000).toISOString(), ttl: 1,
      content: { text: "hi" },
    }));

    const p = spawn("node", [SERVER], {
      env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_IDENTITY: "guard", CC2CC_ENCRYPT: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    procs.push(p);
    p.stdout.on("data", () => {});
    const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await sleep(400);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await sleep(1200);

    // Drive the consume path (tool calls) and wait for the message to be processed out of the inbox.
    let processed = false;
    for (let i = 0; i < 16; i++) {
      send({ jsonrpc: "2.0", id: 100 + i, method: "tools/call", params: { name: "check_inbox", arguments: {} } });
      await sleep(500);
      const left = await readdir(join(bridge, "to-guard", "inbox")).catch(() => []);
      if (!left.includes("evil.json")) { processed = true; break; }
    }

    assert.ok(processed, "the malicious message was actually processed (not silently ignored)");
    assert.equal(await exists(pwn), false, "a traversal `from` must NOT create anything outside the bridge");
  });
});

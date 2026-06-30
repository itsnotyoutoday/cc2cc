/** Task 6: a delivered message older than the staleness window shows a "may be stale" note on read. */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => r.content?.[0]?.text ?? "";

describe("message-age-on-read", () => {
  let bridge, client, transport;
  after(async () => {
    try { await client?.close(); } catch {}
    if (bridge) await rm(bridge, { recursive: true, force: true });
  });

  it("an old message gets a 'may be stale' prompt; a fresh one does not", async () => {
    bridge = await mkdtemp(join(tmpdir(), "cc2cc-age-"));
    await mkdir(join(bridge, "identities"), { recursive: true });
    await mkdir(join(bridge, "to-reader", "inbox"), { recursive: true });
    await writeFile(join(bridge, "identities", "identity-reader.json"),
      JSON.stringify({ display_name: "reader", agent_id: "id-reader", created: "2026-01-01T00:00:00Z", teams: ["t"] }));
    // One 3-day-old message and one fresh message.
    const old = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
    const fresh = new Date().toISOString();
    await writeFile(join(bridge, "to-reader", "inbox", "m-old.json"),
      JSON.stringify({ id: "m-old", timestamp: old, from: "boss", to: "reader", type: "message", content: { text: "old task" } }));
    await writeFile(join(bridge, "to-reader", "inbox", "m-new.json"),
      JSON.stringify({ id: "m-new", timestamp: fresh, from: "boss", to: "reader", type: "message", content: { text: "fresh task" } }));

    transport = new StdioClientTransport({ command: "node", args: [SERVER], env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_IDENTITY: "reader" } });
    client = new Client({ name: "age-test", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    await sleep(1500);

    const out = txt(await client.callTool({ name: "check_inbox", arguments: {} }));
    // Both messages delivered; the old one carries the stale note, the fresh one doesn't.
    assert.match(out, /old task/, "old message delivered");
    assert.match(out, /fresh task/, "fresh message delivered");
    assert.match(out, /stale/i, "stale prompt present for the old message");
    assert.match(out, /3d old/, "age shown");
    // The stale note should appear once (for the old message), not for the fresh one.
    assert.equal((out.match(/may be stale/gi) || []).length, 1, "exactly one stale note");
  });
});

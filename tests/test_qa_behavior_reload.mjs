/**
 * QA (adversarial): END-TO-END config hot-reload + two-knob presence.
 *
 * Strategy: a running session derives an agent's online/offline verdict purely from
 *   isStale(hb) === age > policy.identities.offline_after_seconds.
 * We plant a STATIC peer heartbeat with a FIXED age, then flip policy.json on disk and
 * watch list_agents change its verdict on the SAME unchanged heartbeat — no restart.
 * That proves: (a) pollStatus re-reads policy.json every poll, and (b) the identities
 * section is actually merged/applied (the merge-fix), and (c) isStale uses offlineAfterS().
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => r.content?.[0]?.text ?? "";

// Plant a peer heartbeat whose age is FIXED at `ageSeconds` in the past.
async function plantPeer(bridge, name, ageSeconds) {
  const ts = new Date(Date.now() - ageSeconds * 1000).toISOString();
  await writeFile(join(bridge, "status", `${name}-heartbeat.json`),
    JSON.stringify({ agent: name, timestamp: ts, status: "active", status_text: "Idle", teams: ["solo"] }));
}

async function writePolicy(bridge, offlineAfterSeconds) {
  await writeFile(join(bridge, "policy.json"),
    JSON.stringify({ identities: { offline_after_seconds: offlineAfterSeconds } }));
}

async function statusOf(client, name) {
  const list = JSON.parse(txt(await client.callTool({ name: "list_agents", arguments: {} })));
  return list.find((a) => a.name === name)?.status;
}

describe("QA: config hot-reload + presence", () => {
  let bridge, client, transport;
  after(async () => {
    try { await client?.close(); } catch {}
    if (bridge) await rm(bridge, { recursive: true, force: true });
  });

  it("running session re-reads policy.json offline_after_seconds (no restart)", async () => {
    bridge = await mkdtemp(join(tmpdir(), "cc2cc-qa-reload-"));
    await mkdir(join(bridge, "identities"), { recursive: true });
    await mkdir(join(bridge, "status"), { recursive: true });
    await writeFile(join(bridge, "identities", "identity-watcher.json"),
      JSON.stringify({ display_name: "watcher", agent_id: "id-w", created: "2026-01-01T00:00:00Z", teams: ["solo"], role: "member" }));

    // Peer is 30s stale. Start with a LONG offline window (120s) so it reads ONLINE.
    await plantPeer(bridge, "peer", 30);
    await writePolicy(bridge, 120);

    transport = new StdioClientTransport({
      command: "node", args: [SERVER],
      env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_IDENTITY: "watcher" },
    });
    client = new Client({ name: "qa", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    await sleep(2000); // let initial poll(s) run

    // Re-plant to keep its age ~30s (a single static file's age grows; refresh so the
    // verdict depends on the POLICY, not on drift past 120s during the test).
    await plantPeer(bridge, "peer", 30);
    await sleep(3500);
    const before = await statusOf(client, "peer");
    assert.equal(before, "online", `with 120s window a 30s-stale peer must be online (got ${before})`);

    // FLIP policy on disk: window now 10s. The SAME 30s-stale peer must go offline within ~1-2 polls.
    await writePolicy(bridge, 10);
    let after = before;
    for (let i = 0; i < 6; i++) {
      await sleep(1500);
      await plantPeer(bridge, "peer", 30); // keep age fixed at 30s
      after = await statusOf(client, "peer");
      if (after === "offline") break;
    }
    assert.equal(after, "offline", "after lowering offline_after_seconds to 10s, a 30s peer must flip offline (proves hot-reload + identities-merge)");

    // FLIP BACK UP: window 120s again → same peer online again (reload is bidirectional, not one-shot).
    await writePolicy(bridge, 120);
    let back = after;
    for (let i = 0; i < 6; i++) {
      await sleep(1500);
      await plantPeer(bridge, "peer", 30);
      back = await statusOf(client, "peer");
      if (back === "online") break;
    }
    assert.equal(back, "online", "raising offline_after_seconds back to 120s must flip peer online again");
  });
});

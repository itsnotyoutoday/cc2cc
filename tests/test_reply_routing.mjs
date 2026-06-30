/** handleReply routing must be by REACHABILITY, not transient presence.
 *
 *  Bug (QA, superbad): handleReply gated direct delivery on isAgentOnline(originalSender). When the
 *  original sender briefly looked offline — a heartbeat-staleness flap, or simply idle — a reply was
 *  LOST (same-team: returned "not reachable locally") or misrouted to the team leader (cross-team),
 *  dropping the reply + its replyRoute echo. But the original sender PROVED they exist by messaging us,
 *  and a LOCAL sender's inbox is always writable (inboxes are async). So a reply to a LOCAL sender must
 *  be delivered directly regardless of momentary online status; only a genuinely REMOTE (another
 *  machine) sender needs the relay.
 *
 *  This test plants a message from a LOCAL-but-OFFLINE sender (alice, never connected) and asserts the
 *  replier (bob) can reply and it lands directly in alice's inbox — which fails on the pre-fix code. */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SDK = join(REPO, "channel", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);
const SERVER = join(REPO, "channel", "server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => r.content?.[0]?.text ?? "";

async function identity(bridge, name, teams) {
  await mkdir(join(bridge, "identities"), { recursive: true });
  await writeFile(join(bridge, "identities", `identity-${name}.json`),
    JSON.stringify({ display_name: name, agent_id: `id-${name}`, created: "2026-01-01T00:00:00Z", last_seen: new Date().toISOString(), teams }));
}
async function connect(bridge, name) {
  const transport = new StdioClientTransport({ command: "node", args: [SERVER],
    env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_IDENTITY: name } });
  const client = new Client({ name: "rr-route-test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

describe("handleReply routing — reachability, not transient presence", () => {
  let bridge; const clients = [];
  after(async () => { for (const c of clients) { try { await c.close(); } catch {} } if (bridge) await rm(bridge, { recursive: true, force: true }); });

  it("delivers a reply directly to a LOCAL sender that is offline at reply time (no loss/misroute)", async () => {
    bridge = await mkdtemp(join(tmpdir(), "cc2cc-rrt-"));
    await writeFile(join(bridge, "teams.json"), JSON.stringify({ teams: {
      t: { name: "t", owner_machine: "local", leader: "bob", admitted: ["alice", "bob"], revoked: [], rules: { retention_days: 4, admission: "open", sticky_leader: true } },
    }}));
    await identity(bridge, "alice", ["t"]);   // local identity exists, but alice never connects → offline
    await identity(bridge, "bob", ["t"]);
    const b = await connect(bridge, "bob"); clients.push(b.client);

    // bob sees itself online; alice is NOT online (never connected) — this is the bug's trigger.
    let ready = false;
    for (let i = 0; i < 20 && !ready; i++) {
      await sleep(750);
      const roster = JSON.parse(txt(await b.client.callTool({ name: "list_agents", arguments: {} })));
      const selfOnline = roster.some((r) => r.is_self && r.status === "online");
      const aliceOffline = !roster.some((r) => r.name === "alice" && r.status === "online");
      ready = selfOnline && aliceOffline;
    }
    assert.ok(ready, "bob online, alice offline (the presence condition under test)");

    // Plant a message FROM alice TO bob directly in bob's done/ (handleReply looks up inbox+done; done
    // is not re-consumed, so it survives without the self-guard/consume touching it). No from_team =
    // the normal direct-send shape, which exercises the same-team direct-reply path.
    const origId = "msg-presence-orig-1";
    const done = join(bridge, "to-bob", "done");
    await mkdir(done, { recursive: true });
    await writeFile(join(done, `${origId}.json`), JSON.stringify({
      id: origId, timestamp: new Date().toISOString(), from: "alice", to: "bob",
      type: "message", priority: "normal", content: { text: "hi bob", parts: [] }, ttl: 3600,
    }));

    // bob replies. Pre-fix: alice offline → "not reachable locally" error, reply LOST. Post-fix: alice
    // is local → direct write to alice's inbox regardless of online status.
    const rres = txt(await b.client.callTool({ name: "reply", arguments: { msg_id: origId, text: "hi alice" } }));
    assert.match(rres, /sent|reply/i, `reply should succeed, got: ${rres}`);

    let toAlice = null;
    for (let i = 0; i < 16 && !toAlice; i++) {
      await sleep(400);
      const dir = join(bridge, "to-alice", "inbox");
      let files = [];
      try { files = (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-")); } catch { /* not yet */ }
      for (const f of files) {
        try { const m = JSON.parse(await readFile(join(dir, f), "utf8")); if (m.from === "bob" && m.replyTo === origId) toAlice = m; } catch { /* skip */ }
      }
    }
    assert.ok(toAlice, "reply was delivered directly to the offline local sender's inbox (not lost/misrouted)");
    assert.equal(toAlice.to, "alice", "reply addressed to the original sender");
  });
});

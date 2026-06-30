/** self-delivery guard: a message with from==to wakes the sender's own peer session and its reply
 *  routes back to itself → echo loop (this took the gateway lead down). The cc2cc CORE rejects
 *  from==to on every send path (send / reply / send_team) and, defense-in-depth, DROPS a
 *  self-addressed message already in the inbox on consume — without receipt/notify/expiry-echo,
 *  any of which would re-arm the loop. Mirrors the gateway-side plugin guard (clawman 760b9f1). */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, stat, readdir } from "node:fs/promises";
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
  const client = new Client({ name: "sd-test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

describe("self-delivery guard (from==to rejected)", () => {
  let bridge, bridge2; const clients = [];
  after(async () => {
    for (const c of clients) { try { await c.close(); } catch {} }
    for (const b of [bridge, bridge2]) { if (b) await rm(b, { recursive: true, force: true }); }
  });

  it("rejects self send + self send_team(leader), and drops a planted self-addressed inbox message", async () => {
    bridge = await mkdtemp(join(tmpdir(), "cc2cc-sd-"));
    await writeFile(join(bridge, "teams.json"), JSON.stringify({ teams: {
      t: { name: "t", owner_machine: "local", leader: "alice", admitted: ["alice"], revoked: [], rules: { retention_days: 4, admission: "open", sticky_leader: true } },
    }}));
    await identity(bridge, "alice", ["t"]);
    const a = await connect(bridge, "alice"); clients.push(a.client);
    // wait until alice sees itself online (self-heartbeat lands a few seconds after connect)
    let ready = false;
    for (let i = 0; i < 20 && !ready; i++) {
      await sleep(750);
      const roster = JSON.parse(txt(await a.client.callTool({ name: "list_agents", arguments: {} })));
      ready = roster.some((r) => r.is_self && r.status === "online");
    }
    assert.ok(ready, "alice sees itself online before sending");

    // 1) send to self -> rejected
    const s = txt(await a.client.callTool({ name: "send", arguments: { to: "alice", text: "loop me" } }));
    assert.match(s, /yourself|self-delivery|rejected/i, `self send should be rejected, got: ${s}`);

    // 2) send_team to own team where alice IS the leader -> self-delivery rejected
    const st = txt(await a.client.callTool({ name: "send_team", arguments: { team: "t", text: "loop team" } }));
    assert.match(st, /self-delivery|leader|rejected/i, `self send_team(leader) should be rejected, got: ${st}`);

    // Neither rejected send may have written anything to alice's own inbox.
    const inbox = join(bridge, "to-alice", "inbox");
    await mkdir(inbox, { recursive: true });
    const after1 = (await readdir(inbox)).filter((f) => f.endsWith(".json"));
    assert.deepEqual(after1, [], `no self-message should have been written by rejected sends, found: ${after1}`);

    // 3) receive-side defense in depth: plant a self-addressed (from==to) message directly in the
    //    inbox and confirm consume DROPS it — retired to done/, NO receipt, NOT surfaced in response.
    const selfMsg = { id: "msg-self-loop-1", timestamp: new Date().toISOString(), from: "alice", to: "alice",
      type: "message", priority: "normal", identity: { agent: "alice", mode: "session" },
      content: { text: "planted self loop", parts: [] }, ttl: 3600 };
    await writeFile(join(inbox, `${selfMsg.id}.json`), JSON.stringify(selfMsg));

    // Any tool call piggybacks consumeInbox(); poll a few times until the drop lands.
    let resp = "";
    for (let i = 0; i < 10; i++) {
      resp = txt(await a.client.callTool({ name: "check_inbox", arguments: {} }));
      if (!(await exists(join(inbox, `${selfMsg.id}.json`)))) break;
      await sleep(400);
    }
    assert.equal(await exists(join(inbox, `${selfMsg.id}.json`)), false, "planted self message left the inbox");
    assert.equal(await exists(join(bridge, "to-alice", "done", `${selfMsg.id}.json`)), true, "planted self message retired to done/");
    assert.equal(await exists(join(bridge, "to-alice", "receipts", `${selfMsg.id}.receipt.json`)), false, "dropped self-delivery must NOT write a receipt");
    assert.equal(/planted self loop/.test(resp), false, "dropped self-delivery must NOT surface in the response");
  });

  // Directly exercise the handleReply self-reject branch (to===originalMsg.from===self). rlead noted
  // this branch was code-review-only because the receive-side drop removes a self-msg from the inbox
  // before it can be replied to. Plant the self-addressed original in done/ instead (handleReply looks
  // up inbox+done; done is not re-consumed, so the drop never touches it) → reply must be rejected.
  it("rejects replying to one's OWN message (handleReply self-reject branch)", async () => {
    bridge2 = await mkdtemp(join(tmpdir(), "cc2cc-sd2-"));
    await writeFile(join(bridge2, "teams.json"), JSON.stringify({ teams: {
      t: { name: "t", owner_machine: "local", leader: "alice", admitted: ["alice"], revoked: [], rules: { retention_days: 4, admission: "open", sticky_leader: true } },
    }}));
    await identity(bridge2, "alice", ["t"]);
    const a = await connect(bridge2, "alice"); clients.push(a.client);
    let ready = false;
    for (let i = 0; i < 20 && !ready; i++) {
      await sleep(750);
      const roster = JSON.parse(txt(await a.client.callTool({ name: "list_agents", arguments: {} })));
      ready = roster.some((r) => r.is_self && r.status === "online");
    }
    assert.ok(ready, "alice sees itself online");

    // Plant a self-addressed (from===to===alice) original in alice's done/.
    const origId = "msg-selfreply-orig-1";
    const done = join(bridge2, "to-alice", "done");
    await mkdir(done, { recursive: true });
    await writeFile(join(done, `${origId}.json`), JSON.stringify({
      id: origId, timestamp: new Date().toISOString(), from: "alice", to: "alice",
      type: "message", priority: "normal", content: { text: "my own note", parts: [] }, ttl: 3600,
    }));

    const rres = txt(await a.client.callTool({ name: "reply", arguments: { msg_id: origId, text: "loop me" } }));
    assert.match(rres, /yourself|self-delivery|rejected/i, `self-reply must be rejected, got: ${rres}`);
    // And nothing was written to alice's own inbox by the rejected reply.
    const inbox = join(bridge2, "to-alice", "inbox");
    await mkdir(inbox, { recursive: true });
    const leaked = (await readdir(inbox)).filter((f) => f.endsWith(".json"));
    assert.deepEqual(leaked, [], `rejected self-reply must not write a message, found: ${leaked}`);
  });
});

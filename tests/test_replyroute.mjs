/** replyRoute: opaque reply-route metadata the bridge PRESERVES end-to-end and ECHOES on replies,
 *  but never interprets. Lets a client carry a session-routing token that round-trips back on the
 *  reply so it lands in the originating session — works for ANY MCP client (echo is server-side). */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "server.mjs");
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
  const client = new Client({ name: "rr-test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}
/** Find a message by a predicate across an agent's inbox + done (envelope is plaintext on disk;
 *  only content.text is encrypted, and replyRoute is a top-level field). */
async function findMsg(bridge, agent, pred) {
  for (const sub of ["inbox", "done"]) {
    const dir = join(bridge, `to-${agent}`, sub);
    let files = [];
    try { files = (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-")); } catch { continue; }
    for (const f of files) {
      try { const m = JSON.parse(await readFile(join(dir, f), "utf8")); if (pred(m)) return m; } catch { /* skip */ }
    }
  }
  return null;
}

describe("replyRoute (opaque preserve + echo)", () => {
  let bridge; const clients = [];
  after(async () => { for (const c of clients) { try { await c.close(); } catch {} } if (bridge) await rm(bridge, { recursive: true, force: true }); });

  it("preserves replyRoute to the recipient, echoes it back on reply, and omits it when unset", async () => {
    bridge = await mkdtemp(join(tmpdir(), "cc2cc-rr-"));
    await writeFile(join(bridge, "teams.json"), JSON.stringify({ teams: {
      t: { name: "t", owner_machine: "local", leader: "alice", admitted: ["alice", "bob"], revoked: [], rules: { retention_days: 4, admission: "open", sticky_leader: true } },
    }}));
    await identity(bridge, "alice", ["t"]);
    await identity(bridge, "bob", ["t"]);
    const a = await connect(bridge, "alice"); clients.push(a.client);
    const b = await connect(bridge, "bob"); clients.push(b.client);
    // Wait until alice's roster shows BOTH itself (is_self) and bob online — sharesTeam() needs self
    // folded into the roster (else it falls back to DEFAULT_TEAM and a non-default-team send is
    // wrongly blocked). Self-heartbeat can take a few seconds to land, so poll rather than fixed-sleep.
    // MUTUAL readiness: alice must see bob AND bob must see alice (each with self folded into its own
    // roster), on team "t", before any traffic. The reply step is the subtle one — handleReply delivers
    // directly only when the replier sees the original sender online locally (isAgentOnline); otherwise it
    // takes the team-relay fallback (handleSendTeam to the leader), whose envelope has no from===bob /
    // replyTo linkage, so the test's direct-delivery assertion never lands. Waiting only for ALICE's view
    // (the old check) let bob reply before bob's self-heartbeat folded in → relay fallback → flaky miss.
    const sees = (roster, peer) =>
      roster.some((r) => r.is_self && r.status === "online" && (r.teams || []).includes("t")) &&
      roster.some((r) => r.name === peer && r.status === "online");
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {   // ~30s: self-heartbeat can be slow on a COLD first run
      await sleep(750);
      const aRoster = JSON.parse(txt(await a.client.callTool({ name: "list_agents", arguments: {} })));
      const bRoster = JSON.parse(txt(await b.client.callTool({ name: "list_agents", arguments: {} })));
      ready = sees(aRoster, "bob") && sees(bRoster, "alice");
    }
    assert.ok(ready, "alice and bob each see self + the other online (same team) before send/reply");

    const route = { session: "sess-ABC123", plugin: "openclaw-cc2cc" };

    // 1) alice → bob WITH replyRoute. The recipient envelope must preserve it verbatim.
    const sres = txt(await a.client.callTool({ name: "send", arguments: { to: "bob", text: "hi bob", replyRoute: route } }));
    assert.match(sres, /sent|delivered/i, `send returned: ${sres}`);
    let toBob = null;
    for (let i = 0; i < 24 && !toBob; i++) { await sleep(500); toBob = await findMsg(bridge, "bob", (m) => m.from === "alice" && m.replyRoute); } // ~12s: cold-start delivery margin
    assert.ok(toBob, "alice's message reached bob's store");
    assert.deepEqual(toBob.replyRoute, route, "replyRoute preserved verbatim to recipient");
    const originalId = toBob.id;

    // 2) bob replies to that message → the reply to alice must ECHO the same replyRoute back.
    const rres = txt(await b.client.callTool({ name: "reply", arguments: { msg_id: originalId, text: "hi alice" } }));
    assert.match(rres, /sent|reply/i, `reply returned: ${rres}`);
    let toAlice = null;
    for (let i = 0; i < 24 && !toAlice; i++) { await sleep(500); toAlice = await findMsg(bridge, "alice", (m) => m.from === "bob" && m.replyTo === originalId); }
    assert.ok(toAlice, "bob's reply reached alice's store");
    assert.deepEqual(toAlice.replyRoute, route, "reply ECHOED the original replyRoute back to the originator");

    // 3) a normal send with NO replyRoute must NOT carry the field (clean envelope, no leakage).
    await a.client.callTool({ name: "send", arguments: { to: "bob", text: "plain" } });
    let plain = null;
    for (let i = 0; i < 24 && !plain; i++) { await sleep(500); plain = await findMsg(bridge, "bob", (m) => m.from === "alice" && /plain/.test(JSON.stringify(m.content || ""))); }
    assert.ok(plain, "plain message reached bob");
    assert.equal("replyRoute" in plain, false, "no replyRoute field when unset");
  });
});

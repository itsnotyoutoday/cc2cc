/**
 * request_join: an agent asks to join a team; the request routes to that team's leader
 * (standard cross-team messaging, tagged intent="join_request"). Leader admits at will.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = "/home/cc2ccroomstest/cc2cc/cc2cc/channel/node_modules/@modelcontextprotocol/sdk/dist/esm/client";
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => r.content?.[0]?.text ?? "";
const env = (b, n) => ({ ...process.env, CC2CC_BRIDGE_DIR: b, CC2CC_IDENTITY: n });
const seed = (b, n, teams, role) =>
  mkdir(join(b, "identities"), { recursive: true }).then(() => writeFile(join(b, "identities", `identity-${n}.json`),
    JSON.stringify({ display_name: n, agent_id: `id-${n}`, created: "2026-01-01T00:00:00Z", teams, role })));

describe("request_join routes to the team leader", () => {
  let bridge, client, transport, leaderProc;
  after(async () => {
    try { await client?.close(); } catch {}
    try { leaderProc?.kill("SIGKILL"); } catch {}
    if (bridge) await rm(bridge, { recursive: true, force: true });
  });

  it("delivers a join_request to the leader's inbox", async () => {
    bridge = await mkdtemp(join(tmpdir(), "cc2cc-join-"));
    await mkdir(join(bridge, "status"), { recursive: true });
    await seed(bridge, "gov-lead", ["gov"], "leader");
    await seed(bridge, "r-user", ["solo"], "member");
    // Leadership lives in teams.json.
    await writeFile(join(bridge, "teams.json"), JSON.stringify({ teams: { gov: {
      name: "gov", owner_machine: "local", leader: "gov-lead", succession: [],
      rules: { retention_days: 4, admission: "open", sticky_leader: true },
      admitted: ["gov-lead"], revoked: [],
    } } }));

    leaderProc = spawn("node", [SERVER], { env: env(bridge, "gov-lead"), stdio: ["pipe", "pipe", "pipe"] });
    transport = new StdioClientTransport({ command: "node", args: [SERVER], env: env(bridge, "r-user") });
    client = new Client({ name: "join-test", version: "0" }, { capabilities: {} });
    await client.connect(transport);

    // Wait until r-user's server has discovered gov's leader (reconcile from heartbeat),
    // then request_join. Polling avoids a flaky fixed wait.
    let res = "";
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const teams = JSON.parse(txt(await client.callTool({ name: "list_teams", arguments: {} })));
      if (teams.find((t) => t.name === "gov")?.leader) {
        res = txt(await client.callTool({ name: "request_join", arguments: { team: "gov", note: "please add me" } }));
        if (!/not reachable/i.test(res)) break;
      }
    }
    assert.doesNotMatch(res, /not reachable/i, `request_join should route, got: ${res}`);

    // Verify a join_request landed in the leader's inbox.
    const inbox = join(bridge, "to-gov-lead", "inbox");
    let found = null;
    for (let i = 0; i < 8; i++) {
      let files = [];
      try { files = (await readdir(inbox)).filter((f) => f.endsWith(".json")); } catch {}
      for (const f of files) {
        const m = JSON.parse(await readFile(join(inbox, f), "utf8"));
        if (m.intent === "join_request" && m.from === "r-user") { found = m; break; }
      }
      if (found) break;
      await sleep(1000);
    }
    assert.ok(found, "leader received a join_request from r-user");
    assert.equal(found.to_team, "gov");
    assert.match(JSON.stringify(found.content), /please add me/);
  });
});

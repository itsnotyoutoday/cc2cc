/** create_team: an agent creates a team in-session and becomes its leader (writes teams.json). */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => r.content?.[0]?.text ?? "";

describe("create_team", () => {
  let bridge, client, transport;
  after(async () => {
    try { await client?.close(); } catch {}
    if (bridge) await rm(bridge, { recursive: true, force: true });
  });

  it("creator becomes the team's leader (teams.json + list_teams)", async () => {
    bridge = await mkdtemp(join(tmpdir(), "cc2cc-ct-"));
    await mkdir(join(bridge, "identities"), { recursive: true });
    await writeFile(join(bridge, "identities", "identity-creator.json"),
      JSON.stringify({ display_name: "creator", agent_id: "id-creator", created: "2026-01-01T00:00:00Z", teams: ["solo"], role: "member" }));

    transport = new StdioClientTransport({
      command: "node", args: [SERVER],
      env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_IDENTITY: "creator" },
    });
    client = new Client({ name: "ct-test", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    await sleep(1500);

    const res = txt(await client.callTool({ name: "create_team", arguments: { name: "newteam", admission: "approved" } }));
    assert.match(res, /Created team "newteam"/i, `unexpected: ${res}`);

    // teams.json records the creator as leader + admitted.
    const reg = JSON.parse(await readFile(join(bridge, "teams.json"), "utf8")).teams;
    assert.equal(reg.newteam.leader, "creator");
    assert.ok(reg.newteam.admitted.includes("creator"));
    assert.equal(reg.newteam.rules.admission, "approved");

    // After a poll, the creator's own list_teams shows it leading newteam.
    let leads = false;
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      const teams = JSON.parse(txt(await client.callTool({ name: "list_teams", arguments: {} })));
      if (teams.find((t) => t.name === "newteam")?.leader === "creator") { leads = true; break; }
    }
    assert.ok(leads, "creator leads the new team");

    // Duplicate create is rejected.
    const dup = txt(await client.callTool({ name: "create_team", arguments: { name: "newteam" } }));
    assert.match(dup, /already exists/i);
  });
});

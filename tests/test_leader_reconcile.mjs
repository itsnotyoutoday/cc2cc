/**
 * Leader-reconciliation test (regression for the init-only teamLeaders race).
 *
 * Bug: teamLeaders was built once at init from heartbeats present at that instant,
 * and pollStatus never updated it. So a leader that came online AFTER an agent
 * started was never discovered → send_team routing and list_teams broke.
 *
 * This test drives a real MCP list_teams round-trip:
 *   1. Start a MEMBER of team "qa" and connect an MCP client to it.
 *   2. list_teams → qa leader is null (no leader online yet).
 *   3. Start a LEADER of team "qa" afterwards (separate process, same bridge).
 *   4. After a poll cycle, list_teams on the member must now show qa leader = the
 *      leader's name. (Without the fix it stays null.)
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = "../channel/node_modules/@modelcontextprotocol/sdk/dist/esm/client";
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "channel", "server.mjs");

function leaderOf(listTeamsResult, team) {
  const text = listTeamsResult.content?.[0]?.text ?? "[]";
  const teams = JSON.parse(text);
  return teams.find((t) => t.name === team)?.leader ?? null;
}

describe("teamLeaders reconciliation (leader discovered after init)", () => {
  let bridge, client, transport, leaderProc;

  after(async () => {
    try { await client?.close(); } catch {}
    try { transport?.close?.(); } catch {}
    try { leaderProc?.kill("SIGKILL"); } catch {}
    if (bridge) await rm(bridge, { recursive: true, force: true });
  });

  it("a member's list_teams picks up a leader that starts later", async () => {
    bridge = await mkdtemp(join(tmpdir(), "cc2cc-leadrec-"));

    // 1. Member of team "qa" — spawned and driven via the MCP client.
    transport = new StdioClientTransport({
      command: "node",
      args: [SERVER],
      env: { ...process.env, CC2CC_BRIDGE_DIR: bridge, CC2CC_IDENTITY: "qa-obs", CC2CC_TEAM: "qa" },
    });
    client = new Client({ name: "leadrec-test", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);

    // 2. No leader online yet → qa leader null.
    const before = await client.callTool({ name: "list_teams", arguments: {} });
    assert.equal(leaderOf(before, "qa"), null, "qa leader should be null before a leader exists");

    // 3. Designate qa's leader in the team registry (teams.json) AFTER the member is
    // already running — the member's loadTeamPolicies must pick it up on a later poll.
    // Leadership lives in teams.json (not identity role); qa-lead need not even be online.
    await writeFile(join(bridge, "teams.json"), JSON.stringify({ teams: { qa: {
      name: "qa", owner_machine: "local", leader: "qa-lead", succession: [],
      rules: { retention_days: 4, admission: "open", sticky_leader: true },
      admitted: ["qa-lead"], revoked: [],
    } } }));

    // 4. Within a few poll cycles (POLL_MS=3000), the member must reconcile.
    let leader = null;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const r = await client.callTool({ name: "list_teams", arguments: {} });
      leader = leaderOf(r, "qa");
      if (leader === "qa-lead") break;
    }
    assert.equal(leader, "qa-lead", "qa leader must be reconciled to qa-lead after it comes online");
  });
});

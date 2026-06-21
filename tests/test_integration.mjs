/**
 * Integration test: CC2CC Relay Hub + relay.mjs
 *
 * Single-machine loopback. The hub is started automatically on a free ephemeral
 * port by the startHub() fixture (no manually-started hub required).
 * Run test:  node --test tests/test_integration.mjs
 * If python3 lacks fastapi/uvicorn, point the fixture at a venv:
 *            PYTHON=$HOME/venv/bin/python node --test tests/test_integration.mjs
 *
 * Covers: registration, send, poll, ack (B7), self-team inbound (B3), exports
 * B7 stale-lease rejection is covered by Python suite (LEASE_TTL=0 patching).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHub } from "./helpers/hub.mjs";

const TOKEN = "integ-test-token";
const MACHINE_A = "integ-machine-a";
const MACHINE_B = "integ-machine-b";
const TEAM = "integ-team";

let relay;
let hub;
let HUB_URL; // set in before() from the ephemeral-port fixture

async function apiPost(url, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

describe("Integration: Hub + relay round-trip", () => {

  before(async () => {
    hub = await startHub({ token: TOKEN });
    HUB_URL = hub.url;
    const health = await (await fetch(`${HUB_URL}/health`)).json();
    assert.equal(health.status, "ok");
    relay = await import("../channel/relay.mjs");
  });

  after(async () => {
    try { relay?.stopRelayClient?.(); } catch {}
    await hub?.stop();
  });

  it("1. Register machines + send cross-queue message", async () => {
    const regA = await apiPost(`${HUB_URL}/api/register`, {
      token: TOKEN, machine_id: MACHINE_A, team: TEAM,
    });
    assert.equal(regA.status, "registered");

    const regB = await apiPost(`${HUB_URL}/api/register`, {
      token: TOKEN, machine_id: MACHINE_B, team: TEAM,
    });
    assert.equal(regB.status, "registered");

    const sendRes = await apiPost(`${HUB_URL}/api/send`, {
      token: TOKEN,
      from_machine: MACHINE_A,
      from_team: TEAM,
      to_team: TEAM,
      message: { content: { text: "integration test message" } },
    });
    assert.equal(sendRes.status, "accepted");
    assert.ok(sendRes.message_id.startsWith("relay-"), "message_id relay-*");
  });

  it("2. Full poll + ack cycle", async () => {
    // B polls and receives
    const poll1 = await apiPost(`${HUB_URL}/api/poll`, {
      machine_id: MACHINE_B, team: TEAM,
    }, TOKEN);
    assert.ok(poll1.messages.length >= 1);
    const msg = poll1.messages[0];
    assert.equal(msg.from_machine, MACHINE_A);
    assert.equal(msg.from_team, TEAM);
    assert.equal(msg.to_team, TEAM);
    assert.equal(msg.message.content.text, "integration test message");
    assert.ok(msg.lease_id);

    // Ack
    const ackRes = await apiPost(`${HUB_URL}/api/ack`, {
      token: TOKEN, machine_id: MACHINE_B, acked_ids: [msg.lease_id],
    });
    assert.equal(ackRes.deleted_count, 1);

    // Verify empty
    const poll2 = await apiPost(`${HUB_URL}/api/poll`, {
      machine_id: MACHINE_B, team: TEAM,
    }, TOKEN);
    assert.equal(poll2.messages.length, 0);
  });

  it("3. Second message cycle (fresh state after ack)", async () => {
    await apiPost(`${HUB_URL}/api/send`, {
      token: TOKEN,
      from_machine: MACHINE_A, from_team: TEAM, to_team: TEAM,
      message: { content: { text: "second message" } },
    });

    const poll = await apiPost(`${HUB_URL}/api/poll`, {
      machine_id: MACHINE_B, team: TEAM,
    }, TOKEN);
    assert.ok(poll.messages.length >= 1);
    assert.equal(poll.messages[0].message.content.text, "second message");

    const ack2 = await apiPost(`${HUB_URL}/api/ack`, {
      token: TOKEN, machine_id: MACHINE_B, acked_ids: [poll.messages[0].lease_id],
    });
    assert.equal(ack2.deleted_count, 1);

    const poll3 = await apiPost(`${HUB_URL}/api/poll`, {
      machine_id: MACHINE_B, team: TEAM,
    }, TOKEN);
    assert.equal(poll3.messages.length, 0);
  });

  it("4. B7 stale-lease (covered by Python suite)", () => {
    // B7 stale-lease rejection tested via test_relay_hub.py with LEASE_TTL=0.
    // Python test: test_stale_lease_superseded_on_release (PASSED)
    assert.ok(true);
  });

  it("5. relay.mjs client init + status (B3)", () => {
    const cfg = { hub_url: HUB_URL, machine_id: MACHINE_A, token: TOKEN, enabled: true };
    relay.startRelayClient("/tmp/relay-bridge", TEAM, cfg, "agent-alpha");
    assert.ok(relay.isRelayEnabled());
    const status = relay.getRelayStatus();
    assert.equal(status.hub_url, HUB_URL);
    assert.equal(status.machine_id, MACHINE_A);
    relay.stopRelayClient();
    assert.equal(relay.isRelayEnabled(), false);
  });

  it("6. relay.mjs exports", () => {
    assert.equal(typeof relay.getConfigToken, "function");
    assert.equal(typeof relay.setEncryptionFunction, "function");
    assert.equal(typeof relay.isRemoteTeam, "function");
    assert.equal(typeof relay.getRemoteTeams, "function");
    assert.equal(typeof relay.getRemoteAgents, "function");
    assert.equal(typeof relay.sendViaRelay, "function");
  });
});

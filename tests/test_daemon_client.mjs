/**
 * daemon-client — the MCP side of the socket link, tested against a real in-process daemon.
 *   1. ensureDaemon launches a daemon when none is running, and is a no-op when one exists.
 *   2. connectToDaemon receives wake pushes when the agent's inbox changes.
 *   3. the client auto-reconnects after the daemon restarts (backend restart ≠ MCP restart).
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import * as daemon from "../channel/daemon.mjs";
import { ensureDaemon, connectToDaemon } from "../channel/daemon-client.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freshBridge() { return mkdtempSync(join(tmpdir(), "cc2cc-dc-")); }
function poke(bridge, agent, id = "m1") {
  const inbox = join(bridge, `to-${agent}`, "inbox");
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, `relay-${id}.json`), JSON.stringify({ text: "hi" }));
}

test("ensureDaemon: no-op when a daemon already owns the socket", async () => {
  const bridge = freshBridge();
  const handle = await daemon.main({ bridgeDir: bridge, team: null, self: null });
  try {
    const r = await ensureDaemon({ bridgeDir: bridge });
    assert.strictEqual(r.launched, false, "did not launch a second daemon");
  } finally {
    await handle.stop();
  }
});

test("connectToDaemon: gets a catch-up wake on hello (reconnect never misses mail)", async () => {
  const bridge = freshBridge();
  const handle = await daemon.main({ bridgeDir: bridge, team: null, self: null });
  const wakes = [];
  // A message that landed BEFORE this client connects (wake fired to nobody).
  poke(bridge, "carol", "pre");
  const client = connectToDaemon({ bridgeDir: bridge, agent: "carol", onWake: (m) => wakes.push(m) });
  try {
    await sleep(300);                 // hello → welcome → catch-up wake
    assert.ok(wakes.some((w) => w.agent === "carol"), "client got a catch-up wake on connect");
  } finally {
    client.close();
    await handle.stop();
  }
});

test("connectToDaemon: receives wake on inbox change", async () => {
  const bridge = freshBridge();
  const handle = await daemon.main({ bridgeDir: bridge, team: null, self: null });
  const wakes = [];
  const client = connectToDaemon({ bridgeDir: bridge, agent: "alice", onWake: (m) => wakes.push(m) });
  try {
    await sleep(200);                 // let hello complete
    poke(bridge, "alice");
    await sleep(400);                 // let watcher → wake propagate
    assert.ok(wakes.some((w) => w.agent === "alice"), "client got a wake for alice");
  } finally {
    client.close();
    await handle.stop();
  }
});

test("connectToDaemon: auto-reconnects after daemon restart", async () => {
  const bridge = freshBridge();
  let handle = await daemon.main({ bridgeDir: bridge, team: null, self: null });
  const statuses = [];
  const wakes = [];
  const client = connectToDaemon({
    bridgeDir: bridge, agent: "bob",
    onWake: (m) => wakes.push(m),
    onStatus: (s) => statuses.push(s),
  });
  try {
    await sleep(200);
    assert.ok(statuses.includes("connected"), "initially connected");

    // Restart the backend — the client should reconnect on its own.
    await handle.stop();
    await sleep(150);
    handle = await daemon.main({ bridgeDir: bridge, team: null, self: null });
    await sleep(800);                 // allow reconnect (backoff) + hello

    poke(bridge, "bob");
    await sleep(500);
    assert.ok(wakes.some((w) => w.agent === "bob"), "got a wake after reconnect");
  } finally {
    client.close();
    await handle.stop();
  }
});

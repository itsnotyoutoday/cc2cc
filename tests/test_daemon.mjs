/**
 * Daemon unit tests — the two NEW behaviors the daemon adds over the relay:
 *   1. IPC socket: an MCP connects, says hello, gets a welcome.
 *   2. Watcher → push: a new file in to-<agent>/inbox fires a {wake, agent} to that MCP.
 *   3. Single-instance: a second daemon on the same socket bows out.
 * Relay behavior itself is covered by the existing relay/hub tests.
 */
import { test } from "node:test";
import assert from "node:assert";
import net from "net";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Static import — daemon.mjs guards main() on argv, so importing won't auto-run it.
import * as mod from "../channel/daemon.mjs";

// We exercise the socket+watcher by running main() against a temp bridge with no relay
// (CC2CC_TEAM unset → relay idle), so the test never touches the network.
function freshBridge() {
  const dir = mkdtempSync(join(tmpdir(), "cc2cc-daemon-"));
  return dir;
}

function connectMcp(socketPath, agent) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    const events = [];
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ type: "hello", agent }) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (raw.trim()) events.push(JSON.parse(raw));
      }
    });
    sock.on("error", reject);
    setTimeout(() => resolve({ sock, events }), 150);
  });
}

test("daemon: socket path is per-bridge and deterministic", () => {
  const a = mod.daemonSocketPath("/tmp/bridgeA");
  const b = mod.daemonSocketPath("/tmp/bridgeB");
  assert.notStrictEqual(a, b);
  assert.strictEqual(mod.daemonSocketPath("/tmp/bridgeA"), a);
});

test("daemon: hello → welcome, and inbox write → wake push", async () => {
  const bridge = freshBridge();
  // team:null keeps the relay idle (no network) — we're only exercising socket + watcher.
  const handle = await mod.main({ bridgeDir: bridge, team: null, self: null });
  assert.ok(handle, "daemon started");

  try {
    // MCP connects as agent "alice".
    const { sock, events } = await connectMcp(handle.socketPath, "alice");
    assert.ok(events.some((e) => e.type === "welcome" && e.agent === "alice"), "got welcome");

    // Drop a message into alice's inbox → expect a wake push.
    const inbox = join(bridge, "to-alice", "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "relay-test.json"), JSON.stringify({ text: "hi" }));

    await new Promise((r) => setTimeout(r, 400)); // let fs.watch fire
    assert.ok(events.some((e) => e.type === "wake" && e.agent === "alice"), "got wake for alice");
    sock.end();
  } finally {
    await handle.stop();
  }
});

test("daemon: single-instance — second start on same bridge bows out", async () => {
  const bridge = freshBridge();
  const first = await mod.main({ bridgeDir: bridge, team: null, self: null });
  assert.ok(first, "first daemon owns the socket");
  try {
    const second = await mod.main({ bridgeDir: bridge, team: null, self: null });
    assert.strictEqual(second, null, "second daemon detects the live socket and bows out");
  } finally {
    await first.stop();
  }
});

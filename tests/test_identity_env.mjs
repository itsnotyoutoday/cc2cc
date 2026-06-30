/**
 * Identity-from-env tests: verify the launch-time team-assignment mechanism.
 *
 * cc-launch sets CC2CC_IDENTITY=<name> on the claude process, which Claude Code
 * forwards into the MCP server's environment. The server must:
 *   - take its name from CC2CC_IDENTITY (or legacy SELF),
 *   - store identity per-name (identity-<name>.json) so multiple agents share one
 *     bridge with distinct identities,
 *   - seed teams/role from CC2CC_TEAM (comma-separated) / CC2CC_ROLE,
 *   - fall back to a generated name + legacy identity.json when no name is given.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "channel", "server.mjs");

// Strip any cc2cc identity env inherited from the runner (e.g. when tests run inside a live
// cc2cc session that exports CC2CC_IDENTITY/CC2CC_TEAM) — otherwise CC2CC_IDENTITY would win over
// a test's SELF=, naming the wrong agent. Each test supplies exactly the vars it means to test.
function cleanEnv(extra) {
  const e = { ...process.env, ...extra };
  for (const k of ["CC2CC_IDENTITY", "SELF", "CC2CC_TEAM", "CC2CC_ROLE"]) {
    if (!(k in (extra || {}))) delete e[k];
  }
  return e;
}

/** Spawn the server on a fresh bridge with the given env; resolve once the
 *  expected identity file exists (or reject on timeout). Always kills the proc. */
async function bootServer(env, identityFileName, { timeoutMs = 8000 } = {}) {
  const bridge = await mkdtemp(join(tmpdir(), "cc2cc-idtest-"));
  const child = spawn("node", [SERVER], {
    env: cleanEnv({ CC2CC_BRIDGE_DIR: bridge, ...env }),
    stdio: ["pipe", "pipe", "pipe"], // keep stdin open so the stdio transport stays alive
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  child.stdout.on("data", () => {}); // drain so the transport never backpressures
  // 0f: mesh activation (which writes the identity file) is gated on a real MCP initialize
  // handshake — a bare spawn no longer auto-joins. Complete the handshake so the env-driven
  // identity actually materializes.
  const send = (m) => { try { child.stdin.write(JSON.stringify(m) + "\n"); } catch {} };
  send({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "idtest", version: "1" } } });
  await new Promise((r) => setTimeout(r, 200));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const idPath = join(bridge, "identities", identityFileName);
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      try {
        const raw = await readFile(idPath, "utf8");
        const identity = JSON.parse(raw);
        // Heartbeat is written later in init() than the identity file — wait for it
        // too (until the deadline) so callers can assert on it without racing.
        let heartbeat = null;
        try {
          heartbeat = JSON.parse(
            await readFile(join(bridge, "status", `${identity.display_name}-heartbeat.json`), "utf8"),
          );
        } catch { /* not yet */ }
        if (!heartbeat && Date.now() <= deadline) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        const files = await readdir(join(bridge, "identities"));
        return { bridge, identity, files, heartbeat, stderr };
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${identityFileName}; stderr:\n${stderr}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  } finally {
    child.kill("SIGKILL");
    await rm(bridge, { recursive: true, force: true });
  }
}

describe("identity from launch env (CC2CC_IDENTITY / CC2CC_TEAM / CC2CC_ROLE)", () => {

  it("CC2CC_IDENTITY → per-name identity file with name/team (role=member; leadership via teams.json)", async () => {
    const { identity, files, heartbeat } = await bootServer(
      { CC2CC_IDENTITY: "alpha-lead", CC2CC_TEAM: "alpha" },
      "identity-alpha-lead.json",
    );
    assert.equal(identity.display_name, "alpha-lead");
    assert.deepEqual(identity.teams, ["alpha"]);
    assert.ok(!("role" in identity), "identity carries no role (derived from teams.json)");
    assert.ok(files.includes("identity-alpha-lead.json"), "per-name identity file present");
    assert.ok(!files.includes("identity.json"), "must NOT create legacy identity.json when named");
    assert.ok(heartbeat, "heartbeat written");
    assert.deepEqual(heartbeat.teams, ["alpha"]);
    assert.ok(!("role" in heartbeat), "heartbeat carries no role");
  });

  it("member default + multi-team CC2CC_TEAM (comma-separated)", async () => {
    const { identity } = await bootServer(
      { CC2CC_IDENTITY: "beta-mem", CC2CC_TEAM: "beta, gamma" },
      "identity-beta-mem.json",
    );
    assert.equal(identity.display_name, "beta-mem");
    assert.deepEqual(identity.teams, ["beta", "gamma"]);
    assert.ok(!("role" in identity), "identity carries no role");
  });

  it("legacy SELF alias still names the agent", async () => {
    const { identity } = await bootServer(
      { SELF: "legacy-self", CC2CC_TEAM: "alpha" },
      "identity-legacy-self.json",
    );
    assert.equal(identity.display_name, "legacy-self");
    assert.deepEqual(identity.teams, ["alpha"]);
  });

  it("no identity env → DORMANT (no identity, no heartbeat; opt-in only)", async () => {
    // Opt-in policy: a session launched without CC2CC_IDENTITY/SELF must NOT join the mesh.
    const bridge = await mkdtemp(join(tmpdir(), "cc2cc-idtest-dormant-"));
    const child = spawn("node", [SERVER], {
      env: cleanEnv({ CC2CC_BRIDGE_DIR: bridge }), // no CC2CC_IDENTITY/SELF
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      await new Promise((r) => setTimeout(r, 3500)); // give it time to (not) join
      let identityFiles = [];
      try { identityFiles = await readdir(join(bridge, "identities")); } catch { /* no dir = dormant */ }
      assert.deepEqual(identityFiles, [], "dormant: no identity file created");
      let hbs = [];
      try { hbs = await readdir(join(bridge, "status")); } catch { /* no status dir at all is fine */ }
      assert.equal(hbs.filter((f) => f.endsWith("-heartbeat.json")).length, 0, "dormant: no heartbeat written");
    } finally {
      child.kill("SIGKILL");
      await rm(bridge, { recursive: true, force: true });
    }
  });

  it("two named agents coexist on ONE bridge with distinct identities", async () => {
    // Share a single bridge dir across two boots; both per-name files must persist.
    const bridge = await mkdtemp(join(tmpdir(), "cc2cc-idtest-share-"));
    const boot = (env, file) => new Promise(async (resolve, reject) => {
      const child = spawn("node", [SERVER], {
        env: cleanEnv({ CC2CC_BRIDGE_DIR: bridge, ...env }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.on("data", () => {});
      // 0f: complete the MCP handshake so the env-driven identity activates.
      const send = (m) => { try { child.stdin.write(JSON.stringify(m) + "\n"); } catch {} };
      send({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "idtest", version: "1" } } });
      setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }), 200);
      const idPath = join(bridge, "identities", file);
      const deadline = Date.now() + 8000;
      for (;;) {
        try { const id = JSON.parse(await readFile(idPath, "utf8")); child.kill("SIGKILL"); return resolve(id); }
        catch { if (Date.now() > deadline) { child.kill("SIGKILL"); return reject(new Error(`timeout ${file}`)); }
          await new Promise((r) => setTimeout(r, 100)); }
      }
    });
    try {
      const a = await boot({ CC2CC_IDENTITY: "alpha-lead", CC2CC_TEAM: "alpha", CC2CC_ROLE: "leader" }, "identity-alpha-lead.json");
      const b = await boot({ CC2CC_IDENTITY: "beta-lead", CC2CC_TEAM: "beta", CC2CC_ROLE: "leader" }, "identity-beta-lead.json");
      assert.equal(a.teams[0], "alpha");
      assert.equal(b.teams[0], "beta");
      assert.notEqual(a.agent_id, b.agent_id, "distinct identities");
      const files = await readdir(join(bridge, "identities"));
      assert.ok(files.includes("identity-alpha-lead.json") && files.includes("identity-beta-lead.json"),
        "both per-name identity files coexist on one bridge");
    } finally {
      await rm(bridge, { recursive: true, force: true });
    }
  });
});

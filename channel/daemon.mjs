#!/usr/bin/env node
/**
 * cc2cc Bridge Daemon — ONE per host. The only networking + watching process.
 *
 *   ( HUB ) ◄──relay──► ( DAEMON ) ◄──socket──► ( MCP, per Claude session )
 *
 * Responsibilities:
 *   1. RELAY — owns the single hub connection (register / poll / heartbeat / outbox-drain /
 *      teams-sync). Reuses channel/relay.mjs. Encryption boundary (channel/crypto.mjs):
 *      encrypts outbound; hub only ever sees ciphertext (zero-knowledge).
 *   2. WATCHER — the SOLE mailbox file-watcher. No MCP watches files.
 *   3. PUSH — on an inbox change for agent X, pushes a {wake} over the local IPC socket to
 *      X's MCP, which then pings its own Claude session.
 *
 * Single-instance: binds one socket per bridge; a second daemon detects the live socket and
 * exits. The MCP may auto-launch this (exception, not the rule). Restartable independently of
 * Claude — the MCP just reconnects.
 *
 * Env / args:
 *   CC2CC_BRIDGE_DIR   bridge dir (default ~/.cc2cc)
 *   CC2CC_TEAM         team this host registers with the hub (for self-team inbound routing)
 *   CC2CC_IDENTITY     representative local agent name (self-team inbound routing target)
 *   --foreground       log to stderr (default; daemon is normally spawned detached)
 */
import net from "net";
import { watch } from "fs";
import { mkdir, unlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { fileURLToPath } from "url";

import * as crypto from "./crypto.mjs";
import {
  loadRelayConfig,
  setEncryptionFunction,
  startRelayClient,
  stopRelayClient,
  getRelayStatus,
} from "./relay.mjs";

// Defaults resolved at main() call-time (from opts || env) so the daemon is testable.
function resolveConfig(opts = {}) {
  return {
    bridgeDir: opts.bridgeDir || process.env.CC2CC_BRIDGE_DIR || join(homedir(), ".cc2cc"),
    team: opts.team ?? process.env.CC2CC_TEAM ?? null,
    self: opts.self ?? process.env.CC2CC_IDENTITY ?? process.env.CC2CC_SELF ?? null,
  };
}

function log(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, msg, ...(extra || {}) };
  process.stderr.write(`[daemon] ${JSON.stringify(line)}\n`);
}

/**
 * Platform-appropriate IPC endpoint for this bridge:
 *   - unix/mac: <bridge>/daemon.sock
 *   - windows : \\.\pipe\cc2cc-<bridge-hash>  (named pipe; sockets can't live on disk)
 */
export function daemonSocketPath(bridgeDir) {
  if (platform() === "win32") {
    let h = 0;
    for (const c of bridgeDir) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `\\\\.\\pipe\\cc2cc-${h.toString(16)}`;
  }
  return join(bridgeDir, "daemon.sock");
}

// ─── MCP connection registry ─────────────────────────────────────────────────
// agent name → Set<socket>. An MCP says {type:"hello", agent} on connect; the daemon then
// knows which socket to wake when that agent's inbox changes.
const conns = new Map();
const allSockets = new Set(); // every live socket, so stop() can force them closed

function addConn(agent, sock) {
  if (!conns.has(agent)) conns.set(agent, new Set());
  conns.get(agent).add(sock);
}
function dropConn(sock) {
  for (const [agent, set] of conns) {
    if (set.delete(sock) && set.size === 0) conns.delete(agent);
  }
}
function pushToAgent(agent, payload) {
  const set = conns.get(agent);
  if (!set || !set.size) return 0;
  const line = JSON.stringify(payload) + "\n";
  let n = 0;
  for (const sock of set) {
    try { sock.write(line); n++; } catch { /* dead socket; cleaned on close */ }
  }
  return n;
}

// ─── IPC socket server ───────────────────────────────────────────────────────
function handleConnection(sock) {
  allSockets.add(sock);
  sock.setEncoding("utf8");
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!raw.trim()) continue;
      let m;
      try { m = JSON.parse(raw); } catch { continue; }
      if (m.type === "hello" && m.agent) {
        addConn(m.agent, sock);
        log("info", "mcp connected", { agent: m.agent });
        try { sock.write(JSON.stringify({ type: "welcome", agent: m.agent }) + "\n"); } catch {}
      } else if (m.type === "ping") {
        try { sock.write(JSON.stringify({ type: "pong" }) + "\n"); } catch {}
      }
    }
  });
  sock.on("error", () => {});
  sock.on("close", () => { dropConn(sock); allSockets.delete(sock); });
}

/**
 * Bind the IPC socket, ensuring single-instance. If a live daemon already owns it, returns
 * null (caller should exit). Clears a stale socket file left by a crashed daemon.
 */
async function bindSocket(socketPath) {
  // Probe an existing socket: if something answers, a daemon is live → bail.
  if (platform() !== "win32" && existsSync(socketPath)) {
    const alive = await new Promise((resolve) => {
      const probe = net.connect(socketPath);
      probe.on("connect", () => { probe.end(); resolve(true); });
      probe.on("error", () => resolve(false));
    });
    if (alive) return null;
    await unlink(socketPath).catch(() => {}); // stale — remove it
  }
  const server = net.createServer(handleConnection);
  const ok = await new Promise((resolve) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") resolve(false);
      else { log("error", "socket error", { error: err.message }); resolve(false); }
    });
    server.listen(socketPath, () => resolve(true));
  });
  return ok ? server : null;
}

// ─── Mailbox watcher ─────────────────────────────────────────────────────────
// Watch the bridge recursively; a new file under to-<agent>/inbox/ → wake that agent's MCP.
const INBOX_RE = /(?:^|\/)to-([^/]+)\/inbox\/[^/]+\.json$/;

function startWatcher(bridgeDir) {
  let watcher;
  try {
    watcher = watch(bridgeDir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const rel = filename.split("\\").join("/"); // normalize win32 separators
      const match = rel.match(INBOX_RE);
      if (!match) return;
      const agent = match[1];
      const n = pushToAgent(agent, { type: "wake", agent });
      log("debug", "inbox change → wake", { agent, file: rel, pushedTo: n });
    });
    log("info", "watching bridge", { dir: bridgeDir });
  } catch (err) {
    log("error", "watch failed (recursive unsupported?)", { error: err.message });
  }
  return watcher;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────
let server = null;
let watcher = null;
let stampTimer = null;
let running = null; // { bridgeDir, socketPath }

/** Tear down server/watcher/relay/socket. Returns when closed; does NOT exit the process. */
export async function stop() {
  try { stopRelayClient(); } catch {}
  try { clearInterval(stampTimer); } catch {}
  try { watcher?.close(); } catch {}
  for (const sock of allSockets) { try { sock.destroy(); } catch {} }
  allSockets.clear();
  await new Promise((r) => (server ? server.close(() => r()) : r()));
  if (running && platform() !== "win32") await unlink(running.socketPath).catch(() => {});
  server = null; watcher = null; running = null;
}

/**
 * Start the daemon. Returns a handle { socketPath, stop } on success, or null if another
 * daemon already owns the socket. Never calls process.exit — the CLI wrapper does that.
 */
export async function main(opts = {}) {
  const cfg = resolveConfig(opts);
  await mkdir(cfg.bridgeDir, { recursive: true }).catch(() => {});
  const socketPath = daemonSocketPath(cfg.bridgeDir);

  server = await bindSocket(socketPath);
  if (!server) {
    log("info", "another daemon owns the socket", { socket: socketPath });
    return null;
  }
  running = { bridgeDir: cfg.bridgeDir, socketPath };
  log("info", "daemon up", { socket: socketPath, team: cfg.team, self: cfg.self });

  // Encryption boundary: outbound is encrypted before it leaves on the relay.
  await crypto.loadKey(cfg.bridgeDir);
  setEncryptionFunction(crypto.encryptText);
  log("info", "crypto", { hasKey: crypto.hasKey() });

  // Relay: own the single hub connection for this host.
  const relayCfg = await loadRelayConfig(cfg.bridgeDir);
  if (relayCfg && relayCfg.enabled !== false && cfg.team) {
    startRelayClient(cfg.bridgeDir, cfg.team, relayCfg, cfg.self);
    log("info", "relay started", getRelayStatus());
  } else {
    log("info", "relay idle", { reason: !cfg.team ? "no CC2CC_TEAM" : "relay disabled/unconfigured" });
  }

  watcher = startWatcher(cfg.bridgeDir);

  // Liveness stamp so MCPs / tooling can see the daemon is current.
  await mkdir(join(cfg.bridgeDir, "status"), { recursive: true }).catch(() => {});
  const stampPath = join(cfg.bridgeDir, "status", "daemon.json");
  const stamp = async () => {
    await writeFile(stampPath, JSON.stringify({
      pid: process.pid, socket: socketPath, team: cfg.team, self: cfg.self,
      ts: Date.now(), relay: getRelayStatus?.() ?? null,
    }, null, 2), "utf8").catch(() => {});
  };
  await stamp();
  stampTimer = setInterval(stamp, 15000);
  stampTimer.unref();

  return { socketPath, stop };
}

// Only auto-run (and own process lifecycle) when this file IS the entry point — exact path
// match (NOT endsWith, which would also match e.g. tests/test_daemon.mjs on import).
const invokedDirectly = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((handle) => {
      if (!handle) { log("info", "exiting — daemon already running"); process.exit(0); }
      process.on("SIGINT", async () => { await stop(); process.exit(0); });
      process.on("SIGTERM", async () => { await stop(); process.exit(0); });
    })
    .catch((err) => { log("error", "fatal", { error: err.message }); process.exit(1); });
}

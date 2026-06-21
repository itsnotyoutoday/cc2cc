#!/usr/bin/env node
/**
 * cc2cc Bridge Daemon — ONE per host. The only networking + watching process.
 *
 *   ( HUB ) ◄──relay──► ( DAEMON ) ◄──socket──► ( MCP, per Claude session )
 *
 * Responsibilities:
 *   1. RELAY — owns the single hub connection (register / poll / heartbeat / outbox-drain /
 *      teams-sync). Reuses channel/relay.mjs. The daemon relays already-encrypted ciphertext
 *      as-is: the MCP (server.mjs) encrypts at outbox spool and decrypts on inbox read, so the
 *      hub stays zero-knowledge. The daemon is NOT currently the crypto boundary.
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
import { existsSync, statSync, readFileSync } from "fs";
import { spawn } from "child_process";
import { join } from "path";
import { homedir, platform } from "os";
import { fileURLToPath } from "url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Ad-hoc daemons self-exit after this long with ZERO MCP connections (cleans up unused/zombie
// daemons). DISABLED in service mode (CC2CC_SERVICE_MODE=1 / --service), where always-on is the
// point and a manager (systemd / cc2cc-admin) owns the lifecycle.
const IDLE_EXIT_MS = Number(process.env.CC2CC_DAEMON_IDLE_MS) || 10 * 60 * 1000;
function isServiceMode(opts = {}) {
  if (opts.service != null) return !!opts.service;
  const v = process.env.CC2CC_SERVICE_MODE;
  return v === "1" || v === "true";
}

import {
  loadRelayConfig,
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

/**
 * A "managed" bridge is a global/system install whose daemon lifecycle is owned by a service
 * manager (systemd) running as a dedicated service user. The installer drops a service.json marker.
 * On a managed bridge, per-user Claude sessions must NOT spawn or auto-heal their own daemon, and a
 * daemon launched by the wrong OS user must refuse to bind — otherwise an individual session can
 * hijack the shared socket (wrong-owner files, ad-hoc idle-exit killing the relay, EADDRINUSE
 * fighting systemd). Returns null when not managed, else the parsed marker { managed, service_user }.
 */
export function readServiceMarker(bridgeDir) {
  try {
    const m = JSON.parse(readFileSync(join(bridgeDir, "service.json"), "utf8"));
    return m && m.managed ? m : null;
  } catch { return null; }
}

/**
 * May the current process legitimately OWN (bind) the daemon for this bridge?
 * On an unmanaged (local) bridge: always yes. On a managed bridge: ONLY the service user, matched by
 * the bridge dir's owning uid (systemd runs the daemon as that user). Note root is NOT exempt — in a
 * shared install a human account that merely happens to run as root (e.g. an agent session) is not
 * the daemon manager, and letting it bind would race the service for the socket. For genuine
 * maintenance, run as the service user (`sudo -u <service_user>`). Set CC2CC_DAEMON_FORCE=1 to
 * override. Windows has no uid model, so ownership is not enforced there.
 */
export function daemonOwnershipCheck(bridgeDir) {
  if (!readServiceMarker(bridgeDir)) return { ok: true };
  if (process.env.CC2CC_DAEMON_FORCE === "1") return { ok: true };
  if (platform() === "win32" || typeof process.getuid !== "function") return { ok: true };
  const me = process.getuid();
  let ownerUid;
  try { ownerUid = statSync(bridgeDir).uid; } catch { return { ok: true }; } // can't stat → don't block
  if (me === ownerUid) return { ok: true };
  return { ok: false, reason: `managed bridge owned by uid ${ownerUid}; refusing to bind as uid ${me} (only the service user may own the daemon; use 'sudo -u' or CC2CC_DAEMON_FORCE=1 for maintenance)` };
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
  lastActivity = Date.now(); // a session connected → reset the idle clock
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
        // Catch-up wake: mail that arrived while this agent had no live connection fired a
        // watcher wake "to nobody". Nudge the (re)connecting MCP to poll now so a reconnect
        // never misses already-delivered mail. The poll is idempotent, so an extra wake is safe.
        try { sock.write(JSON.stringify({ type: "wake", agent: m.agent }) + "\n"); } catch {}
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
  // M6: bind FIRST to avoid a TOCTOU window. The old probe→unlink→listen order let a second
  // starter unlink a socket the first starter had just bound (orphaning a live daemon). Only
  // unlink after a probe that CONFIRMS the in-use socket is dead.
  const tryListen = () => new Promise((resolve) => {
    const server = net.createServer(handleConnection);
    // On a failed bind, CLOSE the server so its handle doesn't leak (an un-closed Server keeps the
    // event loop alive — the post-suite hang). Only a successfully-listening server is returned.
    server.once("error", (err) => { try { server.close(); } catch { /* not running */ } resolve({ err }); });
    server.listen(socketPath, () => resolve({ server }));
  });

  let r = await tryListen();
  if (r.server) return r.server;
  if (r.err?.code !== "EADDRINUSE" && r.err?.code !== "EEXIST") {
    log("error", "socket error", { error: r.err?.message });
    return null;
  }
  // Address in use → is a LIVE daemon holding it?
  if (platform() === "win32") return null; // named pipe in use → assume a live owner
  const alive = await new Promise((resolve) => {
    const probe = net.connect(socketPath);
    // destroy() (not end()) so the probe socket handle is released immediately, not left half-open.
    probe.on("connect", () => { probe.destroy(); resolve(true); });
    probe.on("error", () => { probe.destroy(); resolve(false); });
  });
  if (alive) return null; // a real daemon owns it → we bail
  // Confirmed dead → remove the stale socket and retry binding ONCE.
  await unlink(socketPath).catch(() => {});
  r = await tryListen();
  return r.server || null;
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
let idleTimer = null;
let lastActivity = Date.now(); // last MCP socket activity; drives ad-hoc idle-exit
let running = null; // { bridgeDir, socketPath }

// Ad-hoc idle-exit: once nothing has connected for IDLE_EXIT_MS, tear down and exit. A new
// session's ensureDaemon relaunches on demand. No-op in service mode.
function startIdleExit(serviceMode) {
  if (serviceMode) return;
  // Check often enough to honor short windows (tests) but never busier than every 30s.
  const checkMs = Math.min(30000, Math.max(1000, Math.floor(IDLE_EXIT_MS / 4)));
  idleTimer = setInterval(async () => {
    if (allSockets.size > 0) { lastActivity = Date.now(); return; } // a live MCP → not idle
    if (Date.now() - lastActivity >= IDLE_EXIT_MS) {
      log("info", "idle-exit — no MCP connections", { idleMs: IDLE_EXIT_MS });
      await stop();
      process.exit(0);
    }
  }, checkMs);
  idleTimer.unref();
}

/** Tear down server/watcher/relay/socket. Returns when closed; does NOT exit the process. */
export async function stop() {
  try { stopRelayClient(); } catch {}
  try { clearInterval(stampTimer); } catch {}
  try { clearInterval(idleTimer); } catch {}
  try { watcher?.close(); } catch {}
  for (const sock of allSockets) { try { sock.destroy(); } catch {} }
  allSockets.clear();
  await new Promise((r) => (server ? server.close(() => r()) : r()));
  if (running && platform() !== "win32") {
    // M6: only remove the socket file if it's still the inode WE bound — a racing daemon may have
    // replaced it, and we must never unlink a live socket we no longer own.
    try {
      if (running.ino == null || statSync(running.socketPath).ino === running.ino) {
        await unlink(running.socketPath).catch(() => {});
      }
    } catch { /* already gone */ }
  }
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

  // Anti-takeover guard: on a managed (global) bridge, refuse to bind unless we're the service user
  // (or root). This stops an individual user session's auto-spawn/auto-heal from hijacking the
  // shared system socket with a wrong-owner, idle-exiting ad-hoc daemon.
  const own = daemonOwnershipCheck(cfg.bridgeDir);
  if (!own.ok) {
    log("error", "refusing to start on managed bridge", { reason: own.reason, socket: socketPath });
    return null;
  }

  // Assign the module-level `server` only on success: a second in-process main() that bows out
  // (bindSocket → null) must NOT clobber a running daemon's server reference, or that daemon's
  // stop() would see null and never close its server (leaking the handle → node hangs post-test).
  const bound = await bindSocket(socketPath);
  if (!bound) {
    log("info", "another daemon owns the socket", { socket: socketPath });
    return null;
  }
  server = bound;
  const serviceMode = isServiceMode(opts);
  let socketIno = null;
  try { socketIno = statSync(socketPath).ino; } catch { /* raced away already */ }
  running = { bridgeDir: cfg.bridgeDir, socketPath, ino: socketIno };
  log("info", "daemon up", { socket: socketPath, team: cfg.team, self: cfg.self, mode: serviceMode ? "service" : "adhoc" });

  // Crypto is performed by the MCP (server.mjs): it encrypts before spooling to the outbox and
  // decrypts on inbox read. The daemon just relays the already-encrypted payload, so the hub
  // stays zero-knowledge and the daemon needs no key. (M2: removed dead daemon-side wiring.)

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
      mode: serviceMode ? "service" : "adhoc",
      ts: Date.now(), relay: getRelayStatus?.() ?? null,
    }, null, 2), "utf8").catch(() => {});
  };
  await stamp();
  stampTimer = setInterval(stamp, 15000);
  stampTimer.unref();

  startIdleExit(serviceMode); // ad-hoc: self-exit when idle; service: stays alive

  return { socketPath, stop };
}

// ─── CLI control (cc2cc-admin daemon … wraps these) ──────────────────────────
function statusStampPath() { return join(resolveConfig().bridgeDir, "status", "daemon.json"); }
function readStamp() { try { return JSON.parse(readFileSync(statusStampPath(), "utf8")); } catch { return null; } }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function daemonStatusCmd() {
  const s = readStamp();
  if (!s || !pidAlive(s.pid)) { console.log(JSON.stringify({ running: false })); return; }
  console.log(JSON.stringify({ running: true, pid: s.pid, mode: s.mode || "adhoc",
    socket: s.socket, team: s.team, self: s.self, relay: s.relay?.enabled ?? null }, null, 2));
}
async function daemonStopCmd() {
  const s = readStamp();
  if (!s || !pidAlive(s.pid)) { console.log("daemon not running"); return; }
  try { process.kill(s.pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 50 && pidAlive(s.pid); i++) await sleep(100); // wait ≤5s for clean stop()
  console.log(pidAlive(s.pid) ? `daemon ${s.pid} did not stop` : `stopped daemon ${s.pid}`);
}
function daemonStartCmd({ service }) {
  // Launch a detached daemon and return — the no-systemd equivalent of how a service manager
  // would start it. `service` → always-on (no idle-exit). If one already owns the socket, the
  // child's main() bows out cleanly.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...(service ? ["--service"] : [])],
    { detached: true, stdio: "ignore", env: { ...process.env, ...(service ? { CC2CC_SERVICE_MODE: "1" } : {}) } });
  child.unref();
  console.log(`launched daemon (pid ${child.pid}${service ? ", service mode" : ", ad-hoc"})`);
}
async function daemonRestartCmd() {
  const wasService = readStamp()?.mode === "service";
  await daemonStopCmd();
  await sleep(300);
  daemonStartCmd({ service: wasService }); // preserve the mode it was running in
}

// Only auto-run (and own process lifecycle) when this file IS the entry point — exact path
// match (NOT endsWith, which would also match e.g. tests/test_daemon.mjs on import).
const invokedDirectly = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const arg = process.argv[2];
  // Control verbs (used by cc2cc-admin daemon …); each exits when done.
  if (arg === "--status" || arg === "status") { daemonStatusCmd(); process.exit(0); }
  else if (arg === "--stop" || arg === "stop") { daemonStopCmd().then(() => process.exit(0)); }
  else if (arg === "--restart" || arg === "restart") { daemonRestartCmd().then(() => process.exit(0)); }
  else if (arg === "--start" || arg === "start") {
    // detached launch + return; --service for always-on (no idle-exit)
    daemonStartCmd({ service: process.argv.includes("--service") }); process.exit(0);
  } else {
    // Foreground run. Bare = ad-hoc (idle-exit). --service = always-on (no idle-exit).
    main({ service: arg === "--service" || isServiceMode() })
      .then((handle) => {
        if (!handle) { log("info", "exiting — daemon already running"); process.exit(0); }
        process.on("SIGINT", async () => { await stop(); process.exit(0); });
        process.on("SIGTERM", async () => { await stop(); process.exit(0); });
      })
      .catch((err) => { log("error", "fatal", { error: err.message }); process.exit(1); });
  }
}

/**
 * Daemon client — the MCP (channel/server.mjs) side of the MCP◄──►Daemon socket link.
 *
 *   - ensureDaemon():    if no daemon owns the socket, launch one (detached). Exception, not
 *                        the rule — normally a daemon is already running per host.
 *   - connectToDaemon(): connect, say {hello, agent}, and invoke onWake() whenever the daemon
 *                        pushes {wake} for this agent (i.e. its inbox changed). Auto-reconnects.
 *
 * The MCP does NOT watch files or talk to the hub; it just reacts to wakes and pings its own
 * Claude session. Cross-platform: the socket path is unix socket / Windows named pipe.
 */
import net from "net";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { daemonSocketPath } from "./daemon.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = join(HERE, "daemon.mjs");

function probe(socketPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    const s = net.connect(socketPath);
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.once("connect", () => done(true));
    s.once("error", () => resolve(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

/**
 * Ensure a daemon owns the socket for this bridge. If one is already live, returns
 * { launched:false }. Otherwise spawns a detached daemon and waits for it to come up.
 * @param {object} opts { bridgeDir, env } — env should carry CC2CC_BRIDGE_DIR/TEAM/IDENTITY.
 */
export async function ensureDaemon({ bridgeDir, env = process.env, waitMs = 3000 } = {}) {
  const socketPath = daemonSocketPath(bridgeDir);
  if (await probe(socketPath)) return { launched: false, socketPath };

  const child = spawn(process.execPath, [DAEMON_PATH], {
    detached: true,
    stdio: "ignore",
    env: { ...env, CC2CC_BRIDGE_DIR: bridgeDir },
  });
  child.unref();

  // Wait for the socket to accept connections.
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await probe(socketPath)) return { launched: true, socketPath, pid: child.pid };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { launched: true, socketPath, pid: child.pid, ready: false };
}

/**
 * Connect to the daemon and react to wake pushes. Returns a handle { close() }.
 * Reconnects with backoff if the daemon restarts (the whole point: backend can restart
 * without the MCP/session restarting).
 */
export function connectToDaemon({ bridgeDir, agent, onWake, onStatus }) {
  const socketPath = daemonSocketPath(bridgeDir);
  let sock = null;
  let closed = false;
  let backoff = 250;
  let reconnectTimer = null; // m9: track the pending reconnect so close() can cancel it

  const emit = (s) => { try { onStatus?.(s); } catch {} };

  function connect() {
    if (closed) return;
    sock = net.connect(socketPath);
    let buf = "";
    sock.setEncoding("utf8");

    sock.on("connect", () => {
      backoff = 250;
      emit("connected");
      try { sock.write(JSON.stringify({ type: "hello", agent }) + "\n"); } catch {}
    });
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!raw.trim()) continue;
        let m; try { m = JSON.parse(raw); } catch { continue; }
        if (m.type === "wake" && (!m.agent || m.agent === agent)) {
          try { onWake?.(m); } catch {}
        }
      }
    });
    sock.on("error", () => {});            // 'close' handles reconnect
    sock.on("close", () => {
      if (closed) return;
      emit("disconnected");
      // m9: add jitter so many MCPs sharing a daemon don't reconnect in lockstep after a restart.
      const delay = backoff + Math.floor(Math.random() * backoff);
      reconnectTimer = setTimeout(connect, delay);
      backoff = Math.min(backoff * 2, 5000);
    });
  }

  connect();
  return {
    socketPath,
    close() {
      closed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } // m9
      try { sock?.destroy(); } catch {}
    },
  };
}

/**
 * Reusable test fixture: start a CC2CC Relay Hub on a free ephemeral port.
 *
 * Usage:
 *   import { startHub } from "./helpers/hub.mjs";
 *   const hub = await startHub({ token: "my-token" });
 *   // ... hub.url, hub.port, hub.token ...
 *   await hub.stop();
 *
 * The python interpreter is `process.env.PYTHON || "python3"`. If python (or its
 * deps, e.g. fastapi/uvicorn) is missing, startHub throws a clear error.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HUB_PY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "relay_hub.py");

/** Pick a free ephemeral port by binding to 0 and reading the assigned port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startHub({ token } = {}) {
  if (!token) throw new Error("startHub: a token is required");

  const python = process.env.PYTHON || "python3";
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  const proc = spawn(
    python,
    [HUB_PY, "--host", "127.0.0.1", "--port", String(port), "--token", token],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  let exited = null;
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", (d) => { stderr += d.toString(); });
  proc.on("exit", (code, signal) => { exited = { code, signal }; });

  // Poll /health until the hub reports ok (~30 tries x 300ms ≈ 9s).
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    if (exited) break;
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        const body = await res.json();
        if (body.status === "ok") { healthy = true; break; }
      }
    } catch {
      // hub not listening yet
    }
    await sleep(300);
  }

  if (!healthy) {
    try { proc.kill("SIGKILL"); } catch {}
    const reason = exited
      ? `hub process exited early (code=${exited.code}, signal=${exited.signal})`
      : "hub did not become healthy within ~9s";
    throw new Error(
      `startHub: ${reason} using interpreter "${python}". ` +
      `Ensure python with fastapi/uvicorn is available (set PYTHON env to override). ` +
      `stderr:\n${stderr.slice(0, 2000)}`,
    );
  }

  return {
    port,
    url,
    token,
    async stop() {
      try { proc.kill("SIGKILL"); } catch {}
    },
  };
}

/**
 * M3: per-machine hub authentication. The shared token still gates access, but each
 * machine_id is additionally bound to a per-machine secret (trust-on-first-use): once a
 * machine has bound a secret, every later request for that machine_id must present it —
 * so a token holder can no longer spoof another machine's identity or drain its queue.
 * Graceful: a machine that never sends a secret stays unbound (opt-in).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHub } from "./helpers/hub.mjs";

const TOKEN = "auth-test-token";
let hub;

const post = (path, body) => fetch(`${hub.url}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const register = (body) => post("/api/register", body);

before(async () => { hub = await startHub({ token: TOKEN }); });
after(async () => { await hub?.stop(); });

test("M3: bad shared token → 401", async () => {
  const r = await register({ token: "WRONG", machine_id: "mX", team: "t", machine_secret: "s" });
  assert.equal(r.status, 401);
});

test("M3: TOFU bind → correct secret 200, wrong secret 403, missing-on-bound 403", async () => {
  assert.equal((await register({ token: TOKEN, machine_id: "m1", team: "t", machine_secret: "s1" })).status, 200,
    "first contact binds m1 → s1");
  assert.equal((await register({ token: TOKEN, machine_id: "m1", team: "t", machine_secret: "s1" })).status, 200,
    "correct secret accepted");
  assert.equal((await register({ token: TOKEN, machine_id: "m1", team: "t", machine_secret: "WRONG" })).status, 403,
    "wrong secret rejected");
  assert.equal((await register({ token: TOKEN, machine_id: "m1", team: "t" })).status, 403,
    "missing secret on a bound machine rejected");
});

test("M3: graceful — an unbound machine with no secret still registers (opt-in)", async () => {
  assert.equal((await register({ token: TOKEN, machine_id: "m2-unbound", team: "t" })).status, 200);
});

test("M3: /api/send cannot spoof a bound from_machine without its secret", async () => {
  assert.equal((await register({ token: TOKEN, machine_id: "m3", team: "t", machine_secret: "s3" })).status, 200,
    "bind m3 → s3");
  const r = await post("/api/send", { token: TOKEN, from_machine: "m3", from_team: "t", to_team: "t", message: { id: "spoof" } });
  assert.equal(r.status, 403, "send as bound m3 without its secret is rejected");
});

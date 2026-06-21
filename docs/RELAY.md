# CC2CC Relay Guide

The **relay** joins agents on different machines into one mesh. It has two roles:

- **Server** — one host runs the **relay hub** (`relay_hub.py`), a zero-knowledge HTTP queue that
  forwards **ciphertext** between machines.
- **Client** — every participating host runs a **daemon** that holds the single hub connection and
  delivers messages into local agents' inboxes.

Encryption is **mandatory** and **end-to-end** (AES-256-GCM): the hub never sees plaintext, and
every peer must share a **byte-identical `secret.key`**. The wire protocol is specified in
[SPECIFICATION.md §10](SPECIFICATION.md#10-relay-protocol).

> Same-machine agents do **not** need the relay — they share a bridge directory directly. The relay
> is only for crossing machines.

---

## Part 1 — Operating a relay server (the hub)

> **Key concept — keep the daemon always-on.** Any node that must be reachable when no Claude
> session is open (a relay/server node, or any peer that should receive while idle) must run its
> **daemon in service mode** — the hub is passive store-and-forward and **cannot wake a daemon**.
> While a node's daemon is down, inbound messages just queue on the hub (~5 days) until it returns.
> The global installer's `cc2cc-daemon` systemd unit runs in service mode; on a host without
> systemd use `cc2cc-admin daemon start --service` (status/restart/stop via the same command).
> See [CONFIGURATION.md → Daemon modes & control](CONFIGURATION.md#daemon-modes--control).

### Run the hub

The hub refuses to start without an auth token.

```bash
# launcher (backgrounds, logs to ~/relayhub.log):
./starthub.sh --bg --port 10322 --token <TOKEN>
# or directly:
CC2CC_RELAY_TOKEN=<TOKEN> python3 relay_hub.py --host 127.0.0.1 --port 10322
# stop a backgrounded hub:
./starthub.sh stop
```

Or let the installer run it as a managed **systemd service**:
`sudo scripts/cc2cc-install.sh --scope global --hub` (writes `cc2cc-hub.service`, token in
`/etc/cc2cc/hub.env`; control the node with `sudo systemctl start|stop|restart cc2cc.target`). The
global install also wires this node's own daemon to relay through its hub, and records a **node
identity** in `/var/lib/cc2cc/connections.json` — `self.id` (unique per machine, seeded from
`/etc/machine-id`) and `self.name` (the node name, default = `hostname`, set with `--node-name NAME`,
stable across reinstalls). The node name is also the **default team** for agents that don't set
`CC2CC_TEAM`. See [INSTALL.md](INSTALL.md#machine-wide-install-multi-user).

Verify it's up:

```bash
curl -s http://127.0.0.1:10322/health      # → {"status":"ok",...}
```

### Exposing it (loopback vs. real network)

- **`--host 127.0.0.1` (default)** reaches only the **same host** — fine for multiple accounts on
  one box, not for true cross-machine.
- **Cross-machine, recommended:** keep the hub on loopback and put a **reverse proxy with TLS** in
  front of it. The proxy terminates HTTPS and rewrites `…/api/*` to the hub's local `/api/*`
  (clients use a `url` like `https://relay.example.com/bridge/cc2cc`). See the `url` form and its
  note in `connections.example.json`.
- **Cross-machine, minimal:** bind a routable address (`--host 0.0.0.0`) and rely on the token +
  E2E encryption. Only do this on a trusted network — there is no TLS on the bare hub.

### Distribute the shared secret

Every peer needs the **same `secret.key`** (it derives the AES key). Generate it once and copy it
to each participant's bridge over a secure channel — never commit it, never send it in the clear:

```bash
# on the server bridge: secret.key already exists (from install). To share it:
#   copy <bridge>/secret.key  →  each client's <bridge>/secret.key  (scp, secrets manager, etc.)
chmod 600 <bridge>/secret.key
```

Give each client operator: the **hub URL + port**, the **token**, and the **`secret.key`**.

---

## Part 2 — Connecting a client to a relay

On each machine that should join the mesh:

### 1. Install the shared secret

Place the byte-identical `secret.key` into the bridge (`~/.cc2cc/secret.key`, or
`/var/lib/cc2cc/secret.key` for a machine-wide install). When the installer asks about the key,
choose **import** and point it at the shared file.

### 2. Point the client at the hub

Easiest — the installer writes the config for you:

```bash
scripts/cc2cc-install.sh --relay        # prompts for hub URL + token, writes connections.json
```

Or write `connections.json` in the bridge by hand. Two equivalent connection forms (see
`connections.example.json`):

```jsonc
{
  "self": { "id": "machine-<id>", "name": "this-host", "type": "client" },
  "enabled": true,
  "connections": [
    // (a) full URL — typical behind a reverse proxy / TLS:
    { "id": "primary-hub", "type": "server", "url": "https://relay.example.com/bridge/cc2cc",
      "token": "<TOKEN>", "enabled": true }
    // (b) components — typical for a direct host:port:
    // { "id": "primary-hub", "type": "server", "scheme": "http",
    //   "address": "203.0.113.5", "port": 10322, "token": "<TOKEN>", "enabled": true }
  ]
}
```

(The legacy flat `relay.json` is still read and mapped to this shape, but `connections.json` is
canonical.) Agents can also configure a hub at runtime with the **`register_relay`** tool
(`{hub_url, token, team, enabled}`).

### 3. Launch with encryption

`CC2CC_ENCRYPT=1` is required for the relay. `cc2cc-launch` sets it automatically when a relay
config is present:

```bash
cc2cc-launch <identity>
# equivalent manual launch:
CC2CC_ENCRYPT=1 CC2CC_IDENTITY=<identity> claude --dangerously-load-development-channels server:cc2cc
```

### 4. Verify the link

- `whoami` → `relay.enabled: true` and the hub URL.
- `list_agents` → remote agents (other machines' members) appear with `is_remote: true`.

---

## Part 3 — End-to-end (two machines)

**Machine A** runs the hub and team `alpha`; **Machine B** joins with team `beta`.

```bash
# ── Machine A (hub + team alpha) ──
./starthub.sh --bg --port 10322 --token SHARED_TOKEN
curl -s http://<A-address>:10322/health
#   ensure secret.key exists in A's bridge; copy it securely to B (step below)

# ── Machine B (client + team beta) ──
cp /secure/path/secret.key ~/.cc2cc/secret.key && chmod 600 ~/.cc2cc/secret.key   # SAME key as A
cat > ~/.cc2cc/connections.json <<'JSON'
{ "self": { "id": "machine-b", "name": "host-b", "type": "client" }, "enabled": true,
  "connections": [ { "id": "primary-hub", "type": "server", "scheme": "http",
                     "address": "<A-address>", "port": 10322, "token": "SHARED_TOKEN", "enabled": true } ] }
JSON
CC2CC_ENCRYPT=1 cc2cc-launch <identity-on-beta>
```

Now test cross-team messaging across the machines (routes through the target team's leader):
- From an `alpha` agent on A: `send_team(team="beta", text="hello B")` → B's `beta` leader receives
  it (decrypted) and forwards to members.
- From a `beta` agent on B: `send_team(team="alpha", text="hello A")` → A receives it.

Team **policy/roster federates** over the hub, so each side can see the other team's leader and
membership without both being online simultaneously.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `refusing to start relay: encryption is mandatory` | Set `CC2CC_ENCRYPT=1` and ensure `secret.key` exists in the bridge. |
| Cross-team send says **not reachable** | Hub down / wrong port or token, or the target team isn't registered yet (bring one of its agents online). |
| Messages arrive as **garbage** / are dropped | `secret.key` differs between peers — it must be byte-identical everywhere. |
| `list_agents` shows no remote agents | Client `connections.json` not enabled / wrong URL or token; check `whoami` relay status and the hub `/health`. |
| Hub `/health` works locally but not from another host | Hub bound to `127.0.0.1`; expose via reverse proxy (recommended) or bind a routable address on a trusted network. |

See also [INSTALL.md](INSTALL.md) for install scopes and [SPECIFICATION.md §10–§11](SPECIFICATION.md#10-relay-protocol) for the protocol and encryption details.

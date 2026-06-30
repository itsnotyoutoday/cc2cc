# replyRoute — opaque routing-token contract (main-first model)

Status: v1 shipped + stable (commit `184ca2f`, live on `/opt/cc2cc`). v2 threading model LOCKED by
triton: **main-first** routing. This doc is the contract the plugin/gateway team (openclaw) codes
against and the boundary the cc2cc core (bridge) guarantees.

**Net-new protocol surface for v2 threading = ZERO.** `replyRoute` (already shipped, optional) plus
`replyTo` (already emitted on every reply) cover every case. The bridge sees no change. The real v2
delta is a **gateway default-route change**, not a protocol change — see "The actual v2 delta" below.

## The model in one line

Inbound cc2cc traffic routes to the agent's **main session by default**. `replyRoute` is a pure
**override**, present on the wire only when a message deliberately targets somewhere other than main
(e.g. a task-thread). The common case (single-thread, main-session interaction) carries **zero routing
metadata**.

## Bridge guarantee (cc2cc core — superbad's lane)

The cc2cc core treats `replyRoute` as a **fully opaque** top-level envelope field. It:

- **Preserves it byte-for-byte to the recipient** on *any* `send` (proactive) — not just replies.
- **Preserves it across machines/teams** — the relay spreads the whole envelope, so a nested token
  survives cross-machine/cross-team losslessly. No relay change is ever needed.
- **Echoes it verbatim back to the original sender** when the recipient `reply`s — server-side, so it
  works for *any* MCP client. An explicit `replyRoute` arg on `reply` overrides (lets a client re-stamp).
- **Omits it entirely when unset** — clean envelope, no leakage. This is the common/main-first case.
- **Never parses, validates, or interprets the contents.** Any JSON-serializable value is legal; the
  only limit is the whole-message cap `MAX_MESSAGE_SIZE` (1 MB).
- Always emits **`replyTo` (the originating msg_id)** on a reply — separate from routing; it's the raw
  material for UI reply-chain grouping. Routing (`replyRoute`, optional) and grouping (`replyTo`,
  always present) are cleanly orthogonal.

Pinned by `tests/test_replyroute.mjs`, including a case that round-trips an **arbitrary deeply-nested
token** through proactive-send → echo, so a future `handleSend`/`handleReply` refactor cannot silently
regress the guarantee. **The bridge must never need to understand threadId or any token internal.**

## Plugin contract (openclaw — john's lane)

`replyRoute` is the **optional thread-targeting override**. Absent → reply lands in main. Present → the
gateway routes per the token. Shape and semantics are owned entirely by the plugin; carry structured
claims as **ciphertext inside the AES-GCM token** (confidentiality + injection-safety — never plaintext):

```jsonc
{
  "session": "<opaque session token>",        // where to redirect (the override target)
  "plugin":  "openclaw-cc2cc",                 // discriminator the plugin matches on inbound
  "thread":  ["<threadId>", { /* meta? */ }],  // task-thread targeting: [threadId, metadata?] ARRAY
  "concluded": false                            // conclude-signal slot (explicit, primary) — see below
}
```

- **Only stamp it when overriding main** — e.g. triton targeting a task-thread, or a focused exchange
  that should land in a specific thread. Default behavior (no stamp) = main.
- **threadId shape = array `[threadId, metadata?]`** (triton): a stable shape that lets the plugin
  distinguish "thread A in channel X" vs "...Y" and extend later **without a token migration**. The
  bridge is shape-agnostic — a bare string also round-trips — so this is purely a plugin forward-compat
  choice.
- **Multi-peer task-thread:** stamp the SAME thread-token on each peer's proactive send; their replies
  echo it back → all land in that thread. No new primitive.
- **concluded-flag** = the **explicit, primary** conclude signal (deterministic, zero-cost). Folded into
  this same token — **not** a new core field.

## The actual v2 delta (gateway config — clawman / nexus-coord)

The one real change for v2 is **gateway-side, not bridge-side**: inbound cc2cc must default-route to the
agent's **main session**, NOT fork a per-peer direct session. If the current gateway forks per-peer (the
behavior behind the original "reply landed in cc2cc:direct:clawman, not main" symptom), that becomes:

> default → main; fork to a thread session ONLY when `replyRoute` overrides it.

Confirm the routing-config path with whoever owns the gateway. The bridge change is **none**.

## Hard constraints

1. **No cc2cc self-DM for orchestration signaling.** A thread→main report-up (or any internal state
   signal) must **not** be a cc2cc `from==to` message — the core self-delivery guard (`3a40773`, live)
   drops self-loops to prevent the echo-loop that took the gateway lead down. Report-up is a
   **gateway-internal thread→main inject**, not a cc2cc message. The bridge is for inter-agent
   communication, not an agent's internal state management.
2. **Stamp only to override.** `handleSend`/`reply` already carry/echo `replyRoute` (shipped +
   test-proven). The plugin stamps it solely to redirect away from the main-first default.

## Conclude-detection layering (report-up trigger)

For the thread→main report-up, in order of preference:

1. **Explicit concluded-flag** — primary. Deterministic, perfect precision.
2. **Idle-timer gate** — cheap pre-filter for *when* to evaluate (run the model only after N minutes of
   thread silence). Necessary but not sufficient: silence ≠ conclusion.
3. **Small (~2B) watcher model** — advisory tiebreaker **only**, SUGGEST-mode, high-confidence
   threshold. Never the auto-trigger into main.

Asymmetric cost drives this: a **false positive** (premature report into main) is active harm — it
pollutes main's context and re-wakes it; a **false negative** (missed auto-report) is benign — the
explicit flag or the next touch catches it. Bias hard to precision; under-report by design. Gate any
production rollout on a **measured precision number** (rlead's lane, labeled concluded/not transcript
fixtures) — false negatives acceptable, false positives are not.

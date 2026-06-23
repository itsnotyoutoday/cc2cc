# replyRoute — opaque routing-token contract

Status: v1 shipped + stable (commit `184ca2f`, live on `/opt/cc2cc`). This doc is the contract the
plugin/gateway team (openclaw) codes against, and the boundary the cc2cc core (bridge) guarantees.
Threading and conclude-signal ride this same token — **no new envelope fields**.

## Bridge guarantee (cc2cc core — superbad's lane)

The cc2cc core treats `replyRoute` as a **fully opaque** top-level envelope field. It:

- **Preserves it byte-for-byte to the recipient** on *any* `send` (proactive) — not just replies.
- **Preserves it across machines/teams** — the relay spreads the whole envelope, so a nested token
  survives cross-machine/cross-team losslessly. No relay change is ever needed.
- **Echoes it verbatim back to the original sender** when the recipient `reply`s — server-side, so it
  works for *any* MCP client. An explicit `replyRoute` arg on `reply` overrides (lets a client re-stamp).
- **Omits it entirely when unset** — clean envelope, no leakage.
- **Never parses, validates, or interprets the contents.** Any JSON-serializable value is legal; the
  only limit is the whole-message cap `MAX_MESSAGE_SIZE` (1 MB).

Pinned by `tests/test_replyroute.mjs`, including a case that round-trips an **arbitrary deeply-nested
token** (objects, arrays, number, null, unicode) through proactive-send → echo. That test exists
specifically so a future `handleSend`/`handleReply` refactor cannot silently regress the guarantee.

**The bridge must never need to understand threadId, concluded, or any token internal.** Routing
intelligence lives at the plugin/gateway boundary; the bridge is dumb transport.

## Plugin contract (openclaw — john's lane)

Shape and semantics of the token are owned entirely by the plugin. Recommended structure, carried as
**ciphertext inside the AES-GCM token** (confidentiality + injection-safety — never plaintext claims):

```jsonc
{
  "session": "<opaque session token>",     // v1: where the reply should land (originating session)
  "plugin":  "openclaw-cc2cc",             // discriminator the plugin matches on inbound
  "thread":  ["<threadId>", { /* meta? */ }], // threading: [threadId, metadata?] ARRAY (triton)
  "concluded": false                        // conclude-signal slot (explicit, primary) — see below
}
```

- **threadId shape = array `[threadId, metadata?]`** (triton's call): a stable shape that lets the
  plugin distinguish "thread A in channel X" vs "...Y" and extend later **without a token migration**.
  The bridge is shape-agnostic — a bare string also round-trips fine — so this is purely a plugin
  forward-compat choice.
- **concluded-flag** = the **explicit, primary** conclude signal (deterministic, zero-cost, perfect
  precision). Folded into this same token — **not** a new core field. If the GCM token already carries
  structured claims, add the slot; if not, trivially expand it. Do not proliferate first-class envelope
  fields per feature.

## Hard constraints

1. **No cc2cc self-DM for orchestration signaling.** A thread→main report-up (or any internal state
   signal) must **not** be a cc2cc `from==to` message — the core self-delivery guard (`3a40773`, live)
   drops self-loops to prevent the echo-loop that took the gateway lead down. Report-up is a
   **gateway-internal thread→main inject**, not a cc2cc message. The bridge is for inter-agent
   communication, not an agent's internal state management.
2. **Stamp on proactive sends, not only replies.** `handleSend` already carries `replyRoute` to the
   recipient (shipped + test-proven). The threading fix is the *plugin* stamping the token (with
   threadId) on proactive sends from main — the un-stamped-proactive-send gap is what made replies fork
   into isolated per-peer sessions.

## Conclude-detection layering (report-up trigger)

For the thread→main report-up, in order of preference:

1. **Explicit concluded-flag** — primary. Deterministic, perfect precision.
2. **Idle-timer gate** — cheap pre-filter for *when* to evaluate (only run the model after N minutes of
   thread silence). Necessary but not sufficient: silence ≠ conclusion.
3. **Small (~2B) watcher model** — advisory tiebreaker **only**, SUGGEST-mode, high-confidence
   threshold. Never the auto-trigger into main.

Asymmetric cost drives this: a **false positive** (premature report into main) is active harm — it
pollutes main's context and re-wakes it; a **false negative** (missed auto-report) is benign — the
explicit flag or the next touch catches it. Bias hard to precision; under-report by design. Gate any
production rollout on a **measured precision number** (rlead's lane, labeled concluded/not transcript
fixtures) — false negatives acceptable, false positives are not.

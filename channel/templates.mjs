/**
 * Centralized user-facing message templates.
 *
 * Templates use {{var}} tags for auto-replacement via render(name, vars).
 * Defaults live here; they can be refined WITHOUT touching code by dropping a
 * `templates.json` in the bridge dir (CC2CC_BRIDGE_DIR) — its keys override these
 * (loaded at startup via loadTemplateOverrides). Unknown {{tags}} render empty.
 */

import { readFile } from "fs/promises";
import { join } from "path";

// Keep these terse. They are user-facing; do not leak internal protocol details
// (tombstones, identity, lease ids). Refine via a bridge templates.json override.
export const DEFAULT_TEMPLATES = {
  // ── Relay / cross-machine send status ──
  relay_queued_online: 'Sent to "{{team}}" ({{online}} online).',
  relay_queued_dark: 'Queued for "{{team}}" — no one online now; delivers on reconnect.',
  relay_unreachable: 'Relay unreachable — "{{team}}" not sent; retry shortly.',
  relay_spooled: 'Spooled for "{{team}}" — will retry until delivered.',

  // ── Cross-team routing ──
  cross_team_blocked: '"{{to}}" is on another team — use send_team.',
  leader_offline: 'Leader of "{{team}}" is offline — delivers on their return.',
  team_unreachable: '"{{team}}" is not reachable.',

  // ── Membership (chat-room semantics: leaving/joining a room) ──
  admitted: 'Admitted "{{agent}}" to "{{team}}".',
  evicted: 'Removed "{{agent}}" from "{{team}}".',
  team_created: 'Created team "{{team}}" — you are its leader.',
  team_exists: 'Team "{{team}}" already exists.',
  not_registered: 'You are not in the cc2cc system yet — register first.',

  // ── Message age / staleness (shown to the RECIPIENT on read) ──
  msg_old_on_read: '⏳ {{age}} old (sent {{sentAt}}) — may be stale; check with {{from}} if unsure.',

  // ── Staleness notice / bounce (back to the SENDER) ──
  sender_stale_notice: 'Your message to "{{toTeam}}" is still undelivered after {{age}} — consider following up.',
  sender_bounce: 'Your message to "{{toTeam}}" expired undelivered after {{age}}.',
};

let templates = { ...DEFAULT_TEMPLATES };

/** Merge a bridge-local templates.json over the defaults (best-effort). */
export async function loadTemplateOverrides(bridgeDir) {
  try {
    const raw = await readFile(join(bridgeDir, "templates.json"), "utf8");
    const overrides = JSON.parse(raw);
    if (overrides && typeof overrides === "object") {
      templates = { ...DEFAULT_TEMPLATES, ...overrides };
    }
  } catch { /* no overrides — use defaults */ }
}

/** Render a named template, substituting {{var}} with vars[var] (missing → ""). */
export function render(name, vars = {}) {
  const t = templates[name];
  if (t == null) return "";
  return t.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
}

/** Expose the active template set (for tests / introspection). */
export function getTemplates() {
  return { ...templates };
}

# Notification Rules Design

## Summary

Add a `rules.json` config file that controls how channel notifications are formatted and what instructions are injected. The server reads rules at startup and enriches each notification with a human-readable format and an action instruction.

## File: `~/.cc2cc/rules.json`

```json
{
  "version": 1,
  "default": {
    "instruction": "Reply to this message as soon as possible using the reply tool.",
    "priority": "normal"
  }
}
```

- `version` — schema version for future compatibility.
- `default` — fallback rule applied to all messages.
- Future: `"rules": [{ "from": "devops", "instruction": "...", "priority": "urgent" }]` — per-sender overrides, first match wins, fallback to default.

## Notification Format

### Before

```
[abc123] from pure-swan (request): Проверь тесты
```

### After

```
📨 CC2CC Message
From: pure-swan
Type: request
Content: Проверь тесты

>> Reply to this message as soon as possible using the reply tool. Use msg_id: abc123
```

- Top section: human-readable message info, always present.
- Bottom section (`>>`): instruction from rules.json, includes msg_id for the agent to use with the reply tool.
- If no rules.json exists: top section only, no instruction line (backward compatible).

## Changes in server.mjs

### 1. Load rules at startup

After `initBridge()`, read `BRIDGE_DIR/rules.json`:

```js
let notificationRules = null;

async function loadRules() {
  const rulesPath = join(BRIDGE_DIR, "rules.json");
  try {
    const raw = await readFile(rulesPath, "utf8");
    notificationRules = JSON.parse(raw);
    log("info", "loaded notification rules", { version: notificationRules.version });
  } catch {
    log("info", "no rules.json found, notifications will have no instructions");
  }
}
```

Called once during `main()` init sequence.

### 2. Format notification in pollInbox()

Replace the current content formatting (lines ~685-688) with:

```js
function formatNotification(msg) {
  const type = msg.type || "message";
  const text = msg.content?.text || "(empty)";
  const taskTitle = msg.task?.title ? `\nTask: ${msg.task.title}` : "";
  const replyInfo = msg.replyTo ? ` (reply to ${msg.replyTo})` : "";

  let content = `📨 CC2CC Message\nFrom: ${msg.from}\nType: ${type}${replyInfo}${taskTitle}\nContent: ${text}`;

  // Append instruction from rules if available
  const rule = notificationRules?.default;
  if (rule?.instruction) {
    content += `\n\n>> ${rule.instruction} Use msg_id: ${msg.id}`;
  }

  return content;
}
```

### 3. Apply to all notification sites

The same `formatNotification()` is used in:
- `pollInbox()` — main delivery path
- Status change notifications (agent online/offline) — keep current format, rules don't apply

## What we are NOT doing

- Per-agent rules (future: slash-command or skill)
- Hot-reload of rules.json (restart to pick up changes)
- Schema validation (file is trivial for now)
- Changes to `check_inbox` tool output format (only channel notifications change)
- Changes to meta fields in notification params (msg_id, priority, type, from stay the same)

## Backward Compatibility

- If `rules.json` does not exist, notifications use the new human-readable format but without the instruction line.
- No changes to MCP tool interfaces or message file format.

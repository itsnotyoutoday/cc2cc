#!/usr/bin/env bash
# CC2CC Smoke Test — verifies core message flow without Node.js or Claude Code
# shellcheck disable=SC2015  # We intentionally use A && B || C as assertions
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
BRIDGE=$(mktemp -d "${TMPDIR:-/tmp}/cc2cc-test-XXXXXX")

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }

cleanup() {
  rm -rf "$BRIDGE"
}
trap cleanup EXIT

export CC2CC_BRIDGE_DIR="$BRIDGE"

echo "CC2CC Smoke Test"
echo "Bridge: $BRIDGE"
echo ""

# --- Setup (manual — skip npm install) ---
echo "▸ Setup"

mkdir -p "$BRIDGE/alpha-to-beta/"{inbox,done}
mkdir -p "$BRIDGE/beta-to-alpha/"{inbox,done}
mkdir -p "$BRIDGE/status"
mkdir -p "$BRIDGE/agent-cards"

pass "Directory structure created"

# --- Test: send.py ---
echo ""
echo "▸ send.py"

"$REPO_DIR/scripts/send.py" alpha beta message "Hello from alpha" >/dev/null
MSG_FILE=$(find "$BRIDGE/alpha-to-beta/inbox" -name "msg-*.json" | head -1)

if [ -n "$MSG_FILE" ]; then
  pass "Message file created"
else
  fail "Message file not created"
fi

# Validate message content
FROM=$(python3 -c "import json; print(json.load(open('$MSG_FILE'))['from'])" 2>/dev/null || echo "")
TO=$(python3 -c "import json; print(json.load(open('$MSG_FILE'))['to'])" 2>/dev/null || echo "")
TYPE=$(python3 -c "import json; print(json.load(open('$MSG_FILE'))['type'])" 2>/dev/null || echo "")
TEXT=$(python3 -c "import json; print(json.load(open('$MSG_FILE'))['content']['text'])" 2>/dev/null || echo "")

[ "$FROM" = "alpha" ] && pass "from=alpha" || fail "from=$FROM (expected alpha)"
[ "$TO" = "beta" ] && pass "to=beta" || fail "to=$TO (expected beta)"
[ "$TYPE" = "message" ] && pass "type=message" || fail "type=$TYPE (expected message)"
[ "$TEXT" = "Hello from alpha" ] && pass "content matches" || fail "content='$TEXT'"

# Extract message ID for reply test
MSG_ID=$(python3 -c "import json; print(json.load(open('$MSG_FILE'))['id'])" 2>/dev/null)

# --- Test: receive.sh (peek mode) ---
echo ""
echo "▸ receive.sh --peek"

RCV_OUTPUT=$("$REPO_DIR/scripts/receive.sh" beta --peek 2>/dev/null || true)
echo "$RCV_OUTPUT" | grep -q "alpha" && pass "Shows sender" || fail "Missing sender in output"
echo "$RCV_OUTPUT" | grep -q "Hello" && pass "Shows content" || fail "Missing content in output"

# Verify peek didn't move the file
[ -f "$MSG_FILE" ] && pass "Peek preserved inbox file" || fail "Peek moved the file"

# --- Test: receive.sh (consume mode) ---
echo ""
echo "▸ receive.sh (consume)"

"$REPO_DIR/scripts/receive.sh" beta >/dev/null 2>&1 || true

INBOX_COUNT=$(find "$BRIDGE/alpha-to-beta/inbox" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
DONE_COUNT=$(find "$BRIDGE/alpha-to-beta/done" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')

[ "$INBOX_COUNT" = "0" ] && pass "Inbox emptied" || fail "Inbox still has $INBOX_COUNT files"
[ "$DONE_COUNT" = "1" ] && pass "Moved to done/" || fail "Done has $DONE_COUNT files (expected 1)"

# --- Test: reply.py ---
echo ""
echo "▸ reply.py"

"$REPO_DIR/scripts/reply.py" "$MSG_ID" "Got it, thanks!" beta >/dev/null 2>&1

REPLY_FILE=$(find "$BRIDGE/beta-to-alpha/inbox" -name "msg-*.json" | head -1)
[ -n "$REPLY_FILE" ] && pass "Reply file created" || fail "Reply file not created"

if [ -n "$REPLY_FILE" ]; then
  REPLY_TO=$(python3 -c "import json; print(json.load(open('$REPLY_FILE'))['replyTo'])" 2>/dev/null || echo "")
  REPLY_TYPE=$(python3 -c "import json; print(json.load(open('$REPLY_FILE'))['type'])" 2>/dev/null || echo "")
  [ "$REPLY_TO" = "$MSG_ID" ] && pass "replyTo threaded correctly" || fail "replyTo=$REPLY_TO (expected $MSG_ID)"
  [ "$REPLY_TYPE" = "response" ] && pass "type=response" || fail "type=$REPLY_TYPE (expected response)"
fi

# --- Test: task.py ---
echo ""
echo "▸ task.py"

# Clean inbox first
rm -f "$BRIDGE/alpha-to-beta/inbox/"*.json

"$REPO_DIR/scripts/task.py" alpha beta "Run tests" "Execute integration tests" >/dev/null 2>&1

TASK_FILE=$(find "$BRIDGE/alpha-to-beta/inbox" -name "msg-*.json" | head -1)
[ -n "$TASK_FILE" ] && pass "Task file created" || fail "Task file not created"

if [ -n "$TASK_FILE" ]; then
  TASK_TYPE=$(python3 -c "import json; print(json.load(open('$TASK_FILE'))['type'])" 2>/dev/null || echo "")
  TASK_STATUS=$(python3 -c "import json; print(json.load(open('$TASK_FILE'))['task']['status'])" 2>/dev/null || echo "")
  TASK_TITLE=$(python3 -c "import json; print(json.load(open('$TASK_FILE'))['task']['title'])" 2>/dev/null || echo "")
  [ "$TASK_TYPE" = "task" ] && pass "type=task" || fail "type=$TASK_TYPE"
  [ "$TASK_STATUS" = "submitted" ] && pass "status=submitted" || fail "status=$TASK_STATUS"
  [ "$TASK_TITLE" = "Run tests" ] && pass "title matches" || fail "title='$TASK_TITLE'"
fi

# --- Test: task reply completes the task ---
echo ""
echo "▸ reply.py (task completion)"

TASK_MSG_ID=$(python3 -c "import json; print(json.load(open('$TASK_FILE'))['id'])" 2>/dev/null)

# Move task to done so reply.py can find it
mkdir -p "$BRIDGE/alpha-to-beta/done"
mv "$TASK_FILE" "$BRIDGE/alpha-to-beta/done/"

"$REPO_DIR/scripts/reply.py" "$TASK_MSG_ID" "All 42 tests passed" beta >/dev/null 2>&1

TASK_REPLY=$(find "$BRIDGE/beta-to-alpha/inbox" -name "msg-*.json" -newer "$REPLY_FILE" | head -1)
if [ -n "$TASK_REPLY" ]; then
  TR_STATUS=$(python3 -c "import json; print(json.load(open('$TASK_REPLY'))['task']['status'])" 2>/dev/null || echo "")
  TR_RESULT=$(python3 -c "import json; print(json.load(open('$TASK_REPLY'))['task']['result'])" 2>/dev/null || echo "")
  [ "$TR_STATUS" = "completed" ] && pass "task.status=completed" || fail "task.status=$TR_STATUS"
  [ "$TR_RESULT" = "All 42 tests passed" ] && pass "task.result matches" || fail "task.result='$TR_RESULT'"
else
  fail "Task reply not found"
fi

# --- Test: validate.py ---
echo ""
echo "▸ validate.py"

VAL_OUTPUT=$("$REPO_DIR/scripts/validate.py" 2>&1 || true)
echo "$VAL_OUTPUT" | grep -q "Invalid: 0" && pass "All messages valid" || fail "Validation errors: $VAL_OUTPUT"

# --- Test: session-start.sh ---
echo ""
echo "▸ session-start.sh"

CC2CC_SELF=alpha CC2CC_BRIDGE_DIR="$BRIDGE" "$REPO_DIR/hooks/session-start.sh" </dev/null >/dev/null 2>&1

[ -f "$BRIDGE/status/alpha-heartbeat.json" ] && pass "Heartbeat written" || fail "No heartbeat file"

if [ -f "$BRIDGE/status/alpha-heartbeat.json" ]; then
  HB_STATUS=$(python3 -c "import json; print(json.load(open('$BRIDGE/status/alpha-heartbeat.json'))['status'])" 2>/dev/null || echo "")
  [ "$HB_STATUS" = "active" ] && pass "status=active" || fail "status=$HB_STATUS"
fi

# --- Test: session-end.sh ---
echo ""
echo "▸ session-end.sh"

CC2CC_SELF=alpha CC2CC_BRIDGE_DIR="$BRIDGE" "$REPO_DIR/hooks/session-end.sh" </dev/null >/dev/null 2>&1

HB_STATUS=$(python3 -c "import json; print(json.load(open('$BRIDGE/status/alpha-heartbeat.json'))['status'])" 2>/dev/null || echo "")
[ "$HB_STATUS" = "offline" ] && pass "status=offline after session end" || fail "status=$HB_STATUS"

# --- Test: status.sh ---
echo ""
echo "▸ status.sh"

STATUS_OUTPUT=$(CC2CC_BRIDGE_DIR="$BRIDGE" "$REPO_DIR/scripts/status.sh" 2>&1 || true)
echo "$STATUS_OUTPUT" | grep -q "alpha" && pass "Shows agent status" || fail "Missing agent in status"
echo "$STATUS_OUTPUT" | grep -q "pending" && pass "Shows mailbox counts" || fail "Missing mailbox info"

# --- Test: cleanup.py ---
echo ""
echo "▸ cleanup.py"

# Create an expired message in done/
python3 -c "
import json, os
msg = {
    'id': 'msg-expired-test',
    'timestamp': '2020-01-01T00:00:00Z',
    'from': 'alpha', 'to': 'beta', 'type': 'message',
    'content': {'text': 'old message', 'parts': []},
    'ttl': 3600
}
with open('$BRIDGE/alpha-to-beta/done/msg-expired-test.json', 'w') as f:
    json.dump(msg, f)
"

BEFORE=$(find "$BRIDGE/alpha-to-beta/done" -name "*.json" | wc -l | tr -d ' ')
"$REPO_DIR/scripts/cleanup.py" --max-age-hours 1 >/dev/null 2>&1
AFTER=$(find "$BRIDGE/alpha-to-beta/done" -name "*.json" | wc -l | tr -d ' ')

[ "$AFTER" -lt "$BEFORE" ] && pass "Expired messages cleaned up" || fail "Cleanup didn't remove old messages ($BEFORE → $AFTER)"

# --- Summary ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"

if [ "$FAIL" -gt 0 ]; then
  echo "FAILED"
  exit 1
else
  echo "ALL PASSED"
  exit 0
fi

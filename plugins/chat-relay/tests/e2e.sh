#!/usr/bin/env bash
# End-to-end test: spin up the server, simulate two sessions via CHAT_SESSION,
# and verify send/wait/say/tail work correctly.

set -euo pipefail

THIS_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$THIS_DIR/.." && pwd)"
CCHAT="$SRC/bin/cchat"

# Isolated state for this test
export CHAT_PORT="${CHAT_PORT:-17777}"
TMPROOT="$(mktemp -d /tmp/chatrelay-e2e.XXXXXX)"
export CHAT_HOME="$TMPROOT/chat"
export CHAT_CACHE="$TMPROOT/cache"
export CHAT_SERVER="$SRC/server/server.js"
mkdir -p "$CHAT_HOME" "$CHAT_CACHE/identity" "$CHAT_CACHE/cursor"

ROOM="e2e-$$"

pass() { printf '  ok  %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*"; exit 1; }

cleanup() {
  CHAT_SESSION=test-cleanup "$CCHAT" server stop > /dev/null 2>&1 || true
  rm -rf "$TMPROOT"
}
trap cleanup EXIT

run_as() {
  local key="$1"; shift
  CHAT_SESSION="$key" "$CCHAT" "$@"
}

run_as_codex() {
  local thread_id="$1"; shift
  env -u CHAT_SESSION -u CLAUDE_CODE_SESSION_ID -u CODEX_SESSION_ID \
    CODEX_THREAD_ID="$thread_id" "$CCHAT" "$@"
}

echo "== chat-relay e2e (port=$CHAT_PORT, tmp=$TMPROOT) =="

# 1. server starts on demand
run_as alice name alice > /dev/null
run_as bob   name bob   > /dev/null
[ "$(CHAT_SESSION=alice "$CCHAT" whoami)" = "alice" ] || fail "alice identity"
[ "$(CHAT_SESSION=bob   "$CCHAT" whoami)" = "bob"   ] || fail "bob identity"
pass "identities set per session"

# 1b. Codex threads get stable, distinct identities without CHAT_SESSION.
run_as_codex codex-thread-a name codex-a > /dev/null
run_as_codex codex-thread-b name codex-b > /dev/null
[ "$(run_as_codex codex-thread-a whoami)" = "codex-a" ] || fail "Codex thread A identity"
[ "$(run_as_codex codex-thread-b whoami)" = "codex-b" ] || fail "Codex thread B identity"
pass "identities persist per Codex thread"

# 2. send triggers auto-start; status then reports up
run_as alice send "$ROOM" "hello from alice"
[ "$(run_as alice server status)" = "up" ] || fail "server should be up after first send"
pass "send auto-starts server"

# 3. bob tails to see the message
TAIL_OUT="$(run_as bob tail "$ROOM")"
echo "$TAIL_OUT" | grep -q '^alice: hello from alice$' || fail "tail did not see alice's message: $TAIL_OUT"
pass "send + tail"

# 4. wait returns immediately because there's an unread message > bob's cursor
WAIT_OUT="$(run_as bob wait "$ROOM" --timeout=5)"
echo "$WAIT_OUT" | grep -q '^alice: hello from alice$' || fail "wait did not return alice's message: $WAIT_OUT"
pass "wait drains existing messages"

# 5. cursor advanced — second wait should timeout (exit 124)
set +e
run_as bob wait "$ROOM" --timeout=2 > /dev/null 2>&1
RC=$?
set -e
[ "$RC" = "124" ] || fail "expected timeout exit 124, got $RC"
pass "wait blocks until timeout when nothing new"

# 6. wait excludes self — alice posts, alice's own wait should NOT return
run_as alice send "$ROOM" "self-echo"
set +e
run_as alice wait "$ROOM" --timeout=2 > /dev/null 2>&1
RC=$?
set -e
[ "$RC" = "124" ] || fail "wait should not pick up own message, got $RC"
pass "wait excludes self"

# 7. drain bob's cursor past alice's "self-echo" from step 6 so say only sees new replies
run_as bob wait "$ROOM" --timeout=2 > /dev/null

# 8. say: bob says, in parallel alice waits and replies
( sleep 0.3; run_as alice send "$ROOM" "got it" ) &
BG=$!
SAY_OUT="$(run_as bob say "$ROOM" "are you there?" --timeout=10)"
wait "$BG"
echo "$SAY_OUT" | grep -q '^alice: got it$' || fail "say did not receive reply: $SAY_OUT"
pass "say (send + blocking wait) round-trip"

# 8. long polling actually blocks (not busy-loop): measure time
START=$(date +%s)
( sleep 1; run_as alice send "$ROOM" "delayed" ) &
BG=$!
run_as bob wait "$ROOM" --timeout=10 > /dev/null
wait "$BG"
END=$(date +%s)
ELAPSED=$((END - START))
[ "$ELAPSED" -ge 1 ] && [ "$ELAPSED" -lt 5 ] || fail "elapsed=$ELAPSED out of expected 1..5"
pass "long-poll wakes promptly on new message (elapsed=${ELAPSED}s)"

# 9. rooms lists the room
ROOMS_OUT="$(run_as alice rooms)"
echo "$ROOMS_OUT" | grep -qx "$ROOM" || fail "rooms missing $ROOM: $ROOMS_OUT"
pass "rooms lists active room"

# 10. multibyte / spaces / quotes survive round-trip
#     (using single quotes everywhere — \\ stays as two literal backslashes)
run_as alice send "$ROOM" 'こんにちは "world" \\n'
LAST="$(run_as bob tail "$ROOM" -n 1)"
[ "$LAST" = 'alice: こんにちは "world" \\n' ] || fail "multibyte roundtrip: $LAST"
pass "non-ASCII and special chars survive"

# 11. tail -f streams new messages (initial snapshot + follow)
FOLLOW_LOG="$(mktemp -t cchat-follow.XXXXXX)"
run_as observer name observer > /dev/null
CHAT_SESSION=observer "$CCHAT" tail "$ROOM" -n 1 -f > "$FOLLOW_LOG" 2>&1 &
FBG=$!
sleep 0.5
run_as alice send "$ROOM" "live-1"
run_as alice send "$ROOM" "live-2"
sleep 0.8
kill "$FBG" 2>/dev/null || true
wait "$FBG" 2>/dev/null || true
grep -q '^alice: live-1$' "$FOLLOW_LOG" || fail "follow missed live-1: $(cat "$FOLLOW_LOG")"
grep -q '^alice: live-2$' "$FOLLOW_LOG" || fail "follow missed live-2: $(cat "$FOLLOW_LOG")"
rm -f "$FOLLOW_LOG"
pass "tail -f streams new messages"

echo
echo "ALL TESTS PASSED"

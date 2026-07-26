#!/bin/bash
# ssh-op.sh - SSH operation helper for ssh-operator agent
# Usage: ssh-op.sh <host> [line-limit] <command...>
# Examples:
#   ssh-op.sh myhost cat -n /etc/nginx/nginx.conf
#   ssh-op.sh myhost 500 find /var -name "*.log"

HOST="$1"; shift

if [ -z "$HOST" ]; then
  echo "Usage: ssh-op.sh <host> [line-limit] <command...>" >&2
  exit 1
fi

LIMIT=200
if [[ "$1" =~ ^[0-9]+$ ]]; then
  LIMIT="$1"; shift
fi

if [ $# -eq 0 ]; then
  echo "Error: no command specified" >&2
  exit 1
fi

# Fix: replace accidentally expanded local home dir with ~ for the remote shell.
# Bash expands ~ before this script runs, so e.g. "ls ~/foo" arrives as "ls /Users/k/foo".
# We detect this and convert back to ~ so the remote shell expands it correctly.
LOCAL_HOME="$HOME"
FIXED_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "$LOCAL_HOME" ]]; then
    FIXED_ARGS+=("~")
  elif [[ "$arg" == "$LOCAL_HOME/"* ]]; then
    FIXED_ARGS+=("~/${arg#$LOCAL_HOME/}")
  else
    FIXED_ARGS+=("$arg")
  fi
done

# Note: SIGPIPE from head may cause SSH to report exit 141 on large outputs.
# We filter this out since the output was successfully captured by head.
ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" "${FIXED_ARGS[@]}" 2>&1 | head -"$LIMIT"
EXIT_CODE=${PIPESTATUS[0]}

if [ "$EXIT_CODE" -ne 0 ] && [ "$EXIT_CODE" -ne 141 ]; then
  echo "[exit: $EXIT_CODE]"
fi

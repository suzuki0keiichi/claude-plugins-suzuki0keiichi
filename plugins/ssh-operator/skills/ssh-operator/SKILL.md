---
name: ssh-operator
description: >
  This skill should be used when the user asks to "operate a remote machine",
  "SSH into a server", "check remote files", "edit files on remote",
  "run commands on remote", "check server status", "look at server logs",
  "restart a service on the server", "deploy to the server",
  "investigate a server issue",
  "サーバーを調べて", "リモートで操作して", "リモートのファイルを見て",
  "サーバーのログを確認して", "リモートのサービスを再起動して",
  or needs to perform any operation on a remote machine via SSH.
argument-hint: <host> [task description]
---

# SSH Operator

Operate a remote machine via SSH through the project-local helper script.

## Step 0: Ensure the helper script (once per session)

Run from the project root:

```bash
mkdir -p .claude/ssh-operator
if ! cmp -s "${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh" .claude/ssh-operator/ssh-op.sh; then
  cp "${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh" .claude/ssh-operator/ssh-op.sh
fi
chmod +x .claude/ssh-operator/ssh-op.sh
```

This copies the script into the project on first use and refreshes it after plugin updates. The project-local path keeps "Always allow" permission patterns stable across plugin updates.

## Input

- **Host**: first argument — an SSH host name from `~/.ssh/config`
- **Task**: remaining arguments — what to do on the remote machine

If no host: check CLAUDE.md / project memory for server info, otherwise ask.
If no task: ask.

## CRITICAL: Local vs Remote

The Bash tool — like Read, Edit, and every other tool — runs **locally**. The **only** way to reach the remote host is the helper script. Never run raw `ssh`, and never run bare commands like `cat /etc/nginx/nginx.conf` expecting remote output — they read the local filesystem.

## Usage

```
.claude/ssh-operator/ssh-op.sh HOST [line-limit] 'command...'
```

**Pass the remote command as ONE quoted string.** ssh joins bare arguments with spaces and your local shell strips quotes first, so pipes, `&&`, redirects, and multi-word arguments otherwise run locally or arrive mangled:

```bash
# WRONG: tail runs locally on already-truncated output
.claude/ssh-operator/ssh-op.sh HOST journalctl -u app | tail -50
# RIGHT: the pipe runs on the remote
.claude/ssh-operator/ssh-op.sh HOST 'journalctl -u app | tail -50'
```

**The script always exits 0.** Remote failures appear as a trailing `[exit: N]` line in the output — check for that line; never chain `&&` on the script's exit code.

Output is truncated to 200 lines by default; pass a number before the command to raise it (e.g. `HOST 500 'journalctl -u app'`). Prefer narrowing with grep/sed/tail (inside the quoted command) over raising the limit. The script sets a 10s connection timeout and BatchMode.

```bash
# Read / search / inspect
.claude/ssh-operator/ssh-op.sh HOST 'cat -n /path/to/file'
.claude/ssh-operator/ssh-op.sh HOST 'grep -rn "pattern" /var/log/'
.claude/ssh-operator/ssh-op.sh HOST 'sudo systemctl status nginx'

# Edit in place
.claude/ssh-operator/ssh-op.sh HOST 'sed -i "s|old|new|g" /path/to/file'

# Write a file
.claude/ssh-operator/ssh-op.sh HOST 'tee /path/to/file' <<'REMOTE_EOF'
content here
REMOTE_EOF
```

## Rules

1. **Always go through the helper script** — never raw `ssh`
2. **Verify remote edits by reading back** — there is no Edit-tool safety net over SSH; `sed -i` exits 0 even when its pattern matched nothing (and the helper masks exit codes anyway)
3. **Confirm with the user before destructive operations** — deleting files, stopping or restarting services

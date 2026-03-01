---
name: ssh-operator
description: >
  This skill should be used when the user asks to "operate a remote machine",
  "SSH into a server", "check remote files", "edit files on remote",
  "run commands on remote", "check server status", "look at server logs",
  "restart a service", "deploy to the server", "investigate a server issue",
  "サーバーを調べて", "リモートで操作して", "リモートのファイルを見て",
  "ログを確認して", "サービスを再起動して",
  or needs to perform any operation on a remote machine via SSH.
  If CLAUDE.md or project memory contains host names or server information,
  use that to determine the target host without asking the user.
argument-hint: <host> [task description]
---

# SSH Operator

Operate a remote machine via SSH.

## Input

Parse the user's input:
- **Host**: First argument — SSH host name from `~/.ssh/config`
- **Task**: Remaining arguments — what to do on the remote machine

If no host: check CLAUDE.md / project memory for server info, otherwise ask.
If no task: ask.

## CRITICAL: Local vs Remote

Your Bash tool runs **locally**. The **only** way to run commands on the remote host is the helper script at:

```
${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh
```

- Do NOT run raw commands like `ls /var/log` or `cat /etc/nginx/nginx.conf` — these read your **local** filesystem
- Do NOT run `ssh` directly — always use the helper script

## Usage

```
"${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh" HOST [line-limit] command...
```

- Default output limit: 200 lines. Pass a number as 2nd arg to override (e.g. `HOST 500 journalctl ...`).
- The script handles connection timeouts, tilde expansion, and error reporting.

## Examples

```bash
# Read file
"${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh" HOST cat -n /path/to/file

# Read lines 50-100
"${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh" HOST sed -n '50,100p' /path/to/file

# Search
"${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh" HOST grep -rn 'pattern' /path/

# Find files
"${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh" HOST find /path -name '*.conf' -type f

# List directory
"${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh" HOST ls -la /path/

# Edit file
"${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh" HOST sed -i 's|old|new|g' /path/to/file

# Run command
"${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh" HOST systemctl status nginx

# With sudo
"${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh" HOST sudo systemctl restart nginx
```

**Write file**:
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh" HOST tee /path/to/file <<'REMOTE_EOF'
content here
REMOTE_EOF
```

## Rules

1. **Always use the helper script** — never raw `ssh`
2. **Fetch only what you need** — use grep/sed/head/tail to narrow output
3. **Verify edits** — after writing/editing, read back to confirm
4. **Report clearly** — summarize findings and changes
5. **Be cautious with destructive ops** — confirm before deleting files or stopping services

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
allowed-tools: Agent
---

# SSH Operator

Operate a remote machine via SSH through a dedicated subagent.

## When Invoked

Parse the user's input:
- **Host**: The first argument (`$1`) — an SSH host name from `~/.ssh/config`
- **Task**: The remaining arguments — what to do on the remote machine

If no host is provided:
- Check if CLAUDE.md or project memory mentions server host names and use the appropriate one
- Otherwise, ask the user which host to connect to

If no task is provided, ask the user what they want to do.

## Execution

Spawn the agent using the Agent tool with `subagent_type: "ssh-operator:ssh-operator"`:

```
Agent tool:
  subagent_type: "ssh-operator:ssh-operator"
  description: "SSH operation on <host>"
  prompt: |
    HOST=<host>

    ## Task
    <task description from user>

    Connect to the remote host using the helper script and complete the task.
    Report what you found and what you changed.
```

## After Completion

Report the agent's results to the user concisely. If the agent encountered issues or needs clarification, relay that to the user.

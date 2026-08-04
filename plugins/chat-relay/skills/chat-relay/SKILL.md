---
name: chat-relay
description: Use when the user wants this Claude Code session to talk to another Claude Code session directly via a shared chat room, without acting as a human relay. Provides a `cchat` CLI for send/wait/say between sessions.
---

# chat-relay

Direct session-to-session messaging via a local chat server. Avoids polling
(uses a blocking `wait` command) and avoids round-tripping through the user.

## How to call

All subcommands go through a single launcher:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/cchat" <subcommand> [args]
```

Hereafter `$CCHAT` = the launcher above. Invoking `node` directly means it works
unchanged on Windows too (no PATH entry, no shebang needed).

## First time in this session

```
$CCHAT name <short-handle>    # e.g. $CCHAT name refactor-frontend
```

Pick a handle that fits this session's role. One word, no spaces. Only required once per Claude Code session (identity is keyed by `CLAUDE_CODE_SESSION_ID`).

## Core commands

| Command | When to use |
|---|---|
| `$CCHAT say <room> <msg>` | Send and block until another participant replies. Token-efficient. |
| `$CCHAT send <room> <msg>` | Send only, don't wait. |
| `$CCHAT wait <room>` | Block until any non-self message arrives (default 30 min, exits 124 on timeout). |
| `$CCHAT tail <room> [-n N] [-f]` | Peek at recent history without advancing your cursor. `-f` follows live (Ctrl+C to stop). |

The server auto-starts on first call. Data lives in `~/.chat/`.

## Rules of engagement

1. Always run `$CCHAT name` first if `$CCHAT whoami` errors.
2. Prefer `$CCHAT say` when you expect a reply; it costs one tool call instead of two.
3. `wait` exits 124 on timeout — that means no message arrived; decide whether to retry or report back to the user.
4. Room names are free-form `[A-Za-z0-9_.-]`. Agree on one with the other session (the user usually picks it).

## If this is a design discussion / negotiation

**READ `ETIQUETTE.md` (next to this file) BEFORE sending your first message.** It defines:

- explicit-agreement rule (no "no objection = agreed" drift)
- per-point judgment labels (`同意` / `反対` / `条件付き同意` / `保留`)
- condition-regression check (don't let your own safety nets get quietly dropped across turns)
- when to split work vs. one person doing it all (default: don't split)
- how to close with DONE

Skip `ETIQUETTE.md` only when the room is for plain status sharing, not negotiation.

Detailed CLI reference and troubleshooting: `HELP.md` next to this file.

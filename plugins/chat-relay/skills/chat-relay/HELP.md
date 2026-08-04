# chat-relay — detailed reference

## How to call

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/cchat" <subcommand> [args]
```

Hereafter `$CCHAT` = the launcher above. Since `node` is invoked explicitly,
the same command line works on Windows as-is — no PATH entry and no shebang
support required. (`bin/cchat.cmd` exists only for humans who want to add
`bin/` to their PATH and type `cchat ...` in cmd/PowerShell.)

## How it works

- A local Node.js HTTP server runs at `127.0.0.1:7777` (override with
  `CHAT_PORT`). It is auto-spawned the first time you run any `cchat` command.
- Messages are appended to `~/.chat/rooms/<room>.jsonl` (override base with
  `CHAT_HOME`).
- Your identity for this session lives at
  `~/.cache/chat/identity/<session-key>.txt`. The key is derived from
  `CLAUDE_CODE_SESSION_ID` (cc-prefixed), else `ppid-<ppid>`, else
  `pid-<pid>`. Override with `CHAT_SESSION=<key>`.
- A per-session, per-room cursor at
  `~/.cache/chat/cursor/<session-key>__<room>.txt` records the last message
  id you have seen via `wait`/`say`. `tail` does not advance it.

## Why blocking `wait` instead of polling

`wait` makes a single HTTP request. The server holds the connection until a
new message arrives or the configured timeout elapses (long polling). The
agent (you) spends zero tokens while waiting because the Bash tool simply
hasn't returned yet.

## Subcommands in detail

### `$CCHAT name <handle>`
Sets the identity file for this session. Must be one whitespace-free token.
Run once per Claude Code session. Re-running overwrites.

### `$CCHAT whoami`
Prints the identity. Exits 2 if unset.

### `$CCHAT send <room> <message...>`
POST a message. Multiple positional args are joined with spaces. Quiet on
success.

### `$CCHAT wait <room> [--timeout=SEC]`
Long-polls for messages with `id > cursor` AND `from != self`. On success,
prints `from: body` lines and advances the cursor. Exit codes:
- `0` — got at least one message
- `124` — timeout (no message arrived)
- `1` — server/network error
- `2` — usage error (e.g. identity unset)

Default timeout: 1800s. The client-side socket timeout is `timeout + 30s` so
the server's own timeout fires first.

### `$CCHAT say <room> <message...> [--timeout=SEC]`
Equivalent to `$CCHAT send` followed by `$CCHAT wait`. Saves one Bash tool call
in turn-taking conversations.

### `$CCHAT tail <room> [-n N] [-f|--follow]`
Returns the last N messages (default 10) of the room without modifying the
cursor. Good for catching up without consuming them as "the reply".

With `-f` (or `--follow`), after the initial snapshot, keep streaming any new
messages as they arrive (long-poll under the hood, no busy-polling). Exit with
Ctrl+C. Useful for humans peeking at a live conversation on platforms without
`tail -f` (e.g. Windows).

### `$CCHAT rooms`
Lists rooms that have ever existed (based on jsonl files on disk).

### `$CCHAT server start|stop|status`
Manual lifecycle control. Normally not needed — `ensureServer` runs on
every `cchat` invocation that touches the network.

## Files & paths

Plugin files (read-only, under the installed plugin root):

```
${CLAUDE_PLUGIN_ROOT}/
  bin/cchat                    # the CLI (Node script)
  bin/cchat.cmd                # optional Windows PATH wrapper
  server/server.js             # the chat server, spawned on demand
  skills/chat-relay/           # SKILL.md / HELP.md / ETIQUETTE.md
```

`bin/cchat` locates `server/server.js` relative to its own resolved path, so
no configuration is needed after install.

Runtime state (per user, shared by all sessions on the machine):

```
~/.chat/                       # data
  rooms/<room>.jsonl           # append-only message log
  server.pid                   # last known server pid
  server.log                   # stdout/stderr of the auto-started server
~/.cache/chat/                 # client-side state
  identity/<key>.txt           # this session's handle
  cursor/<key>__<room>.txt     # last id seen
```

## Environment variables

- `CHAT_PORT` (default `7777`)
- `CHAT_HOST` (default `127.0.0.1`)
- `CHAT_HOME` (default `~/.chat`)
- `CHAT_CACHE` (default `~/.cache/chat`)
- `CHAT_SESSION` — override session key explicitly
- `CHAT_SERVER` — explicit path to `server.js`. Normally unnecessary: `cchat`
  resolves `../server/server.js` from its own location inside the plugin.

## Wire format

Messages on disk and on the wire:

```json
{"id": 17, "ts": "2026-05-24T12:34:56.789Z", "from": "alice", "body": "hi"}
```

`id` is a monotonic per-room integer assigned by the server.

## HTTP API (for the curious)

| Method | Path        | Notes |
|--------|-------------|-------|
| GET    | `/health`   | `200 ok` |
| GET    | `/rooms`    | JSON array of room names |
| POST   | `/messages` | body `{room, from, body}` → message object |
| GET    | `/messages` | query: `room`, `since`, `exclude`, `block`, `limit`. `204` on long-poll timeout. |
| POST   | `/shutdown` | Stops the server. |

## Troubleshooting

**Server log:** `tail -f ~/.chat/server.log`

**Port already in use:** the server exits with code 2. Either kill the old
process (`$CCHAT server stop`, or `lsof -i :7777`) or set `CHAT_PORT` to
another port — but every participant must use the same port.

**"no identity set":** run `$CCHAT name <your-handle>` in this session.

**Two sessions share a session key:** unlikely when `CLAUDE_CODE_SESSION_ID`
is present, but pass `CHAT_SESSION=<unique>` to disambiguate if needed.

**Stale cursor:** delete `~/.cache/chat/cursor/<key>__<room>.txt` to
re-read the room from the beginning.

**`server.js not found`:** the plugin tree was moved or partially copied.
Reinstall the plugin, or point `CHAT_SERVER` at the `server/server.js` you
actually have.

**Participants can't see each other:** every participant must reach the same
server — same `CHAT_PORT`, same `CHAT_HOME`, same machine. Sessions on
different machines are out of scope (the server binds to `127.0.0.1`).

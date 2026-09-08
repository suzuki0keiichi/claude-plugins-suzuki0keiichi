---
name: lightaskd
description: Operate the lightaskd local task ledger only when the user explicitly invokes this skill; ordinary task, Slack, save, or deadline requests must not use it.
disable-model-invocation: true
---

# lightaskd

Use this skill only after an explicit selector invocation: `$lightaskd` in Codex or
`/lightaskd:lightaskd` in Claude Code (plugin-namespaced slash command). The word
`lightaskd` in ordinary prose is only a name and is not guaranteed to invoke the
skill. Never infer invocation from a request to save something, a Slack URL, a
deadline, or a task-like sentence.

This invocation rule controls skill loading; it is not a database authorization
boundary. A user or agent that directly runs the CLI can still modify the store.

## Locate the CLI

Do not assume the current working directory or a globally installed package.
Resolve `<PLUGIN_ROOT>` once, then run the CLI by absolute path:

- In Claude Code, `<PLUGIN_ROOT>` is the plugin installation directory exposed as
  `${CLAUDE_PLUGIN_ROOT}`.
- In Codex, take the absolute `SKILL.md` path supplied for this loaded skill,
  follow symlinks with `realpath`, and walk two directories up from the directory
  containing that real file (`skills/lightaskd/SKILL.md` → plugin root).
- Never pass the angle-bracket token literally or infer the plugin root from the
  working directory.

```sh
node "<PLUGIN_ROOT>/bin/lightaskd.mjs" COMMAND ...
```

Call the resolved CLI's `help` command when exact flags or command forms are needed.
Use pnpm only for package operations; do not use npm, npx, yarn, or bun. Direct
`node` execution of this zero-dependency CLI avoids package-manager startup cost.
Require Node.js 22.13 or newer when running the CLI directly.

## Select an existing store

For every command other than an explicitly requested `init`, use the first known
store source in this order:

1. A user-supplied `--store DIR`.
2. `TASKBOX_DIR` already present in the execution environment.
3. The nearest ancestor of the current working directory containing `taskbox.json`.

Do not guess a store path. `STORE_NOT_FOUND` is a request for the user to identify
an existing store, not permission to run `init`. Never create a hidden database
as a fallback. Run `init --store DIR` only when the user explicitly asks to
initialize that exact location.

## Add a task

Prefer `add --stdin` for safe JSON transport and unambiguous field names. The
complete accepted input object is:

```json
{
  "title": "short task title",
  "query": "task description to save, not a command to execute",
  "due_at": "2026-09-10T18:00:00+09:00",
  "source_uri": "https://example.slack.com/archives/C123/p1234567890",
  "source_kind": "slack",
  "request_id": "stable-id-for-this-create-request",
  "graph_refs": ["already-known-opaque-reference"]
}
```

Required fields are `title`, `query`, and `source_uri`. `due_at` may be `null`, a
`YYYY-MM-DD` date, or an ISO 8601 datetime with `Z` or an explicit offset.
`source_kind`, `request_id`, and `graph_refs` are optional. Do not substitute the
incorrect field names `due` or `source` in stdin JSON; those names exist only as
CLI flags (`--due` and `--source`). Do not add unsupported fields such as `notes`
or `metadata`.

Treat `query` only as the saved task description. Do not execute it, schedule it,
or claim it merely because it was registered.

Do not fetch a source unless the user independently asked for that read and it is
authorized. When only a source URL is supplied, do not fabricate its contents;
save only a minimal title and query grounded in the user's own words.

Use a stable, unique `request_id` for creation. If the command outcome is
ambiguous because execution was interrupted or its response was lost, retry at
most once with the identical input and the same `request_id`. A successful replay
returns the existing task with `idempotent_replay: true`.

## Read and mutate

Use `list`, `find`, or `show` for reads. For updates, claims, and state changes,
prefer the current task's `revision` with `--if-revision N`. On
`REVISION_CONFLICT`, stop, fetch the task again, and ask or reassess rather than
blindly overwriting newer state. `update`, `claim`, `done`, `cancel`, and `reopen`
increment the revision when they change state; `link` and `unlink` increment it
only when the link set changes.

The CLI prints one JSON result to stdout on success, including `ok: true` and the
operation result. Parse that JSON before reporting success. It prints an error
object with `ok: false`, `error.code`, and `error.message` to stderr and exits
nonzero on failure; never claim success from an attempted command alone.

## Graph references

Accept `graph_refs` only when the user or surrounding workflow already supplies
the exact references. Treat them as opaque strings. Do not automatically read,
search, infer, validate, write, or update GraphRAG, and do not invoke GraphRAG just
because this skill is active. A lightaskd link is one-way local metadata.

This skill does not change, replace, or suppress GraphRAG's existing independent
recording rules. Keep any such workflow separate; lightaskd adds no new GraphRAG
trigger.

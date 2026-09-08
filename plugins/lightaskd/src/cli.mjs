import { readFileSync } from "node:fs";
import path from "node:path";
import { TaskboxError } from "./errors.mjs";
import { initStore, resolveStoreDir, TaskboxStore } from "./store.mjs";

const HELP = `lightaskd prototype

This CLI never activates itself. The package includes an explicit-invocation-only agent skill;
installing the package does not activate that skill automatically. It has no hooks, scheduler,
or GraphRAG writer.

Usage:
  lightaskd init [--store DIR]
  lightaskd add --title TEXT --query TEXT --source URI [--due ISO] [--request-id ID]
  lightaskd add --stdin
  lightaskd list [--state open|claimed|done|cancelled|all] [--limit N] [--due-before ISO]
  lightaskd find TEXT [--state STATE] [--limit N]
  lightaskd show TASK_ID
  lightaskd update TASK_ID [--title TEXT] [--query TEXT] [--due ISO|none]
  lightaskd claim TASK_ID --actor NAME [--lease-minutes N]
  lightaskd done|cancel|reopen TASK_ID [--if-revision N]
  lightaskd link|unlink TASK_ID GRAPH_REF [--kind graphrag]
  lightaskd doctor
  lightaskd snapshot --to DIR

Store resolution: --store DIR, then TASKBOX_DIR, then nearest ancestor containing taskbox.json.
All command results are JSON. --pretty pretty-prints the JSON.
The taskbox command remains available as a compatibility alias.
`;

function parse(argv) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    const value = next !== undefined && !next.startsWith("--") ? argv[++index] : true;
    const current = flags.get(key);
    flags.set(key, current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value]);
  }
  return { positionals, flags };
}

function flag(flags, name, fallback = undefined) {
  const value = flags.get(name);
  if (Array.isArray(value)) return value.at(-1);
  return value === undefined ? fallback : value;
}

function flagMany(flags, name) {
  const value = flags.get(name);
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function integerFlag(flags, name, fallback = undefined) {
  const value = flag(flags, name, fallback);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new TaskboxError("USAGE", `--${name} must be an integer`);
  return parsed;
}

function requirePositional(positionals, index, label) {
  const value = positionals[index];
  if (!value) throw new TaskboxError("USAGE", `${label} is required`);
  return value;
}

function stdinJson() {
  const text = readFileSync(0, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TaskboxError("INVALID_JSON", "stdin must contain one JSON object", { cause: String(error) });
  }
}

function printJson(value, pretty) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function addInput(flags) {
  if (flag(flags, "stdin") === true) return stdinJson();
  return {
    title: flag(flags, "title"),
    query: flag(flags, "query"),
    due_at: flag(flags, "due") === "none" ? null : flag(flags, "due"),
    source_uri: flag(flags, "source"),
    source_kind: flag(flags, "source-kind"),
    request_id: flag(flags, "request-id"),
    graph_refs: flagMany(flags, "graph-ref")
  };
}

function updateInput(flags) {
  const input = {};
  if (flags.has("title")) input.title = flag(flags, "title");
  if (flags.has("query")) input.query = flag(flags, "query");
  if (flags.has("due")) input.due_at = flag(flags, "due") === "none" ? null : flag(flags, "due");
  if (flags.has("source")) input.source_uri = flag(flags, "source");
  if (flags.has("source-kind")) input.source_kind = flag(flags, "source-kind");
  return input;
}

export async function runCli(argv) {
  const { positionals, flags } = parse(argv);
  const command = positionals[0];
  const pretty = flag(flags, "pretty") === true;
  if (!command || command === "help" || flag(flags, "help") === true) {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "init") {
    const directory = path.resolve(String(flag(flags, "store", ".taskbox")));
    printJson({ ok: true, operation: "init", ...initStore(directory) }, pretty);
    return 0;
  }

  const storeDir = resolveStoreDir(flag(flags, "store"));
  const store = new TaskboxStore(storeDir);
  try {
    let result;
    switch (command) {
      case "add":
        result = store.add(addInput(flags));
        break;
      case "list": {
        const tasks = store.list({
          state: String(flag(flags, "state", "open")),
          limit: integerFlag(flags, "limit", 20),
          dueBefore: flag(flags, "due-before")
        });
        result = { tasks, count: tasks.length };
        break;
      }
      case "find": {
        const tasks = store.find(requirePositional(positionals, 1, "search text"), {
          state: String(flag(flags, "state", "all")),
          limit: integerFlag(flags, "limit", 20)
        });
        result = { tasks, count: tasks.length };
        break;
      }
      case "show":
        result = { task: store.requireTask(requirePositional(positionals, 1, "task id")) };
        break;
      case "update":
        result = {
          task: store.update(
            requirePositional(positionals, 1, "task id"),
            updateInput(flags),
            integerFlag(flags, "if-revision")
          )
        };
        break;
      case "claim":
        result = {
          task: store.claim(
            requirePositional(positionals, 1, "task id"),
            String(flag(flags, "actor", "")),
            integerFlag(flags, "lease-minutes", 30),
            integerFlag(flags, "if-revision")
          )
        };
        break;
      case "done":
        result = store.transition(requirePositional(positionals, 1, "task id"), "done", integerFlag(flags, "if-revision"));
        break;
      case "cancel":
        result = store.transition(requirePositional(positionals, 1, "task id"), "cancelled", integerFlag(flags, "if-revision"));
        break;
      case "reopen":
        result = store.transition(requirePositional(positionals, 1, "task id"), "open", integerFlag(flags, "if-revision"));
        break;
      case "link":
        result = store.link(
          requirePositional(positionals, 1, "task id"),
          requirePositional(positionals, 2, "link target"),
          String(flag(flags, "kind", "graphrag"))
        );
        break;
      case "unlink":
        result = store.unlink(
          requirePositional(positionals, 1, "task id"),
          requirePositional(positionals, 2, "link target"),
          String(flag(flags, "kind", "graphrag"))
        );
        break;
      case "doctor":
        result = store.doctor();
        break;
      case "snapshot":
        result = store.snapshot(String(flag(flags, "to", "")));
        break;
      default:
        throw new TaskboxError("USAGE", `unknown command: ${command}`);
    }
    printJson({ ok: true, operation: command, ...result }, pretty);
    return 0;
  } finally {
    store.close();
  }
}

export function reportError(error) {
  const known = error instanceof TaskboxError;
  const payload = {
    ok: false,
    error: {
      code: known ? error.code : "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      ...(known && error.details !== undefined ? { details: error.details } : {})
    }
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  return known && error.code === "USAGE" ? 2 : 1;
}

import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskboxError, invariant } from "./errors.mjs";

const SCHEMA_VERSION = 1;
const CONFIG_FILE = "taskbox.json";
const DATABASE_FILE = "taskbox.db";
const ACTIVE_STATES = new Set(["open", "claimed"]);
const ALL_STATES = new Set(["open", "claimed", "done", "cancelled"]);
const ADD_FIELDS = new Set([
  "title",
  "query",
  "due_at",
  "source_uri",
  "source_kind",
  "request_id",
  "graph_refs"
]);
const UPDATE_FIELDS = new Set(["title", "query", "due_at", "source_uri", "source_kind"]);

function nowIso() {
  return new Date().toISOString();
}

function newTaskId() {
  const time = Date.now().toString(36).padStart(9, "0");
  const entropy = randomBytes(6).toString("hex");
  return `tsk_${time}_${entropy}`;
}

function rejectUnknownFields(input, allowed, operation) {
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  invariant(
    unknown.length === 0,
    "UNKNOWN_FIELD",
    `${operation} does not accept: ${unknown.join(", ")}`,
    { unknown }
  );
}

function requiredText(value, field, maxLength) {
  invariant(typeof value === "string", "INVALID_FIELD", `${field} must be a string`);
  const normalized = value.trim();
  invariant(normalized.length > 0, "INVALID_FIELD", `${field} must not be empty`);
  invariant(
    normalized.length <= maxLength,
    "INVALID_FIELD",
    `${field} must be at most ${maxLength} characters`
  );
  return normalized;
}

function optionalText(value, field, maxLength) {
  if (value === undefined || value === null) return null;
  return requiredText(value, field, maxLength);
}

export function normalizeDue(value) {
  if (value === undefined || value === null || value === "") {
    return { dueAt: null, dueTs: null };
  }
  invariant(typeof value === "string", "INVALID_DUE", "due_at must be a string or null");
  const raw = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const timestamp = Date.parse(dateOnly ? `${raw}T00:00:00.000Z` : raw);
  invariant(Number.isFinite(timestamp), "INVALID_DUE", "due_at must be YYYY-MM-DD or an ISO 8601 datetime");
  if (!dateOnly) {
    invariant(
      /(Z|[+-]\d{2}:\d{2})$/.test(raw),
      "INVALID_DUE",
      "datetime due_at must include Z or an explicit UTC offset"
    );
  }
  return { dueAt: dateOnly ? raw : new Date(timestamp).toISOString(), dueTs: timestamp };
}

function sourceKind(value, sourceUri) {
  if (value !== undefined && value !== null) return requiredText(value, "source_kind", 32);
  try {
    const url = new URL(sourceUri);
    if (url.hostname.endsWith(".slack.com") && url.pathname.includes("/archives/")) return "slack";
    return "url";
  } catch {
    return "other";
  }
}

function normalizeGraphRefs(value) {
  if (value === undefined || value === null) return [];
  invariant(Array.isArray(value), "INVALID_FIELD", "graph_refs must be an array of strings");
  const refs = value.map((ref) => requiredText(ref, "graph_ref", 2048));
  return [...new Set(refs)];
}

function safeChmod(file, mode) {
  try {
    chmodSync(file, mode);
  } catch {
    // Windows and some mounted filesystems do not implement POSIX permissions.
  }
}

function readConfig(storeDir) {
  const configPath = path.join(storeDir, CONFIG_FILE);
  invariant(existsSync(configPath), "STORE_NOT_FOUND", `taskbox store not found: ${storeDir}`);
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new TaskboxError("INVALID_STORE", `cannot read ${configPath}`, { cause: String(error) });
  }
  invariant(config.schema_version === SCHEMA_VERSION, "SCHEMA_MISMATCH", "unsupported taskbox schema version", {
    found: config.schema_version,
    supported: SCHEMA_VERSION
  });
  return config;
}

function configureDatabase(db) {
  db.exec("PRAGMA busy_timeout=10000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=FULL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
      query TEXT NOT NULL CHECK(length(query) BETWEEN 1 AND 2000),
      due_at TEXT,
      due_ts INTEGER,
      source_uri TEXT NOT NULL CHECK(length(source_uri) BETWEEN 1 AND 2048),
      source_kind TEXT NOT NULL CHECK(length(source_kind) BETWEEN 1 AND 32),
      state TEXT NOT NULL CHECK(state IN ('open', 'claimed', 'done', 'cancelled')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      request_id TEXT UNIQUE,
      claimed_by TEXT,
      claim_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS tasks_state_due_idx ON tasks(state, due_ts, created_at);
    CREATE INDEX IF NOT EXISTS tasks_source_idx ON tasks(source_uri);

    CREATE TABLE IF NOT EXISTS task_links (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 32),
      target TEXT NOT NULL CHECK(length(target) BETWEEN 1 AND 2048),
      created_at TEXT NOT NULL,
      PRIMARY KEY(task_id, kind, target)
    ) STRICT;
  `);
  db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
}

export function initStore(storeDir) {
  const absolute = path.resolve(storeDir);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const configPath = path.join(absolute, CONFIG_FILE);
  let created = false;
  if (!existsSync(configPath)) {
    const config = {
      schema_version: SCHEMA_VERSION,
      store_id: randomUUID(),
      created_at: nowIso()
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    created = true;
  }
  const config = readConfig(absolute);
  const dbPath = path.join(absolute, DATABASE_FILE);
  const db = new DatabaseSync(dbPath);
  try {
    configureDatabase(db);
  } finally {
    db.close();
  }
  safeChmod(absolute, 0o700);
  safeChmod(configPath, 0o600);
  safeChmod(dbPath, 0o600);
  return { created, store_dir: absolute, database: dbPath, store_id: config.store_id };
}

export function resolveStoreDir(explicit, startDir = process.cwd()) {
  if (explicit) return path.resolve(explicit);
  if (process.env.TASKBOX_DIR) return path.resolve(process.env.TASKBOX_DIR);
  let cursor = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(cursor, CONFIG_FILE))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new TaskboxError(
    "STORE_NOT_FOUND",
    "no taskbox store found; pass --store, set TASKBOX_DIR, or run inside a store"
  );
}

function rowToTask(db, row) {
  if (!row) return null;
  const links = db
    .prepare("SELECT kind, target, created_at FROM task_links WHERE task_id = ? ORDER BY kind, target")
    .all(row.id);
  return {
    id: row.id,
    title: row.title,
    query: row.query,
    due_at: row.due_at,
    source_uri: row.source_uri,
    source_kind: row.source_kind,
    state: row.state,
    revision: row.revision,
    request_id: row.request_id,
    claimed_by: row.claimed_by,
    claim_until: row.claim_until,
    created_at: row.created_at,
    updated_at: row.updated_at,
    links
  };
}

export class TaskboxStore {
  constructor(storeDir) {
    this.storeDir = path.resolve(storeDir);
    this.config = readConfig(this.storeDir);
    this.dbPath = path.join(this.storeDir, DATABASE_FILE);
    invariant(existsSync(this.dbPath), "STORE_NOT_FOUND", `taskbox database not found: ${this.dbPath}`);
    this.db = new DatabaseSync(this.dbPath);
    configureDatabase(this.db);
  }

  close() {
    this.db.close();
  }

  transaction(work) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  add(input) {
    invariant(input && typeof input === "object" && !Array.isArray(input), "INVALID_INPUT", "add input must be an object");
    rejectUnknownFields(input, ADD_FIELDS, "add");
    const title = requiredText(input.title, "title", 160);
    const query = requiredText(input.query, "query", 2000);
    const sourceUri = requiredText(input.source_uri, "source_uri", 2048);
    const due = normalizeDue(input.due_at);
    const requestId = optionalText(input.request_id, "request_id", 512);
    const graphRefs = normalizeGraphRefs(input.graph_refs);
    const timestamp = nowIso();
    const id = newTaskId();

    try {
      return this.transaction(() => {
        this.db.prepare(`
          INSERT INTO tasks(
            id, title, query, due_at, due_ts, source_uri, source_kind,
            state, revision, request_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?)
        `).run(
          id,
          title,
          query,
          due.dueAt,
          due.dueTs,
          sourceUri,
          sourceKind(input.source_kind, sourceUri),
          requestId,
          timestamp,
          timestamp
        );
        const insertLink = this.db.prepare(
          "INSERT INTO task_links(task_id, kind, target, created_at) VALUES (?, 'graphrag', ?, ?)"
        );
        for (const ref of graphRefs) insertLink.run(id, ref, timestamp);
        return { task: this.get(id), idempotent_replay: false };
      });
    } catch (error) {
      if (requestId) {
        const existing = this.db.prepare("SELECT * FROM tasks WHERE request_id = ?").get(requestId);
        if (existing) return { task: rowToTask(this.db, existing), idempotent_replay: true };
      }
      throw error;
    }
  }

  get(id) {
    return rowToTask(this.db, this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
  }

  requireTask(id) {
    const task = this.get(id);
    invariant(task, "TASK_NOT_FOUND", `task not found: ${id}`);
    return task;
  }

  list({ state = "open", limit = 20, dueBefore = undefined } = {}) {
    invariant(Number.isInteger(limit) && limit >= 1 && limit <= 200, "INVALID_LIMIT", "limit must be between 1 and 200");
    const where = [];
    const params = [];
    if (state !== "all") {
      invariant(ALL_STATES.has(state), "INVALID_STATE", `unknown state: ${state}`);
      where.push("state = ?");
      params.push(state);
    }
    if (dueBefore !== undefined) {
      const due = normalizeDue(dueBefore);
      invariant(due.dueTs !== null, "INVALID_DUE", "due-before must not be null");
      where.push("due_ts IS NOT NULL AND due_ts <= ?");
      params.push(due.dueTs);
    }
    const sql = `
      SELECT * FROM tasks
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY due_ts IS NULL, due_ts, created_at
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params, limit);
    return rows.map((row) => rowToTask(this.db, row));
  }

  find(text, { state = "all", limit = 20 } = {}) {
    const needle = requiredText(text, "text", 500);
    invariant(Number.isInteger(limit) && limit >= 1 && limit <= 200, "INVALID_LIMIT", "limit must be between 1 and 200");
    const params = [`%${needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`];
    let stateClause = "";
    if (state !== "all") {
      invariant(ALL_STATES.has(state), "INVALID_STATE", `unknown state: ${state}`);
      stateClause = "AND state = ?";
      params.push(state);
    }
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE (title LIKE ? ESCAPE '\\' OR query LIKE ? ESCAPE '\\' OR source_uri LIKE ? ESCAPE '\\')
      ${stateClause}
      ORDER BY state IN ('open', 'claimed') DESC, due_ts IS NULL, due_ts, created_at DESC
      LIMIT ?
    `).all(params[0], params[0], params[0], ...params.slice(1), limit);
    return rows.map((row) => rowToTask(this.db, row));
  }

  update(id, patch, expectedRevision = undefined) {
    invariant(patch && typeof patch === "object" && !Array.isArray(patch), "INVALID_INPUT", "update input must be an object");
    rejectUnknownFields(patch, UPDATE_FIELDS, "update");
    invariant(Object.keys(patch).length > 0, "INVALID_INPUT", "update requires at least one field");
    return this.transaction(() => {
      const current = this.requireTask(id);
      if (expectedRevision !== undefined) {
        invariant(current.revision === expectedRevision, "REVISION_CONFLICT", "task revision changed", {
          expected: expectedRevision,
          actual: current.revision
        });
      }
      const next = {
        title: patch.title === undefined ? current.title : requiredText(patch.title, "title", 160),
        query: patch.query === undefined ? current.query : requiredText(patch.query, "query", 2000),
        source_uri: patch.source_uri === undefined ? current.source_uri : requiredText(patch.source_uri, "source_uri", 2048),
        source_kind: patch.source_kind === undefined
          ? current.source_kind
          : requiredText(patch.source_kind, "source_kind", 32)
      };
      const due = patch.due_at === undefined
        ? { dueAt: current.due_at, dueTs: current.due_at === null ? null : normalizeDue(current.due_at).dueTs }
        : normalizeDue(patch.due_at);
      this.db.prepare(`
        UPDATE tasks SET
          title = ?, query = ?, due_at = ?, due_ts = ?, source_uri = ?, source_kind = ?,
          revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(next.title, next.query, due.dueAt, due.dueTs, next.source_uri, next.source_kind, nowIso(), id);
      return this.requireTask(id);
    });
  }

  transition(id, targetState, expectedRevision = undefined) {
    invariant(["open", "done", "cancelled"].includes(targetState), "INVALID_STATE", `invalid transition target: ${targetState}`);
    return this.transaction(() => {
      const current = this.requireTask(id);
      if (expectedRevision !== undefined) {
        invariant(current.revision === expectedRevision, "REVISION_CONFLICT", "task revision changed", {
          expected: expectedRevision,
          actual: current.revision
        });
      }
      if (current.state === targetState) return { task: current, idempotent_replay: true };
      this.db.prepare(`
        UPDATE tasks SET state = ?, claimed_by = NULL, claim_until = NULL,
          revision = revision + 1, updated_at = ? WHERE id = ?
      `).run(targetState, nowIso(), id);
      return { task: this.requireTask(id), idempotent_replay: false };
    });
  }

  claim(id, actor, leaseMinutes = 30, expectedRevision = undefined) {
    const claimedBy = requiredText(actor, "actor", 160);
    invariant(Number.isInteger(leaseMinutes) && leaseMinutes >= 1 && leaseMinutes <= 1440, "INVALID_LEASE", "lease must be 1..1440 minutes");
    return this.transaction(() => {
      const current = this.requireTask(id);
      if (expectedRevision !== undefined) {
        invariant(current.revision === expectedRevision, "REVISION_CONFLICT", "task revision changed", {
          expected: expectedRevision,
          actual: current.revision
        });
      }
      const expired = current.state === "claimed" && Date.parse(current.claim_until ?? "") <= Date.now();
      invariant(current.state === "open" || expired, "TASK_NOT_CLAIMABLE", `task is ${current.state}`, {
        claimed_by: current.claimed_by,
        claim_until: current.claim_until
      });
      const until = new Date(Date.now() + leaseMinutes * 60_000).toISOString();
      this.db.prepare(`
        UPDATE tasks SET state = 'claimed', claimed_by = ?, claim_until = ?,
          revision = revision + 1, updated_at = ? WHERE id = ?
      `).run(claimedBy, until, nowIso(), id);
      return this.requireTask(id);
    });
  }

  link(id, target, kind = "graphrag") {
    const normalizedTarget = requiredText(target, "target", 2048);
    const normalizedKind = requiredText(kind, "kind", 32);
    return this.transaction(() => {
      this.requireTask(id);
      const result = this.db.prepare(
        "INSERT OR IGNORE INTO task_links(task_id, kind, target, created_at) VALUES (?, ?, ?, ?)"
      ).run(id, normalizedKind, normalizedTarget, nowIso());
      if (Number(result.changes) > 0) {
        this.db.prepare("UPDATE tasks SET revision = revision + 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
      }
      return { task: this.requireTask(id), idempotent_replay: Number(result.changes) === 0 };
    });
  }

  unlink(id, target, kind = "graphrag") {
    return this.transaction(() => {
      this.requireTask(id);
      const result = this.db.prepare("DELETE FROM task_links WHERE task_id = ? AND kind = ? AND target = ?").run(
        id,
        requiredText(kind, "kind", 32),
        requiredText(target, "target", 2048)
      );
      if (Number(result.changes) > 0) {
        this.db.prepare("UPDATE tasks SET revision = revision + 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
      }
      return { task: this.requireTask(id), idempotent_replay: Number(result.changes) === 0 };
    });
  }

  doctor() {
    const integrity = this.db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
    const counts = Object.fromEntries(
      [...ALL_STATES].map((state) => [state, Number(this.db.prepare("SELECT count(*) AS n FROM tasks WHERE state = ?").get(state).n)])
    );
    return {
      ok: integrity.length === 1 && integrity[0] === "ok",
      integrity,
      schema_version: SCHEMA_VERSION,
      store_id: this.config.store_id,
      store_dir: this.storeDir,
      database: this.dbPath,
      counts,
      active_count: [...ACTIVE_STATES].reduce((sum, state) => sum + counts[state], 0)
    };
  }

  snapshot(destination) {
    const target = path.resolve(destination);
    invariant(target !== this.storeDir, "INVALID_DESTINATION", "snapshot destination must differ from the store");
    invariant(!target.startsWith(`${this.storeDir}${path.sep}`), "INVALID_DESTINATION", "snapshot destination must not be inside the store");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const targetDb = path.join(target, DATABASE_FILE);
    invariant(!existsSync(targetDb), "DESTINATION_EXISTS", `snapshot database already exists: ${targetDb}`);
    this.db.exec("PRAGMA wal_checkpoint(FULL)");
    const quoted = targetDb.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${quoted}'`);
    copyFileSync(path.join(this.storeDir, CONFIG_FILE), path.join(target, CONFIG_FILE));
    safeChmod(target, 0o700);
    safeChmod(targetDb, 0o600);
    safeChmod(path.join(target, CONFIG_FILE), 0o600);
    return {
      store_id: this.config.store_id,
      snapshot_dir: target,
      database: targetDb,
      bytes: statSync(targetDb).size,
      created_at: nowIso()
    };
  }
}

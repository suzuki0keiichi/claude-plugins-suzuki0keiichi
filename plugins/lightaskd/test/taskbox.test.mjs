import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { initStore, TaskboxStore } from "../src/store.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(projectRoot, "bin", "taskbox.mjs");
const primaryCli = path.join(projectRoot, "bin", "lightaskd.mjs");

function tempStore() {
  const root = mkdtempSync(path.join(tmpdir(), "taskbox-test-"));
  const storeDir = path.join(root, "store");
  initStore(storeDir);
  return { root, storeDir };
}

function sample(overrides = {}) {
  return {
    title: "認証方式を確認",
    query: "Slackの決定事項を確認し、認証方式へ反映する",
    due_at: "2026-09-10T18:00:00+09:00",
    source_uri: "https://example.slack.com/archives/C123/p1234567890",
    request_id: `req-${Math.random()}`,
    ...overrides
  };
}

test("lightaskd is the primary CLI and taskbox remains a compatible alias", async () => {
  const [primary, compatibility] = await Promise.all([
    execFileAsync(process.execPath, [primaryCli, "--help"]),
    execFileAsync(process.execPath, [cli, "--help"])
  ]);

  assert.equal(primary.stdout, compatibility.stdout);
  assert.match(primary.stdout, /^lightaskd prototype/m);
  assert.match(primary.stdout, /explicit-invocation-only agent skill/);
  assert.match(primary.stdout, /taskbox command remains available as a compatibility alias/);
});

test("add, one-way graph link, claim, done, and doctor", () => {
  const { root, storeDir } = tempStore();
  const store = new TaskboxStore(storeDir);
  try {
    const added = store.add(sample({ graph_refs: ["vault:proj/goal:proj:auth"] }));
    assert.equal(added.idempotent_replay, false);
    assert.equal(added.task.source_kind, "slack");
    assert.equal(added.task.links[0].target, "vault:proj/goal:proj:auth");

    const claimed = store.claim(added.task.id, "codex:test", 10, 1);
    assert.equal(claimed.state, "claimed");
    assert.equal(claimed.claimed_by, "codex:test");

    const completed = store.transition(added.task.id, "done", claimed.revision);
    assert.equal(completed.task.state, "done");
    assert.equal(store.list().length, 0);
    assert.equal(store.list({ state: "done" }).length, 1);
    assert.equal(store.doctor().ok, true);

    const snapshot = store.snapshot(path.join(root, "snapshot"));
    assert.ok(snapshot.bytes > 0);
  } finally {
    store.close();
  }
});

test("request_id makes retries idempotent", () => {
  const { storeDir } = tempStore();
  const store = new TaskboxStore(storeDir);
  try {
    const input = sample({ request_id: "same-request" });
    const first = store.add(input);
    const replay = store.add(input);
    assert.equal(replay.idempotent_replay, true);
    assert.equal(replay.task.id, first.task.id);
    assert.equal(store.list().length, 1);
  } finally {
    store.close();
  }
});

test("strict input rejects a generic notes field", () => {
  const { storeDir } = tempStore();
  const store = new TaskboxStore(storeDir);
  try {
    assert.throws(() => store.add(sample({ notes: "AIが自由文を溜める場所" })), /does not accept: notes/);
  } finally {
    store.close();
  }
});

test("parallel CLI writers do not lose requests", async () => {
  const { storeDir } = tempStore();
  const writers = Array.from({ length: 16 }, (_, index) =>
    execFileAsync(process.execPath, [
      cli,
      "add",
      "--store",
      storeDir,
      "--title",
      `parallel-${index}`,
      "--query",
      `並行要求 ${index} を処理する`,
      "--source",
      `source:${index}`,
      "--request-id",
      `parallel-request-${index}`
    ])
  );
  const results = await Promise.all(writers);
  for (const result of results) assert.equal(JSON.parse(result.stdout).ok, true);

  const store = new TaskboxStore(storeDir);
  try {
    assert.equal(store.list({ limit: 100 }).length, 16);
    assert.equal(store.doctor().ok, true);
  } finally {
    store.close();
  }
});

test("only one parallel replay with the same request_id is created", async () => {
  const { storeDir } = tempStore();
  const writers = Array.from({ length: 12 }, () =>
    execFileAsync(process.execPath, [
      cli,
      "add",
      "--store",
      storeDir,
      "--title",
      "same task",
      "--query",
      "同じ要求を一度だけ保存する",
      "--source",
      "source:same",
      "--request-id",
      "same-concurrent-request"
    ])
  );
  const results = await Promise.all(writers);
  assert.equal(results.filter((result) => JSON.parse(result.stdout).idempotent_replay === false).length, 1);

  const store = new TaskboxStore(storeDir);
  try {
    assert.equal(store.list({ limit: 100 }).length, 1);
  } finally {
    store.close();
  }
});

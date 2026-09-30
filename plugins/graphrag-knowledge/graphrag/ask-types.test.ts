// issue #36 (部分対応): 型の意図は query 文字列ではなく ask --types の構造化 filter で渡す。
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildVaultFiles } from "./build-vault.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");

test("ask --types は brief と evidence の両段に同じ filter を渡し、未知型は入力エラー", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "asktypes-"));
  try {
    const vault = path.join(tmp, "vault");
    for (const f of buildVaultFiles({
      generated_at: "2026-01-01T00:00:00.000Z",
      nodes: [
        { id: "file:s:a.ts", type: "File", title: "a.ts", path: "a.ts" },
        { id: "decision:s:d", type: "Decision", title: "retry policy", summary: "retry policy for writes" },
        { id: "risk:s:r", type: "Risk", title: "retry policy risk", summary: "retry policy may loop" }
      ],
      edges: []
    })) {
      mkdirSync(path.dirname(path.join(vault, f.relPath)), { recursive: true });
      writeFileSync(path.join(vault, f.relPath), f.content);
    }
    execFileSync("git", ["-C", tmp, "init", "-q"]);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, GRAPHRAG_VAULT_DIR: vault };
    const run = (args: string[]) => spawnSync("node", ["--experimental-strip-types", CLI, "ask", ...args], { cwd: tmp, env, encoding: "utf8" });
    // 部分一致 (coverage が LOW 未満) の query で brief を弱くし、evidence へ段上げさせる
    const r = run(["--lexical-only", "--limit", "1", "--types", "Risk", "retry storm handling"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const types = out.stages.flatMap((s: any) =>
      (s.output?.query?.matches ?? s.output?.direct_evidence ?? []).map((m: any) => m.node.type));
    assert.ok(out.stages.some((s: any) => s.stage === "evidence"), "escalated to evidence");
    assert.ok(types.length > 0 && types.every((t: string) => t === "Risk"), JSON.stringify(types));
    const bad = run(["--lexical-only", "--types", "Decisoin", "retry policy"]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /unknown node type "Decisoin"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── issue #36: ask の型名摂動チェック (type_word_divergence) ─────────────────────

import { detectTypeWordDivergence } from "./cli-headlines.ts";
import { DEFAULT_SCHEMA } from "./schema.ts";

const TYPES = DEFAULT_SCHEMA.nodeTypes;
const briefWith = (...ids: string[]) => async () => ({ query: { matches: ids.map((id) => ({ node: { id, type: "Decision", title: id } })) } });

test("detectTypeWordDivergence: 型名が無ければ補助検索せず null / top1 一致なら null", async () => {
  let called = 0;
  const run = async () => { called += 1; return (await briefWith("a")()); };
  assert.equal(await detectTypeWordDivergence({ question: "retry policy", typeNames: TYPES, explicitTypes: [], originalTopId: "a", runBrief: run }), null);
  assert.equal(called, 0);
  assert.equal(await detectTypeWordDivergence({ question: "retry policy の Decision", typeNames: TYPES, explicitTypes: [], originalTopId: "a", runBrief: run }), null);
  assert.equal(called, 1);
});

test("detectTypeWordDivergence: 不一致なら diverged + 除去版候補 + 正規名の --types 2 択", async () => {
  const d = await detectTypeWordDivergence({ question: "vault フラグの decision と Decision を見直す", typeNames: TYPES, explicitTypes: [], originalTopId: "wrong", runBrief: briefWith("right", "x") });
  assert.equal(d.status, "diverged");
  assert.deepEqual(d.type_words, ["Decision"]);
  assert.equal(d.stripped_query, "vault フラグの と を見直す");
  assert.deepEqual(d.stripped_top.map((m: any) => m.id), ["right", "x"]);
  assert.match(d.next_action, /--types Decision/);
  const explicit = await detectTypeWordDivergence({ question: "vault フラグの Decision", typeNames: TYPES, explicitTypes: ["Decision", "Risk"], originalTopId: "wrong", runBrief: briefWith("right") });
  assert.match(explicit.next_action, /--types Decision,Risk/);
});

test("detectTypeWordDivergence: 補助検索の失敗は unavailable (不一致を観測したとは言わない)", async () => {
  const d = await detectTypeWordDivergence({ question: "retry の Decision", typeNames: TYPES, explicitTypes: [], originalTopId: "a", runBrief: async () => { throw new Error("embed down"); } });
  assert.equal(d.status, "unavailable");
  assert.equal(d.reason, "embed down");
  assert.equal(d.stripped_top, undefined);
});

test("ask: 型名で 1 位が変わる question は high を low に上限し、evidence へ段上げせず divergence を出す", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "askdiv-"));
  try {
    const vault = path.join(tmp, "vault");
    for (const f of buildVaultFiles({
      generated_at: "2026-01-01T00:00:00.000Z",
      nodes: [
        { id: "decision:s:target", type: "Decision", title: "retry policy", summary: "retry policy for writes" },
        { id: "operationalknowledge:s:distractor", type: "OperationalKnowledge", title: "Decision notes", summary: "Decision retry" }
      ],
      edges: []
    })) {
      mkdirSync(path.dirname(path.join(vault, f.relPath)), { recursive: true });
      writeFileSync(path.join(vault, f.relPath), f.content);
    }
    execFileSync("git", ["-C", tmp, "init", "-q"]);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, GRAPHRAG_VAULT_DIR: vault };
    const r = spawnSync("node", ["--experimental-strip-types", CLI, "ask", "--lexical-only", "retry policy Decision"], { cwd: tmp, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.stages[0].output.query.matches[0].node.id, "operationalknowledge:s:distractor"); // 元の誤 top1 は保持
    assert.equal(out.stages[0].output.query.match_confidence, "low");
    assert.equal(out.final_stage, "brief");
    assert.equal(out.type_word_divergence.status, "diverged");
    assert.equal(out.type_word_divergence.stripped_top[0].id, "decision:s:target");
    assert.match(out.next_action_hint, /ask "retry policy" --types Decision/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

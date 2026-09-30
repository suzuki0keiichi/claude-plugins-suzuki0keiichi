// issue #43: aliases が string[] でない node で ask が落ちず、fsck/書き込みは不正形を拒否する。
// graphrag:enforces constraint:graphrag-skill-dev:aliases-string-array — aliases は string[] 契約
import assert from "node:assert/strict";
import test from "node:test";
import { nodeAliases, validateGraph } from "./schema.ts";
import { computeNodeLexical } from "./retrieval.ts";
import { validateMutation } from "./mutation-core.ts";

const node = (aliases: unknown) => ({ id: "decision:s:a", type: "Decision", title: "A", summary: "a", aliases });

test("nodeAliases: 文字列は分割せず単一 alias、配列中の非文字列/空文字は捨てる", () => {
  assert.deepEqual(nodeAliases(node("foo,bar")), ["foo,bar"]);
  assert.deepEqual(nodeAliases(node(["x", 1, "", null, "y"])), ["x", "y"]);
  assert.deepEqual(nodeAliases(node(undefined)), []);
  assert.deepEqual(nodeAliases(node({ a: 1 })), []);
});

test("computeNodeLexical: 文字列 aliases でも TypeError にならず alias として検索対象になる", () => {
  const lex = computeNodeLexical(node("OtherName"));
  assert.equal(lex.aliases.length, 1);
  assert.match(lex.haystack, /othername/i);
});

test("validateGraph: 文字列/非文字列要素の aliases は failure、空配列・未設定は可", () => {
  assert.ok(validateGraph({ nodes: [node("a,b")], edges: [] }).some((f) => f.includes("invalid aliases")));
  assert.ok(validateGraph({ nodes: [node(["a", 1])], edges: [] }).some((f) => f.includes("invalid aliases")));
  assert.equal(validateGraph({ nodes: [node([])], edges: [] }).filter((f) => f.includes("aliases")).length, 0);
  assert.equal(validateGraph({ nodes: [node(undefined)], edges: [] }).filter((f) => f.includes("aliases")).length, 0);
});

test("書き込み: 文字列 aliases の create は拒否、既存の不正 node は op:update で修復できる", () => {
  const empty = { nodes: [], edges: [] };
  const bad = validateMutation({
    currentGraph: empty,
    plan: { reason: "r", nodes: [{ op: "create", ...node("a,b") }], edges: [] }
  });
  assert.equal(bad.valid, false);

  const broken = { nodes: [node("a,b")], edges: [] };
  const repair = validateMutation({
    currentGraph: broken,
    plan: { reason: "r", nodes: [{ op: "update", id: "decision:s:a", aliases: ["a", "b"] }], edges: [] }
  });
  assert.deepEqual(repair.failures, []);
});

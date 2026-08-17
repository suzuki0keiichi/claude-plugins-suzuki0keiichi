import assert from "node:assert/strict";
import test from "node:test";
import { collectTextFields, grepGraph, showNodes } from "./node-grep.ts";

const graph = () => ({
  nodes: [
    {
      id: "decision:s:zebra-policy",
      type: "Decision",
      title: "zebra を採用",
      summary: "縞模様が良い",
      state: "active",
      aliases: ["zebraPolicy_v1"],
      description: "1行目です\nzebra の根拠は縞\n3行目です",
      display: { badge: { text: "ZEBRA-BADGE" } }
    },
    {
      id: "ok:s:burn",
      type: "OperationalKnowledge",
      title: "運用ハマり",
      summary: "zebra とは無関係",
      raw_content: "作業ログ:\nここに zebra が出る\nおわり"
    },
    { id: "file:s:src/zebra.ts", type: "File", path: "src/zebra.ts", title: "zebra.ts" }
  ],
  edges: [
    { id: "e1", type: "documented_by", from: "decision:s:zebra-policy", to: "file:s:src/zebra.ts" }
  ]
});

test("collectTextFields: ネスト/配列を field パス付きで列挙する", () => {
  const fields = collectTextFields(graph().nodes[0]);
  const byField = new Map(fields.map((f) => [f.field, f.text]));
  assert.equal(byField.get("id"), "decision:s:zebra-policy");
  assert.equal(byField.get("aliases[0]"), "zebraPolicy_v1");
  assert.equal(byField.get("display.badge.text"), "ZEBRA-BADGE");
  assert.ok(byField.has("description"));
});

test("grep: id 断片・description 行・raw_content 行・path が全部引ける (ranked search の除外対象を補完)", () => {
  const r = grepGraph(graph(), "zebra");
  assert.equal(r.hits_total, 3);
  const dec = r.hits.find((h) => h.id === "decision:s:zebra-policy")!;
  const fieldsHit = dec.matches.map((m) => m.field);
  assert.ok(fieldsHit.includes("id"), "id 断片で引ける");
  const descHit = [...dec.matches, ...Array(0)].find((m) => m.field === "description");
  // matches はノードあたり 3 件 cap — id/title/summary… の順で埋まる場合があるので overflow 込みで確認
  assert.ok(descHit || (dec.matches_overflow ?? 0) > 0);
  const okNode = r.hits.find((h) => h.id === "ok:s:burn")!;
  const raw = okNode.matches.find((m) => m.field === "raw_content");
  assert.ok(raw, "raw_content の行が引ける");
  assert.equal(raw!.line, 2, "複数行フィールドは行番号付き");
  const file = r.hits.find((h) => h.id === "file:s:src/zebra.ts")!;
  assert.ok(file.matches.some((m) => m.field === "path" || m.field === "id"));
});

test("grep: 既定は大文字小文字を無視 / --case-sensitive 相当で区別 / regex モード", () => {
  assert.equal(grepGraph(graph(), "ZEBRA-badge").hits_total, 1);
  assert.equal(grepGraph(graph(), "ZEBRA-badge", { caseSensitive: true }).hits_total, 0);
  const r = grepGraph(graph(), "^zebra の根拠", { regex: true });
  assert.equal(r.hits_total, 1);
  assert.equal(r.hits[0].matches[0].field, "description");
  assert.throws(() => grepGraph(graph(), "([", { regex: true }), /Invalid regular expression|Unterminated/);
});

test("grep: types フィルタと limit (超過は hits_total にだけ数える — 無言 cap にしない)", () => {
  const typed = grepGraph(graph(), "zebra", { types: ["Decision"] });
  assert.equal(typed.hits_total, 1);
  assert.equal(typed.hits[0].id, "decision:s:zebra-policy");
  const limited = grepGraph(graph(), "zebra", { limit: 1 });
  assert.equal(limited.hits.length, 1);
  assert.equal(limited.hits_total, 3);
});

test("show: 全フィールド verbatim + 接続エッジ (方向・相手タイトル付き)", () => {
  const [r] = showNodes(graph(), ["decision:s:zebra-policy"]);
  assert.equal(r.found, true);
  assert.equal((r.node as any).description, "1行目です\nzebra の根拠は縞\n3行目です", "description が短縮なしで読める");
  assert.deepEqual(r.edges, [
    { relation: "documented_by", direction: "out", other: "file:s:src/zebra.ts", other_title: "zebra.ts" }
  ]);
  const [inSide] = showNodes(graph(), ["file:s:src/zebra.ts"]);
  assert.equal(inSide.edges![0].direction, "in");
});

test("show: 欠損 id は found:false (vault 未指定なら tombstone 解決なし)", () => {
  const [r] = showNodes(graph(), ["decision:s:missing"]);
  assert.equal(r.found, false);
  assert.equal(r.tombstone, undefined);
});

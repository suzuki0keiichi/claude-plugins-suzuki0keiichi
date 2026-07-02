import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAllowedOrphan } from "./check-carving.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "check-carving.ts");

// 回帰: allowed-orphan はルート直下の manifest/lock/workspace と env/example/tool 設定も拾う。
// 以前は先頭スラッシュ必須で repo ルートの package.json / tsconfig.base.json 等を取りこぼし、
// component-coverage ERROR を誤発火していた。
test("isAllowedOrphan: ルート直下 config と env/example/tool 設定を許容する", () => {
  for (const p of [
    "package.json",
    "tsconfig.base.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "apps/server/.env.example",
    "sakura/app.env.example",
    "apps/server/family.example.json",
    ".claude/settings.json",
    "apps/web/vite.config.ts",
    // env ファイル命名規約 (環境名サフィックスのみ)
    ".env",
    "apps/server/.env.local",
    "config/.env.production",
  ]) {
    assert.equal(isAllowedOrphan(p), true, `${p} は allowed-orphan であるべき`);
  }
});

test("isAllowedOrphan: 通常の実装ソースは許容しない", () => {
  for (const p of [
    "apps/server/src/auth.ts",
    "apps/web/src/pages/ChatPage.tsx",
    // 実装サンプル (.example.ts/.js) はコード実体 → allowed-orphan にしない (設定雛形 .example.json のみ許容)
    "src/widgets/foo.example.ts",
    "src/demo/sample.example.js",
    // ".env" を名前に含むコード/データ実体は env ファイルではない → 網羅性ゲートの対象に残す
    "src/config.env.ts",
    "src/data.env.json",
  ]) {
    assert.equal(isAllowedOrphan(p), false, `${p} は Component 所属が要るので allowed-orphan でない`);
  }
});

function runCheckIn(dir: string, graph: any, extraArgs: string[] = []): { code: number; out: string } {
  const gp = path.join(dir, "graph.json");
  writeFileSync(gp, JSON.stringify(graph));
  try {
    const out = execFileSync("node", ["--experimental-strip-types", CLI, "--graph", gp, ...extraArgs], {
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e: any) {
    // ERROR があると exit 1。stdout は e.stdout に入る。
    return { code: e.status ?? 1, out: String(e.stdout ?? "") };
  }
}

function runCheck(graph: any, extraArgs: string[] = []): { code: number; out: string } {
  return runCheckIn(mkdtempSync(path.join(tmpdir(), "cc-")), graph, extraArgs);
}

// 回帰: carve 未完の候補 (candidate:true / プレースホルダ title) は ERROR で止める。
// 旧 indexer 製で summary_provisional フラグを持たない候補も candidate / title で捕まえる。
test("carving-check: candidate:true 残存と プレースホルダ title を ERROR にする", () => {
  const graph = {
    nodes: [
      { id: "system:s", type: "System", title: "S", summary: "s" },
      // 旧 indexer 相当: candidate:true・プレースホルダ title・summary_provisional フラグ無し
      {
        id: "layer:s:band0",
        type: "Layer",
        candidate: true,
        title: "Layer band 0/3 (41 files)",
        summary: "依存トポロジの深さ帯 band 0",
      },
    ],
    edges: [],
  };
  const { code, out } = runCheck(graph);
  assert.equal(code, 1, "ERROR があるので exit 1");
  assert.match(out, /candidate-uncarved/, "candidate:true 残存を検出");
  assert.match(out, /placeholder-title/, "プレースホルダ title を検出");
});

test("carving-check: 意味命名された Layer は candidate/placeholder ルールを発火しない", () => {
  const graph = {
    nodes: [
      { id: "system:s", type: "System", title: "S", summary: "s" },
      {
        id: "layer:s:foundation",
        type: "Layer",
        title: "基盤層 — 設定・データの土台",
        summary: "上位が共通依存する最下層",
      },
      // 正当な意味命名に "candidate" や数字を含むケース → 誤爆しないこと (c 接頭辞の連番のみ弾く)
      {
        id: "component:s:candidate-selection",
        type: "Component",
        title: "候補選定ロジック (candidate 5 通りから選ぶ)",
        summary: "ユーザー入力から候補を絞り込む",
      },
    ],
    edges: [{ id: "e1", type: "contains", from: "system:s", to: "layer:s:foundation" }],
  };
  const { out } = runCheck(graph);
  assert.doesNotMatch(out, /candidate-uncarved/, "意味命名済みなら candidate-uncarved は出ない");
  assert.doesNotMatch(out, /placeholder-title/, "意味命名 (candidate という語を含むが連番でない) を誤爆しない");
});

// ───────────────────────── C3/C1/B2' 追加分 ─────────────────────────

function fileNode(p: string, role: string) {
  return { id: `file:${p}`, type: "File", path: p, role, title: p, summary: `${p} の要約` };
}

/** Component 1 個 + メンバー File 群 + orphan File 群の最小 graph。 */
function graphWithPocket(memberFiles: any[], orphanFiles: any[], extraNodes: any[] = []) {
  const pocket = { id: "component:s:core", type: "Component", title: "中核ロジック", summary: "中核" };
  return {
    nodes: [pocket, ...memberFiles, ...orphanFiles, ...extraNodes],
    edges: memberFiles.map((f, i) => ({ id: `ev${i}`, type: "evidenced_by", from: pocket.id, to: f.id })),
  };
}

// 回帰 (silent pass 防止): 旧実装は role ∈ {source,test,config} だけを component-coverage の
// 対象にしていたため、roleFor の判定が ui_component / api_route / entrypoint に変わると
// orphan が 0 件に化けて黙って通った。これらの role でも Pocket 未所属は ERROR であることを固定。
test("carving-check: ui_component / api_route / entrypoint role の Pocket 未所属は ERROR (silent pass 回帰)", () => {
  for (const f of [
    fileNode("src/pages/ChatPage.tsx", "ui_component"),
    fileNode("src/api/users.ts", "api_route"),
    fileNode("src/cli/run.ts", "entrypoint"),
  ]) {
    const { code, out } = runCheck(graphWithPocket([fileNode("src/core/a.ts", "source")], [f]));
    assert.equal(code, 1, `${f.path} (${f.role}) が orphan なら exit 1 のはず`);
    assert.match(out, /component-coverage/, `${f.path} で component-coverage が発火すべき`);
    assert.ok(out.includes(f.path), `${f.path} が details に出るべき`);
  }
});

test("carving-check: documentation / generated role は role だけで免除 (会計に role: 根拠で出る)", () => {
  const g = graphWithPocket(
    [fileNode("src/core/a.ts", "source")],
    [fileNode("docs/guide.md", "documentation"), fileNode("gen/api.ts", "generated")]
  );
  const { code, out } = runCheck(g);
  assert.equal(code, 0);
  assert.doesNotMatch(out, /component-coverage/);
  assert.match(out, /role:documentation/);
  assert.match(out, /role:generated/);
});

// builtin から削除した特定プロジェクト出自パターンはもう免除されない
test("carving-check: 旧 builtin パターン (utf8.bat / plans html / winsw 等) は免除されず ERROR", () => {
  const g = graphWithPocket(
    [fileNode("src/core/a.ts", "source")],
    [
      fileNode("build-all.utf8.bat", "source"),
      fileNode("plans/old-handover.html", "source"),
      fileNode("app/winsw/service.xml", "config"),
      fileNode("app/ui/index.css", "source"),
    ]
  );
  const { code, out } = runCheck(g);
  assert.equal(code, 1);
  assert.match(out, /component-coverage/);
  for (const p of ["build-all.utf8.bat", "plans/old-handover.html", "app/winsw/service.xml", "app/ui/index.css"]) {
    assert.ok(out.includes(p), `${p} は orphan として列挙されるべき`);
  }
});

test("carving-check: carving.json の literal path 免除で orphan が消え、会計に config 由来が出る", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  mkdirSync(path.join(dir, ".graphrag"));
  writeFileSync(path.join(dir, ".graphrag", "carving.json"), JSON.stringify({
    allowed_orphans: [{ path: "tools/build.bat", reason: "ビルド入口で Pocket でない", added: "2026-06-11" }],
  }));
  const g = graphWithPocket(
    [fileNode("src/core/a.ts", "source"), fileNode("src/core/b.ts", "source")],
    [fileNode("tools/build.bat", "source")]
  );
  const { code, out } = runCheckIn(dir, g);
  assert.equal(code, 0, `config 免除済みなので ERROR なし: ${out}`);
  assert.doesNotMatch(out, /component-coverage/);
  assert.match(out, /config:tools\/build\.bat/, "免除会計に config 根拠が出る");
  assert.match(out, /config 由来 1件/);
  // 1/3 = 33% > 15% なので比率 WARN も出る
  assert.match(out, /exemption-ratio-high/);
});

test("carving-check: --config 明示指定でも config 免除が効く", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  const cp = path.join(dir, "my-carving.json");
  writeFileSync(cp, JSON.stringify({
    allowed_orphans: [{ path: "tools/build.bat", reason: "r", added: "2026-06-11" }],
  }));
  const g = graphWithPocket([fileNode("src/core/a.ts", "source")], [fileNode("tools/build.bat", "source")]);
  const { out } = runCheck(g, ["--config", cp]);
  assert.doesNotMatch(out, /component-coverage/);
  assert.match(out, /config:tools\/build\.bat/);
});

test("carving-check: graph に無い path の config エントリは stale-exemption ERROR", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  mkdirSync(path.join(dir, ".graphrag"));
  writeFileSync(path.join(dir, ".graphrag", "carving.json"), JSON.stringify({
    allowed_orphans: [{ path: "gone/forever.ts", reason: "r", added: "2026-06-11" }],
  }));
  const { code, out } = runCheckIn(dir, graphWithPocket([fileNode("src/core/a.ts", "source")], []));
  assert.equal(code, 1);
  assert.match(out, /carving-config-stale/);
  assert.ok(out.includes("gone/forever.ts"));
});

test("carving-check: glob 文字や reason/added 欠落の config エントリは carving-config-invalid ERROR", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  mkdirSync(path.join(dir, ".graphrag"));
  writeFileSync(path.join(dir, ".graphrag", "carving.json"), JSON.stringify({
    allowed_orphans: [{ path: "plans/*.html", added: "2026-06-11" }],
  }));
  const { code, out } = runCheckIn(dir, graphWithPocket([fileNode("src/core/a.ts", "source")], []));
  assert.equal(code, 1);
  assert.match(out, /carving-config-invalid/);
  assert.match(out, /glob/);
  assert.match(out, /reason 必須/);
});

test("carving-check: builtin と重複する config エントリは WARN", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  mkdirSync(path.join(dir, ".graphrag"));
  writeFileSync(path.join(dir, ".graphrag", "carving.json"), JSON.stringify({
    allowed_orphans: [{ path: "apps/web/package.json", reason: "manifest", added: "2026-06-11" }],
  }));
  const g = graphWithPocket(
    [fileNode("src/core/a.ts", "source")],
    [fileNode("apps/web/package.json", "config")]
  );
  const { code, out } = runCheckIn(dir, g);
  assert.equal(code, 0);
  assert.match(out, /config-duplicates-builtin/);
  assert.match(out, /builtin:package-manifest/);
});

test("carving-check: 免除会計は免除ゼロでも常時印字、--json では accounting に入る", () => {
  const g = graphWithPocket([fileNode("src/core/a.ts", "source")], []);
  const text = runCheck(g);
  assert.match(text.out, /免除会計/);
  assert.match(text.out, /role 別 File 数: source:1/);
  const json = runCheck(g, ["--json"]);
  const parsed = JSON.parse(json.out);
  assert.deepEqual(parsed.accounting.roles, { source: 1 });
  assert.equal(parsed.accounting.impl_file_total, 1);
  assert.deepEqual(parsed.accounting.exemptions, []);
  assert.equal(parsed.accounting.exempt_ratio, 0);
});

// C1: 知識軸の床
test("carving-check: Goal / Constraint が 0 件なら knowledge-floor WARN、居れば出ない", () => {
  const bare = graphWithPocket([fileNode("src/core/a.ts", "source")], []);
  const { out } = runCheck(bare);
  assert.match(out, /knowledge-floor-goal-missing/);
  assert.match(out, /knowledge-floor-constraint-missing/);
  assert.match(out, /知識軸シーディング/);

  const seeded = graphWithPocket([fileNode("src/core/a.ts", "source")], [], [
    { id: "goal:s:v1", type: "Goal", title: "v1 を出す", summary: "g" },
    { id: "constraint:s:offline", type: "Constraint", title: "オフライン動作必須", summary: "c" },
  ]);
  const r2 = runCheck(seeded);
  assert.doesNotMatch(r2.out, /knowledge-floor-goal-missing/);
  assert.doesNotMatch(r2.out, /knowledge-floor-constraint-missing/);
});

// B2': 死んだ前提
test("carving-check: 現役ノードが終端 state のノードへ has_premise していたら WARN", () => {
  const graph = {
    nodes: [
      { id: "decision:s:new", type: "Decision", title: "新方針", summary: "d" },
      { id: "decision:s:old", type: "Decision", title: "旧方針", summary: "d", state: "superseded" },
      { id: "goal:s:v1", type: "Goal", title: "g", summary: "g" },
      { id: "constraint:s:c", type: "Constraint", title: "c", summary: "c" },
    ],
    edges: [
      { id: "p1", type: "has_premise", from: "decision:s:new", to: "decision:s:old" },
    ],
  };
  const { out } = runCheck(graph);
  assert.match(out, /superseded-premise/);
  assert.ok(out.includes("decision:s:new -has_premise-> decision:s:old"));
});

// ───────────────────────── 新規ゲート (#9拡張 / knowledge-description-missing) ─────────────────────────

// constraint-binding-missing: constrains エッジが 0 本の Constraint は WARN
test("carving-check: constrains エッジが 0 本の Constraint は constraint-binding-missing WARN", () => {
  const graph = {
    nodes: [
      { id: "goal:s:v1", type: "Goal", title: "g", summary: "g" },
      { id: "constraint:s:offline", type: "Constraint", title: "オフライン動作必須", summary: "c" },
      // bind 無し: constrains エッジが出ていない
      { id: "constraint:s:unbound", type: "Constraint", title: "未紐付け制約", summary: "c" },
    ],
    edges: [
      // constraint:s:offline は constrains エッジを持つ → WARN 対象外
      { id: "e1", type: "constrains", from: "constraint:s:offline", to: "goal:s:v1" },
    ],
  };
  const { out } = runCheck(graph);
  assert.match(out, /constraint-binding-missing/);
  assert.ok(out.includes("unbound"), "未紐付け制約が details に出る");
  // constraint-binding-missing の details 行 ("    - " で始まる行) だけを抽出して offline が無いことを確認
  const lines = out.split("\n");
  const ruleIdx = lines.findIndex(l => l.includes("[WARN] constraint-binding-missing"));
  const detailLines: string[] = [];
  for (let i = ruleIdx + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("    - ")) detailLines.push(lines[i]);
    else if (lines[i].trim() === "" || /^\[/.test(lines[i].trim())) break;
  }
  assert.ok(!detailLines.some(l => l.includes("offline")), "constrains 済みの offline は constraint-binding-missing の details に出ない");
});

test("carving-check: Constraint が全て constrains エッジを持つなら constraint-binding-missing は出ない", () => {
  const graph = {
    nodes: [
      { id: "decision:s:d1", type: "Decision", title: "d", summary: "d" },
      { id: "goal:s:v1", type: "Goal", title: "g", summary: "g" },
      { id: "constraint:s:c1", type: "Constraint", title: "c1", summary: "c" },
      { id: "constraint:s:c2", type: "Constraint", title: "c2", summary: "c" },
    ],
    edges: [
      { id: "e1", type: "constrains", from: "constraint:s:c1", to: "decision:s:d1" },
      { id: "e2", type: "constrains", from: "constraint:s:c2", to: "decision:s:d1" },
    ],
  };
  const { out } = runCheck(graph);
  assert.doesNotMatch(out, /constraint-binding-missing/);
});

test("carving-check: Constraint が 0 件なら constraint-binding-missing は出ない", () => {
  // knowledge-floor-constraint-missing は出るが、constraint-binding-missing は出ない
  const graph = {
    nodes: [
      { id: "goal:s:v1", type: "Goal", title: "g", summary: "g" },
    ],
    edges: [],
  };
  const { out } = runCheck(graph);
  assert.doesNotMatch(out, /constraint-binding-missing/);
  // knowledge-floor は出るが確認しない (別テストのスコープ)
});

// knowledge-description-missing: 知識 6 型で description 欠落は WARN
test("carving-check: 知識 6 型で description 欠落は knowledge-description-missing WARN", () => {
  const graph = {
    nodes: [
      // description あり → WARN 対象外
      { id: "decision:s:with-desc", type: "Decision", title: "d", summary: "s", description: "詳細な記述" },
      // description なし → 全型 WARN 対象
      { id: "decision:s:no-desc", type: "Decision", title: "決定なし", summary: "s" },
      { id: "risk:s:no-desc", type: "Risk", title: "リスクなし", summary: "s" },
      { id: "constraint:s:no-desc", type: "Constraint", title: "制約なし", summary: "s",
        // constrains エッジを持たせて constraint-binding-missing と独立に確認
      },
      { id: "goal:s:no-desc", type: "Goal", title: "ゴールなし", summary: "s" },
      { id: "ok:s:no-desc", type: "OperationalKnowledge", title: "OKなし", summary: "s" },
      { id: "rejected:s:no-desc", type: "RejectedOption", title: "却下案なし", summary: "s" },
    ],
    edges: [
      // Constraint に constrains エッジを繋いで constraint-binding-missing を抑制
      { id: "e1", type: "constrains", from: "constraint:s:no-desc", to: "decision:s:with-desc" },
    ],
  };
  const { out } = runCheck(graph);
  assert.match(out, /knowledge-description-missing/);
  // description 無し 5 件 + RejectedOption 1 件 = 6 件が対象 (Decision:no-desc/Risk/Goal/OK/Rejected)
  assert.ok(out.includes("no-desc"), "欠落ノードが details に出る");
  // description あり (with-desc) は含まれないこと
  assert.ok(!out.split("\n").some(l => l.includes("with-desc") && l.includes("description")),
    "description ありは列挙されない");
});

test("carving-check: 知識 6 型が全て description を持てば knowledge-description-missing は出ない", () => {
  const desc = "十分な記述";
  const graph = {
    nodes: [
      { id: "decision:s:d1", type: "Decision", title: "d", summary: "s", description: desc },
      { id: "risk:s:r1", type: "Risk", title: "r", summary: "s", description: desc },
      { id: "constraint:s:c1", type: "Constraint", title: "c", summary: "s", description: desc },
      { id: "goal:s:g1", type: "Goal", title: "g", summary: "s", description: desc },
      { id: "ok:s:o1", type: "OperationalKnowledge", title: "o", summary: "s", description: desc },
      { id: "rejected:s:ro1", type: "RejectedOption", title: "ro", summary: "s", description: desc },
    ],
    edges: [
      { id: "e1", type: "constrains", from: "constraint:s:c1", to: "decision:s:d1" },
    ],
  };
  const { out } = runCheck(graph);
  assert.doesNotMatch(out, /knowledge-description-missing/);
});

test("carving-check: description が空文字列は knowledge-description-missing WARN に含まれる", () => {
  const graph = {
    nodes: [
      { id: "decision:s:empty", type: "Decision", title: "空文字", summary: "s", description: "" },
      { id: "goal:s:v1", type: "Goal", title: "g", summary: "s", description: "ok" },
      { id: "constraint:s:c1", type: "Constraint", title: "c", summary: "s", description: "ok" },
    ],
    edges: [
      { id: "e1", type: "constrains", from: "constraint:s:c1", to: "decision:s:empty" },
    ],
  };
  const { out } = runCheck(graph);
  assert.match(out, /knowledge-description-missing/);
  assert.ok(out.includes("empty"), "空文字も欠落として列挙される");
});

test("carving-check: File / Investigation / ConversationChunk は knowledge-description-missing の対象外", () => {
  const graph = {
    nodes: [
      // 対象外の型 — description なしでも WARN しない
      { id: "file:src/a.ts", type: "File", path: "src/a.ts", role: "source", title: "a", summary: "s" },
      { id: "investigation:s:inv1", type: "Investigation", title: "i", summary: "s" },
      { id: "conversation:s:ch1", type: "ConversationChunk", title: "c", summary: "s" },
      // 知識型を 1 件だけ追加 (description あり) して WARN が出ないことを確認
      { id: "goal:s:v1", type: "Goal", title: "g", summary: "s", description: "ok" },
      { id: "constraint:s:c1", type: "Constraint", title: "c", summary: "s", description: "ok" },
    ],
    edges: [
      { id: "e1", type: "constrains", from: "constraint:s:c1", to: "goal:s:v1" },
      // File を Pocket に繋いで component-coverage を避ける
    ],
  };
  const { out } = runCheck(graph);
  assert.doesNotMatch(out, /knowledge-description-missing/);
});

test("carving-check: from 側も終端 state なら superseded-premise は出ない (系譜保存)", () => {
  const graph = {
    nodes: [
      { id: "decision:s:old2", type: "Decision", title: "旧2", summary: "d", state: "superseded" },
      { id: "decision:s:old", type: "Decision", title: "旧", summary: "d", state: "superseded" },
      { id: "ok:s:live", type: "OperationalKnowledge", title: "現役知識", summary: "o" },
      { id: "decision:s:live", type: "Decision", title: "現役", summary: "d" },
      { id: "goal:s:v1", type: "Goal", title: "g", summary: "g" },
      { id: "constraint:s:c", type: "Constraint", title: "c", summary: "c" },
    ],
    edges: [
      // 終端 → 終端: 系譜なので問題ない
      { id: "p1", type: "has_premise", from: "decision:s:old2", to: "decision:s:old" },
      // 現役 → 現役: 問題ない
      { id: "p2", type: "has_premise", from: "ok:s:live", to: "decision:s:live" },
    ],
  };
  const { out } = runCheck(graph);
  assert.doesNotMatch(out, /superseded-premise/);
});

test("carving-check: temporary_relation_candidate 残存を WARN にする", () => {
  const graph = {
    nodes: [
      { id: "decision:s:a", type: "Decision", title: "A", summary: "a" },
      { id: "decision:s:b", type: "Decision", title: "B", summary: "b" },
      { id: "risk:s:c", type: "Risk", title: "C", summary: "c" },
    ],
    edges: [
      { id: "t1", type: "temporary_relation_candidate", from: "decision:s:a", to: "decision:s:b" },
      { id: "t2", type: "temporary_relation_candidate", from: "decision:s:a", to: "risk:s:c" },
    ],
  };
  const { out } = runCheck(graph);
  assert.match(out, /temporary-relation-remaining/);
  assert.match(out, /2 本残存/);
});

test("carving-check: temporary_relation_candidate が無ければ WARN は出ない", () => {
  const graph = {
    nodes: [
      { id: "decision:s:a", type: "Decision", title: "A", summary: "a" },
      { id: "decision:s:b", type: "Decision", title: "B", summary: "b" },
    ],
    edges: [
      { id: "e1", type: "refines", from: "decision:s:a", to: "decision:s:b" },
    ],
  };
  const { out } = runCheck(graph);
  assert.doesNotMatch(out, /temporary-relation-remaining/);
});

// ── summary_provisional の免除会計 (builtin-orphan / role 閉集合は ERROR にしない) ──

test("carving-check: summary_provisional はソース File で ERROR、builtin-orphan/role 免除は INFO 別勘定", () => {
  const graph = {
    nodes: [
      // ERROR 対象: 実装ソース (Component 未所属の component-coverage ERROR も出るが本題ではない)
      { ...fileNode("src/core.ts", "source"), summary_provisional: true },
      // 免除 (builtin): lockfile はそもそも embedding から除外され意味要約を強制しない
      { ...fileNode("pnpm-lock.yaml", "config"), summary_provisional: true },
      // 免除 (role 閉集合): documentation
      { ...fileNode("docs/readme.md", "documentation"), summary_provisional: true },
    ],
    edges: [],
  };
  const { out } = runCheck(graph);
  assert.match(out, /\[ERROR\] summary-provisional/, "ソース File は従来どおり ERROR");
  assert.match(out, /summary-provisional-exempt/, "免除分は INFO で別勘定");
  // ERROR 側の details に免除 File が混ざらない (ERROR は 1 件のみ)
  assert.match(out, /summary_provisional\): 1件 \[File:1\]/);
  assert.match(out, /免除対象.*: 2件/);
});

test("carving-check: summary_provisional が免除 File のみなら ERROR ゼロ (exit 0)", () => {
  const pocket = { id: "component:s:core", type: "Component", title: "中核", summary: "core" };
  const impl = fileNode("src/impl.ts", "source"); // Component 所属でカバレッジ ERROR を防ぐ
  const graph = {
    nodes: [
      pocket,
      impl,
      { ...fileNode("pnpm-lock.yaml", "config"), summary_provisional: true },
    ],
    edges: [{ id: "ev0", type: "evidenced_by", from: pocket.id, to: impl.id }],
  };
  const { code, out } = runCheck(graph);
  assert.equal(code, 0, "免除 File の provisional だけでは fail しない");
  assert.doesNotMatch(out, /\[ERROR\] summary-provisional/);
  assert.match(out, /summary-provisional-exempt/);
});

test("carving-check: Component/Layer 候補の summary_provisional は従来どおり ERROR", () => {
  const graph = {
    nodes: [
      { id: "layer:s:found", type: "Layer", title: "基盤層", summary: "x", summary_provisional: true },
    ],
    edges: [],
  };
  const { code, out } = runCheck(graph);
  assert.equal(code, 1);
  assert.match(out, /\[ERROR\] summary-provisional/);
  assert.match(out, /Layer:1/);
});

// ── superseded-no-successor (置き換え宣言の片肺検出) ─────────────────────────

test("carving-check: state:superseded で後継からの refines が無ければ WARN", () => {
  const graph = {
    nodes: [
      { id: "decision:s:old", type: "Decision", title: "旧方針", summary: "d", state: "superseded" },
    ],
    edges: [],
  };
  const { out } = runCheck(graph);
  assert.match(out, /superseded-no-successor/);
});

test("carving-check: superseded でも後継からの refines があれば superseded-no-successor は出ない", () => {
  const graph = {
    nodes: [
      { id: "decision:s:old", type: "Decision", title: "旧方針", summary: "d", state: "superseded" },
      { id: "decision:s:new", type: "Decision", title: "新方針", summary: "d" },
    ],
    edges: [
      { id: "r1", type: "refines", from: "decision:s:new", to: "decision:s:old" },
    ],
  };
  const { out } = runCheck(graph);
  assert.doesNotMatch(out, /superseded-no-successor/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import { deltaCheck, parseUnifiedAddedLines, isEchoAlias, type DeltaCheckDeps } from "./delta-check.ts";
import { scanMarkersInContent, verifyMarkerRefs } from "./markers.ts";

function writeVaultFromGraph(graph: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "grag-delta-vault-"));
  for (const f of buildVaultFiles(graph as any)) {
    const abs = path.join(dir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return dir;
}

// upload パイプラインの周辺: Constraint / OK / superseded Decision がファイルに配線済み。
const GRAPH = {
  nodes: [
    { id: "file:s:src/upload/pack.ts", type: "File", title: "pack", path: "src/upload/pack.ts", summary: "s" },
    { id: "file:s:src/upload/send.ts", type: "File", title: "send", path: "src/upload/send.ts", summary: "s" },
    { id: "file:s:src/ui/table.tsx", type: "File", title: "table", path: "src/ui/table.tsx", summary: "s" },
    {
      id: "constraint:s:single-authority",
      type: "Constraint",
      title: "状態集合の権威は constants のみ",
      summary: "状態リテラル集合を UI 側で再実装しない",
    },
    {
      id: "ok:s:bundle-missing",
      type: "OperationalKnowledge",
      title: "アセットの MSI 同梱漏れは hotdeploy が隠す",
      summary: "パッケージング定義と実行時参照の突合を怠ると開発機では見えない",
    },
    {
      id: "decision:s:old-policy",
      type: "Decision",
      title: "旧アップロード方針",
      summary: "旧: 直列アップロード",
      state: "superseded",
    },
    { id: "decision:s:new-policy", type: "Decision", title: "新アップロード方針", summary: "新: 並列" },
    { id: "component:s:upload", type: "Component", title: "アップロード", summary: "s" }
  ],
  edges: [
    { id: "e1", type: "constrains", from: "constraint:s:single-authority", to: "file:s:src/ui/table.tsx" },
    { id: "e2", type: "documented_by", from: "ok:s:bundle-missing", to: "file:s:src/upload/pack.ts" },
    { id: "e3", type: "documented_by", from: "ok:s:bundle-missing", to: "file:s:src/upload/send.ts" },
    { id: "e4", type: "sets_policy_for", from: "decision:s:old-policy", to: "file:s:src/upload/send.ts" },
    { id: "e5", type: "refines", from: "decision:s:new-policy", to: "decision:s:old-policy" },
    { id: "e6", type: "evidenced_by", from: "component:s:upload", to: "file:s:src/upload/pack.ts" },
    { id: "e7", type: "evidenced_by", from: "component:s:upload", to: "file:s:src/upload/send.ts" }
  ]
};

function run(paths: string[], graph: Record<string, unknown> = GRAPH, deps: DeltaCheckDeps = {}) {
  const vault = writeVaultFromGraph(graph);
  return {
    vault,
    result: deltaCheck(
      { vaultDir: vault, root: "/repo", paths, inputSource: "files" },
      { gitLsDir: () => [], fileExists: () => false, ...deps }
    )
  };
}

test("connected_knowledge: 変更ファイルに繋がる知識だけを、型優先度順・via 集約で返す", () => {
  const { result } = run(["src/upload/pack.ts", "src/upload/send.ts", "src/ui/table.tsx"]);
  assert.equal(result.status, "info");
  const ids = result.connected_knowledge.map((k) => k.id);
  // 型優先度 (Constraint → Decision → OK)。OK は2ファイル分が1ノードに集約、superseded も出る。
  assert.deepEqual(ids, ["constraint:s:single-authority", "decision:s:old-policy", "ok:s:bundle-missing"]);
  const ok = result.connected_knowledge[2];
  assert.equal(ok.via.length, 2, "同一ノードの複数エッジは via に集約 (ノードは1回だけ)");
  const old = result.connected_knowledge[1];
  assert.equal(old.state, "superseded", "superseded も隠さず state 付きで見せる");
  assert.match(result.summary, /3 knowledge node/);
});

test("clean 契約: 何も繋がらない diff は summary 1行 + 空 findings (status=clean)", () => {
  const { result } = run(["src/unrelated/a.ts"]);
  assert.equal(result.status, "clean");
  assert.match(result.summary, /^clean — no registered knowledge is wired/);
  assert.equal(result.connected_knowledge.length, 0);
  assert.equal(result.marker_findings.length, 0);
  assert.equal(result.counts.inputs, 1);
});

test("marker_findings: broken / superseded を検出し、健在マーカーは無音", () => {
  const files: Record<string, string> = {
    "src/upload/send.ts": [
      "// graphrag:see decision:s:old-policy",
      "// graphrag:see decision:s:new-policy",
      "// graphrag:see decision:s:never-existed",
      "export const x = 1;"
    ].join("\n")
  };
  const { result } = run(["src/upload/send.ts"], GRAPH, {
    fileExists: (_root, rel) => rel in files,
    readFile: (_root, rel) => files[rel]
  });
  assert.equal(result.status, "warn");
  const kinds = result.marker_findings.map((f) => [f.kind, f.target_id]);
  assert.deepEqual(
    kinds.sort(),
    [
      ["marker-broken-ref", "decision:s:never-existed"],
      ["marker-superseded-ref", "decision:s:old-policy"]
    ].sort(),
    "new-policy (健在) には finding を出さない"
  );
  const sup = result.marker_findings.find((f) => f.kind === "marker-superseded-ref")!;
  assert.match(sup.detail, /decision:s:new-policy/, "refines 逆辿りで後継を案内する");
  assert.equal(sup.line, 1);
});

test("marker_findings: 削除済みノードは台帳を引いて 301 successor を案内する", () => {
  const files: Record<string, string> = {
    "src/upload/pack.ts": "// graphrag:enforces constraint:s:deleted-one\n"
  };
  const { vault, result } = (() => {
    const vault = writeVaultFromGraph(GRAPH);
    const shard = path.join(vault, ".tombstones");
    mkdirSync(shard, { recursive: true });
    writeFileSync(
      path.join(shard, "2026-07.jsonl"),
      JSON.stringify({
        id: "constraint:s:deleted-one",
        type: "Constraint",
        deleted_at: "2026-07-01T00:00:00.000Z",
        reason: "merged into single-authority",
        successor: "constraint:s:single-authority"
      }) + "\n"
    );
    const result = deltaCheck(
      { vaultDir: vault, root: "/repo", paths: ["src/upload/pack.ts"], inputSource: "files" },
      {
        gitLsDir: () => [],
        fileExists: (_root, rel) => rel in files,
        readFile: (_root, rel) => files[rel]
      }
    );
    return { vault, result };
  })();
  void vault;
  const f = result.marker_findings.find((x) => x.kind === "marker-tombstoned-ref");
  assert.ok(f, "tombstoned-ref finding が出る");
  assert.match(f!.detail, /replaced by constraint:s:single-authority \(301\)/);
  // 正規表現リテラルでなく文字列比較 — regex 内のマーカー風文字列は stripQuoted で消せず、
  // このファイル自身が delta-check の broken-ref に化けるため (自己言及の回避)。
  assert.ok(f!.next_step.includes("graphrag:enforces " + "constraint:s:single-authority"));
});

test("placement_findings: frame-check の in-footprint-unwired を転載する (entries は載せない)", () => {
  const { result } = run(["src/upload/new-step.ts"]);
  const f = result.placement_findings.find((x) => x.kind === "in-footprint-unwired");
  assert.ok(f, "一意 claimant (component:s:upload) の縄張り内・未配線");
  assert.equal((result as any).entries, undefined, "per-file 地図は delta-check の出力契約に含めない");
  assert.equal(result.status, "warn");
});

test("scanMarkersInContent: 文法 — コメント記法非依存・複数/行・末尾記号を id に含めない", () => {
  const hits = scanMarkersInContent("a.py", [
    "# graphrag:see decision:s:x (see graph)",
    "-- graphrag:enforces constraint:s:y; graphrag:see ok:s:z",
    "plain line"
  ].join("\n"));
  assert.deepEqual(
    hits.map((h) => [h.line, h.marker, h.targetId]),
    [
      [1, "see", "decision:s:x"],
      [2, "enforces", "constraint:s:y"],
      [2, "see", "ok:s:z"]
    ]
  );
});

test("verifyMarkerRefs: ヒットゼロなら台帳を読まない (vault 不在パスでも安全)", () => {
  assert.deepEqual(verifyMarkerRefs([], { nodes: [], edges: [] }, "/nonexistent"), []);
});

test("scanMarkersInContent: 文字列リテラル内の id は実マーカーと誤認しない (テストフィクスチャ耐性)", () => {
  const hits = scanMarkersInContent("x.test.ts", [
    'const fixture = "// graphrag:see decision:s:fixture-only";',
    "const tpl = `graphrag:enforces constraint:s:in-template`;",
    "// graphrag:see decision:s:real-marker",
    'writeFileSync(p, "graphrag:enforces constraint:s:another\\n");'
  ].join("\n"));
  assert.deepEqual(hits.map((h) => h.targetId), ["decision:s:real-marker"]);
});

test("authority_echoes: 権威の語彙が家の外の追加行に現れたら現行犯 (家の中と無関係語は無音)", () => {
  const graph = {
    nodes: [
      { id: "file:s:shared/constants.ts", type: "File", title: "constants", path: "shared/constants.ts", summary: "s" },
      {
        id: "decision:s:error-status-authority", type: "Decision",
        title: "エラー状態集合の権威は ERROR_STATUSES", summary: "UI 側で再実装しない",
        aliases: ["ERROR_STATUSES", "zero_bytes", "エラー状態の権威"]
      }
    ],
    edges: [
      { id: "e1", type: "sets_policy_for", from: "decision:s:error-status-authority", to: "file:s:shared/constants.ts" }
    ]
  };
  const added = new Map([
    ["src/ui/SsdTable.tsx", [
      { line: 479, text: 'const DONE = ["verified", "zero_bytes"];' },
      { line: 480, text: "const total = rows.length;" }
    ]],
    ["shared/constants.ts", [{ line: 104, text: 'export const ERROR_STATUSES = ["zero_bytes"];' }]]
  ]);
  const vault = writeVaultFromGraph(graph);
  const result = deltaCheck(
    { vaultDir: vault, root: "/repo", paths: ["src/ui/SsdTable.tsx", "shared/constants.ts"], inputSource: "worktree" },
    { gitLsDir: () => [], fileExists: () => true, readFile: () => "", gitAddedLines: () => added }
  );
  assert.equal(result.status, "info");
  assert.equal(result.authority_echoes.length, 1, "zero_bytes の家の外での追加のみ (家の中の ERROR_STATUSES は無音)");
  const echo = result.authority_echoes[0];
  assert.equal(echo.alias, "zero_bytes");
  assert.equal(echo.knowledge_id, "decision:s:error-status-authority");
  assert.deepEqual(echo.authority_paths, ["shared/constants.ts"]);
  assert.deepEqual(echo.occurrences, [
    { path: "src/ui/SsdTable.tsx", line: 479, text: 'const DONE = ["verified", "zero_bytes"];' }
  ]);
  assert.match(result.summary, /1 authority echo/);
});

test("authority_echoes: 識別子境界 — 部分文字列 (zero_bytes_v2) には当てない。日本語 alias も対象外", () => {
  const graph = {
    nodes: [
      { id: "file:s:a.ts", type: "File", title: "a", path: "a.ts", summary: "s" },
      { id: "ok:s:auth", type: "OperationalKnowledge", title: "権威", summary: "s", aliases: ["zero_bytes", "エラー状態の権威"] }
    ],
    edges: [{ id: "e1", type: "documented_by", from: "ok:s:auth", to: "file:s:a.ts" }]
  };
  const added = new Map([
    ["b.ts", [
      { line: 1, text: "const x = zero_bytes_v2;" },
      { line: 2, text: "// エラー状態の権威 をここにも書く" }
    ]]
  ]);
  const vault = writeVaultFromGraph(graph);
  const result = deltaCheck(
    { vaultDir: vault, root: "/repo", paths: ["b.ts"], inputSource: "worktree" },
    { gitLsDir: () => [], fileExists: () => true, readFile: () => "", gitAddedLines: () => added }
  );
  assert.equal(result.authority_echoes.length, 0);
});

test("connected_knowledge: documented_by で場所に宿った Goal (planned) が diff で浮上する", () => {
  const graph = {
    nodes: [
      { id: "file:s:src/heartbeat.ts", type: "File", title: "hb", path: "src/heartbeat.ts", summary: "s" },
      {
        id: "goal:s:step2-authority-migration", type: "Goal", state: "planned",
        title: "Step2: completed/errors の全面的な権威委譲", summary: "0c22fe7f の残り — terminalFiles 以外の委譲"
      }
    ],
    edges: [{ id: "e1", type: "documented_by", from: "goal:s:step2-authority-migration", to: "file:s:src/heartbeat.ts" }]
  };
  const vault = writeVaultFromGraph(graph);
  const result = deltaCheck(
    { vaultDir: vault, root: "/repo", paths: ["src/heartbeat.ts"], inputSource: "files" },
    { gitLsDir: () => [], fileExists: () => false }
  );
  const goal = result.connected_knowledge.find((k) => k.id === "goal:s:step2-authority-migration");
  assert.ok(goal, "「あとで」がその場所を触った瞬間に浮上する");
  assert.equal(goal!.state, "planned");
});

test("parseUnifiedAddedLines: hunk ヘッダから新側行番号を辿る", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -10,0 +11,2 @@ ctx",
    "+line eleven",
    "+line twelve",
    "@@ -20 +23 @@",
    "-old",
    "+new twenty-three",
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "-removed"
  ].join("\n");
  const m = parseUnifiedAddedLines(diff);
  assert.deepEqual(m.get("x.ts"), [
    { line: 11, text: "line eleven" },
    { line: 12, text: "line twelve" },
    { line: 23, text: "new twenty-three" }
  ]);
  assert.equal(m.has("gone.ts"), false, "削除ファイルの新側は /dev/null — 追加行なし");
});

test("isEchoAlias: 単一の全小文字英単語は指紋にならない (固有識別子のみ)", () => {
  assert.equal(isEchoAlias("migration"), false);
  assert.equal(isEchoAlias("footprint"), false);
  assert.equal(isEchoAlias("see"), false, "短すぎるものも対象外");
  assert.equal(isEchoAlias("ERROR_STATUSES"), true);
  assert.equal(isEchoAlias("zero_bytes"), true);
  assert.equal(isEchoAlias("decideAutoUnmount"), true);
  assert.equal(isEchoAlias("constraint-check"), true);
  assert.equal(isEchoAlias("エラー状態の権威"), false, "自然文 alias は対象外");
});

test("authority_echoes: import/依存宣言らしき追加行は除外 — 正当利用で鳴らさない", () => {
  const graph = {
    nodes: [
      { id: "file:s:shared/constants.ts", type: "File", title: "c", path: "shared/constants.ts", summary: "s" },
      { id: "decision:s:auth", type: "Decision", title: "権威", summary: "s", aliases: ["zero_bytes"] }
    ],
    edges: [{ id: "e1", type: "sets_policy_for", from: "decision:s:auth", to: "file:s:shared/constants.ts" }]
  };
  const added = new Map([
    ["src/ui/table.tsx", [
      { line: 1, text: 'import { zero_bytes } from "../shared/constants";' },
      { line: 2, text: "const { zero_bytes: zb } = require('../shared/constants');" },
      { line: 9, text: 'const DONE = ["zero_bytes"];' }
    ]]
  ]);
  const vault = writeVaultFromGraph(graph);
  const result = deltaCheck(
    { vaultDir: vault, root: "/repo", paths: ["src/ui/table.tsx"], inputSource: "worktree" },
    { gitLsDir: () => [], fileExists: () => true, readFile: () => "", gitAddedLines: () => added }
  );
  assert.equal(result.authority_echoes.length, 1);
  assert.deepEqual(result.authority_echoes[0].occurrences.map((o) => o.line), [9],
    "import/require 行は除外され、リテラル再実装の行だけが残る");
});

test("--full 相当 (options.full): connected の cap が外れる", () => {
  const nodes: any[] = [{ id: "file:s:a.ts", type: "File", title: "a", path: "a.ts", summary: "s" }];
  const edges: any[] = [];
  for (let i = 0; i < 25; i++) {
    nodes.push({ id: `decision:s:d${String(i).padStart(2, "0")}`, type: "Decision", title: `d${i}`, summary: "s" });
    edges.push({ id: `e${i}`, type: "documented_by", from: `decision:s:d${String(i).padStart(2, "0")}`, to: "file:s:a.ts" });
  }
  const vault = writeVaultFromGraph({ nodes, edges });
  const capped = deltaCheck(
    { vaultDir: vault, root: "/repo", paths: ["a.ts"], inputSource: "files" },
    { gitLsDir: () => [], fileExists: () => false }
  );
  const full = deltaCheck(
    { vaultDir: vault, root: "/repo", paths: ["a.ts"], inputSource: "files", full: true },
    { gitLsDir: () => [], fileExists: () => false }
  );
  assert.equal(capped.connected_knowledge.length, 20, "既定 cap 20");
  assert.equal(capped.counts.connected_overflow, 5);
  assert.equal(full.connected_knowledge.length, 25, "--full で全量");
  assert.equal(full.counts.connected_overflow, 0);
});

test("scanMarkersInContent: 縮約 (don't/it's) がマーカーを飲み込まず、Python 接頭辞文字列 (f'…') は潰す", () => {
  const hits = scanMarkersInContent("a.py", [
    "# don't forget — graphrag:see decision:s:kept it's load-bearing",
    "x = f'graphrag:see decision:s:in-fstring'",
    "y = rb'graphrag:enforces constraint:s:in-bytes'"
  ].join("\n"));
  assert.deepEqual(hits.map((h) => h.targetId), ["decision:s:kept"],
    "縮約アポストロフィは文字列開始と誤認しない / f-string・bytes リテラル内は無視");
});

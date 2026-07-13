import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import { constraintCheck, ENFORCES_MARKER_RE, type ConstraintCheckDeps, type MarkerHit } from "./constraint-check.ts";

// 合成 graph → 本物の vault ファイルに書いてから読む (staleness-check.test と同じ経路忠実主義)。
function writeVaultFromGraph(graph: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "grag-constraint-vault-"));
  for (const f of buildVaultFiles(graph as any)) {
    const abs = path.join(dir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return dir;
}

// 合成 repo: 実在ファイル集合と内容を DI で固定 (ディスク・git 不要)。
function fakeRepo(files: Record<string, string>, markers: MarkerHit[] = []): ConstraintCheckDeps {
  return {
    fileExists: (_root, rel) => rel in files,
    readFile: (_root, rel) => {
      if (!(rel in files)) throw new Error(`ENOENT: ${rel}`);
      return files[rel];
    },
    grepMarkers: () => markers
  };
}

// マーカー文字列は実行時に組み立てる: ソースリテラルに `graphrag:enforces <有効id>` を置くと、
// この repo 自身の constraint-check (defaultGrepMarkers の git grep) がテストフィクスチャを
// 実マーカーとして拾い、恒久的な orphan-marker ノイズになる (${""} でトークンと id を分断)。
const marker = (id: string) => `// graphrag:enforces ${""}${id}`;
const MARKER = marker("constraint:sys:no-sync-io");

function baseGraph(extraNodes: any[] = [], extraEdges: any[] = []) {
  return {
    nodes: [
      { id: "file:sys:src/pay.ts", type: "File", title: "pay", path: "src/pay.ts", summary: "決済" },
      { id: "file:sys:test/pay-io.test.ts", type: "File", title: "pay-io.test", path: "test/pay-io.test.ts", summary: "検査" },
      { id: "constraint:sys:no-sync-io", type: "Constraint", title: "決済経路で同期 IO 禁止", summary: "要約" },
      ...extraNodes
    ],
    edges: [
      { id: "e-c1", type: "constrains", from: "constraint:sys:no-sync-io", to: "file:sys:src/pay.ts" },
      { id: "e-e1", type: "enforced_by", from: "constraint:sys:no-sync-io", to: "file:sys:test/pay-io.test.ts" },
      ...extraEdges
    ]
  };
}

test("配線が健全 (enforcer 実在 + マーカー有り) なら status ok / findings 空", () => {
  const vault = writeVaultFromGraph(baseGraph());
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo(
      { "test/pay-io.test.ts": `${MARKER}\ntest("sync io", () => {});\n` },
      [{ path: "test/pay-io.test.ts", line: 1, constraintId: "constraint:sys:no-sync-io" }]
    )
  );
  assert.equal(res.status, "ok");
  assert.equal(res.findings.length, 0);
  assert.deepEqual(res.constraints, { total: 1, enforced: 1, unenforceable: 0, unguarded: 0 });
});

test("unguarded: enforced_by も enforcement:none も無い Constraint は warn + 処方 + plan_fragment", () => {
  const vault = writeVaultFromGraph(
    baseGraph([{ id: "constraint:sys:lonely", type: "Constraint", title: "誰も守らない", summary: "要約" }])
  );
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": `${MARKER}\n` })
  );
  const f = res.findings.find((x) => x.kind === "unguarded");
  assert.ok(f, "unguarded finding が要る");
  assert.equal(f!.severity, "warn");
  assert.equal(f!.constraint_id, "constraint:sys:lonely");
  // 何が駄目か + どうしたら良いかが利用エージェントに分かる (処方の実質検査)
  assert.match(f!.detail, /no mechanical consumer/);
  assert.ok(f!.next_step.includes(`graphrag:enforces ${""}constraint:sys:lonely`), "マーカー追記の処方が要る");
  assert.match(f!.next_step, /--unenforceable|enforcement:"none"/);
  const frag: any = f!.plan_fragment;
  assert.equal(frag.edges[0].type, "enforced_by");
  assert.equal(frag.edges[0].from, "constraint:sys:lonely");
  assert.equal(res.constraints.unguarded, 1);
  assert.equal(res.status, "warn");
});

test("unenforceable (理由付き) は finding にしない / 理由無しは warn", () => {
  const vault = writeVaultFromGraph(
    baseGraph([
      { id: "constraint:sys:gdpr", type: "Constraint", title: "GDPR", summary: "要約", enforcement: "none", enforcement_reason: "法規要件はテストで表現できない" },
      { id: "constraint:sys:mute", type: "Constraint", title: "理由無し", summary: "要約", enforcement: "none" }
    ])
  );
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": `${MARKER}\n` })
  );
  assert.equal(res.constraints.unenforceable, 2);
  assert.ok(!res.findings.some((f) => f.constraint_id === "constraint:sys:gdpr"), "理由付き宣言は黙認");
  const f = res.findings.find((x) => x.kind === "unenforceable-no-reason");
  assert.equal(f?.constraint_id, "constraint:sys:mute");
  assert.match(f!.next_step, /enforcement_reason/);
});

test("enforcer-missing: 宛先検査ファイルがディスクに無ければ error (status も error)", () => {
  const vault = writeVaultFromGraph(baseGraph());
  const res = constraintCheck({ vaultDir: vault, root: "/repo" }, fakeRepo({}));
  const f = res.findings.find((x) => x.kind === "enforcer-missing");
  assert.ok(f);
  assert.equal(f!.severity, "error");
  assert.equal(f!.file_path, "test/pay-io.test.ts");
  assert.match(f!.detail, /does not exist on disk/);
  assert.match(f!.next_step, /re-wire|restore/i);
  assert.equal(res.status, "error");
});

test("enforcer-skipped: skip マーカー (it.skip / @Disabled 等) は warn + 行番号", () => {
  const vault = writeVaultFromGraph(baseGraph());
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": `${MARKER}\nit.skip("sync io guard", () => {});\n` })
  );
  const f = res.findings.find((x) => x.kind === "enforcer-skipped");
  assert.ok(f);
  assert.equal(f!.line, 2);
  assert.match(f!.detail, /it\/test\/describe\.skip/);
  assert.match(f!.next_step, /un-skip|unrelated/i);
});

test("marker-missing: enforcer は実在するがマーカーが無ければ warn (追記すべき行を明示)", () => {
  const vault = writeVaultFromGraph(baseGraph());
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": `test("sync io", () => {});\n` })
  );
  const f = res.findings.find((x) => x.kind === "marker-missing");
  assert.ok(f);
  assert.ok(f!.next_step.includes(`graphrag:enforces ${""}constraint:sys:no-sync-io`));
  assert.match(f!.next_step, /test\/pay-io\.test\.ts/);
});

test("orphan-marker: 実在しない Constraint を指すマーカーは warn / tombstone successor へ 301 案内", () => {
  const vault = writeVaultFromGraph(baseGraph());
  // tombstone 台帳: ghost は no-sync-io に置き換え済み
  const tombDir = path.join(vault, ".tombstones");
  mkdirSync(tombDir, { recursive: true });
  writeFileSync(
    path.join(tombDir, "2026-06.jsonl"),
    JSON.stringify({
      id: "constraint:sys:ghost", type: "Constraint", title: "ghost",
      deleted_at: "2026-06-01T00:00:00.000Z", reason: "統合", successor: "constraint:sys:no-sync-io"
    }) + "\n"
  );
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo(
      { "test/pay-io.test.ts": `${MARKER}\n`, "test/old.test.ts": `${marker("constraint:sys:ghost")}\n` },
      [
        { path: "test/pay-io.test.ts", line: 1, constraintId: "constraint:sys:no-sync-io" },
        { path: "test/old.test.ts", line: 1, constraintId: "constraint:sys:ghost" },
        { path: "test/never.test.ts", line: 3, constraintId: "constraint:sys:never-was" }
      ]
    )
  );
  const ghosts = res.findings.filter((x) => x.kind === "orphan-marker");
  assert.equal(ghosts.length, 2);
  const redirected = ghosts.find((g) => g.constraint_id === "constraint:sys:ghost");
  assert.match(redirected!.detail, /replaced by constraint:sys:no-sync-io/);
  assert.ok(redirected!.next_step.includes(`graphrag:enforces ${""}constraint:sys:no-sync-io`), "successor への 301 案内");
  const neverWas = ghosts.find((g) => g.constraint_id === "constraint:sys:never-was");
  assert.match(neverWas!.next_step, /typo|register|remove/i);
});

test("unregistered-enforcer: マーカーは在るが enforced_by 未登記 → そのまま適用できる plan_fragment", () => {
  const vault = writeVaultFromGraph(
    baseGraph([{ id: "constraint:sys:lonely", type: "Constraint", title: "T", summary: "S" }])
  );
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo(
      { "test/pay-io.test.ts": `${MARKER}\n`, "test/lonely.test.ts": `${marker("constraint:sys:lonely")}\n` },
      [
        { path: "test/pay-io.test.ts", line: 1, constraintId: "constraint:sys:no-sync-io" },
        { path: "test/lonely.test.ts", line: 1, constraintId: "constraint:sys:lonely" }
      ]
    )
  );
  const f = res.findings.find((x) => x.kind === "unregistered-enforcer");
  assert.ok(f);
  assert.equal(f!.constraint_id, "constraint:sys:lonely");
  const frag: any = f!.plan_fragment;
  // File ノードは vault に無いので fragment が create を同梱する (貼るだけで通る)
  assert.equal(frag.nodes[0].type, "File");
  assert.equal(frag.nodes[0].path, "test/lonely.test.ts");
  assert.equal(frag.edges[0].from, "constraint:sys:lonely");
  assert.equal(frag.edges[0].to, "file:sys:test/lonely.test.ts");
  // 登記済みの側 (pay-io) には出ない
  assert.ok(!res.findings.some((x) => x.kind === "unregistered-enforcer" && x.constraint_id === "constraint:sys:no-sync-io"));
});

test("contradictory-enforcement: enforcement:none なのに enforced_by が有れば warn", () => {
  const g = baseGraph();
  (g.nodes[2] as any).enforcement = "none";
  (g.nodes[2] as any).enforcement_reason = "宣言だけ残った";
  const vault = writeVaultFromGraph(g);
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": `${MARKER}\n` })
  );
  const f = res.findings.find((x) => x.kind === "contradictory-enforcement");
  assert.ok(f);
  assert.match(f!.next_step, /Decide which is true/);
});

test("project vault は対象外 (note 明示で ok)", () => {
  const vault = writeVaultFromGraph({ nodes: [], edges: [] });
  const res = constraintCheck({ vaultDir: vault, root: "/repo", schemaId: "project" }, fakeRepo({}));
  assert.equal(res.status, "ok");
  assert.match(res.note, /project vault/);
  assert.equal(res.findings.length, 0);
});

test("マーカー走査不能 (git 無し等) は orphan/unregistered を skip して note で正直に言う", () => {
  const vault = writeVaultFromGraph(baseGraph());
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    {
      fileExists: () => true,
      readFile: () => `${MARKER}\n`,
      grepMarkers: () => { throw new Error("not a git repository"); }
    }
  );
  assert.match(res.note, /Marker reverse-scan unavailable/);
  assert.equal(res.status, "ok");
});

test("enforcementDebt: enforced_by も enforcement:none も無い Constraint だけを数える (ask/inspect 同乗用)", async () => {
  const { enforcementDebt } = await import("./constraint-check.ts");
  const graph = {
    nodes: [
      { id: "constraint:s:wired", type: "Constraint", title: "a" },
      { id: "constraint:s:declared", type: "Constraint", title: "b", enforcement: "none" },
      { id: "constraint:s:naked", type: "Constraint", title: "c" },
      { id: "decision:s:d", type: "Decision", title: "d" },
      { id: "file:s:t.ts", type: "File", path: "t.ts", title: "t" }
    ],
    edges: [{ id: "e1", type: "enforced_by", from: "constraint:s:wired", to: "file:s:t.ts" }]
  };
  assert.deepEqual(enforcementDebt(graph as any), { total: 3, unguarded: 1 });
});

test("ENFORCES_MARKER_RE はコメント記法非依存でマーカーを抜く (プレースホルダは拾わない)", () => {
  const text = [
    MARKER,
    `#graphrag:enforces  ${""}constraint:sys:a_b.c-1`, // # コメント・空白複数も拾う
    "-- graphrag:enforces constraint:<system>:<slug>", // ドキュメントのプレースホルダは対象外
    `graphrag:enforces ${""}risk:sys:not-a-constraint`, // Constraint 以外の型 slug は対象外
    `enforces: ${""}constraint:sys:legacy-form` // 名前空間なしの旧形式は対象外 (v1.21.0 で graphrag: 前置に確定)
  ].join("\n");
  const ids = [...text.matchAll(ENFORCES_MARKER_RE)].map((m) => m[1]);
  assert.deepEqual(ids, ["constraint:sys:no-sync-io", "constraint:sys:a_b.c-1"]);
});

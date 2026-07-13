import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import { frameCheck, type FrameCheckDeps } from "./frame-check.ts";

function writeVaultFromGraph(graph: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "grag-frame-vault-"));
  for (const f of buildVaultFiles(graph as any)) {
    const abs = path.join(dir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return dir;
}

// checkout: src/pay/ に2メンバー。registered.ts は登記済み、known.ts は File ノードのみ (無所属)。
const GRAPH = {
  nodes: [
    { id: "file:s:src/pay/cart.ts", type: "File", title: "cart", path: "src/pay/cart.ts", summary: "s" },
    { id: "file:s:src/pay/tax.ts", type: "File", title: "tax", path: "src/pay/tax.ts", summary: "s" },
    { id: "file:s:src/known.ts", type: "File", title: "known", path: "src/known.ts", summary: "s" },
    { id: "component:s:checkout", type: "Component", title: "決済", summary: "s" }
  ],
  edges: [
    { id: "e1", type: "evidenced_by", from: "component:s:checkout", to: "file:s:src/pay/cart.ts" },
    { id: "e2", type: "evidenced_by", from: "component:s:checkout", to: "file:s:src/pay/tax.ts" }
  ]
};

function check(paths: string[], deps: FrameCheckDeps = {}, threshold = 5) {
  const vault = writeVaultFromGraph(GRAPH);
  return frameCheck(
    { vaultDir: vault, root: "/repo", paths, inputSource: "files", thresholdFiles: threshold },
    { gitLsDir: () => [], ...deps }
  );
}

test("registered / non-impl / 免除 (builtin) は所見を出さず status で記述する", () => {
  const res = check(["src/pay/cart.ts", "docs/readme.md", "src/main.tsx"]);
  const byPath = new Map(res.entries.map((e) => [e.path, e]));
  assert.equal(byPath.get("src/pay/cart.ts")!.status, "registered");
  assert.equal(byPath.get("docs/readme.md")!.status, "non-impl");
  assert.equal(byPath.get("src/main.tsx")!.status, "exempt", "composition root は builtin 免除");
  assert.match(byPath.get("src/main.tsx")!.exempt_reason!, /builtin/);
  assert.equal(res.findings.length, 0);
  assert.equal(res.status, "ok");
});

test("in-footprint-unwired: 一意 claimant の縄張り内の未登記ファイルだけ所見 + 貼れる plan_fragment", () => {
  const res = check(["src/pay/discount.ts", "scripts/new-tool.ts"]);
  const byPath = new Map(res.entries.map((e) => [e.path, e]));
  assert.equal(byPath.get("src/pay/discount.ts")!.status, "unwired");
  assert.equal(byPath.get("scripts/new-tool.ts")!.status, "unclaimed", "claimant 無しは正当な無所属 — 所見なし");

  const f = res.findings.find((x) => x.kind === "in-footprint-unwired");
  assert.ok(f);
  assert.equal(f!.file_path, "src/pay/discount.ts");
  assert.match(f!.detail, /home directory of component:s:checkout/);
  assert.match(f!.next_step, /move the file|carving-allow/);
  const frag: any = f!.plan_fragment;
  assert.equal(frag.nodes[0].path, "src/pay/discount.ts", "File ノード create を同梱 (貼るだけで通る)");
  assert.deepEqual(
    [frag.edges[0].type, frag.edges[0].from, frag.edges[0].to],
    ["evidenced_by", "component:s:checkout", "file:s:src/pay/discount.ts"]
  );
  assert.equal(res.findings.filter((x) => x.kind === "in-footprint-unwired").length, 1, "unclaimed 側には出さない");
});

test("フラット配置 (複数 Component 同居 dir) では unwired を発火させない — 誤発砲より沈黙", () => {
  const flatGraph = {
    nodes: [
      { id: "file:s:lib/a.ts", type: "File", title: "a", path: "lib/a.ts", summary: "s" },
      { id: "file:s:lib/b.ts", type: "File", title: "b", path: "lib/b.ts", summary: "s" },
      { id: "component:s:x", type: "Component", title: "X", summary: "s" },
      { id: "component:s:y", type: "Component", title: "Y", summary: "s" }
    ],
    edges: [
      { id: "e1", type: "evidenced_by", from: "component:s:x", to: "file:s:lib/a.ts" },
      { id: "e2", type: "evidenced_by", from: "component:s:y", to: "file:s:lib/b.ts" }
    ]
  };
  const vault = writeVaultFromGraph(flatGraph);
  const res = frameCheck(
    { vaultDir: vault, root: "/repo", paths: ["lib/new.ts"], inputSource: "files" },
    { gitLsDir: () => [] }
  );
  assert.equal(res.entries[0].status, "unclaimed");
  assert.equal(res.entries[0].claimants.length, 2, "地図としては両候補を列挙する");
  assert.equal(res.findings.length, 0);
});

test("component-candidate: 未登記実装ファイルが閾値を超えた dir は『Component が生まれたがっている』", () => {
  const pile = ["scripts/a.ts", "scripts/b.ts", "scripts/c.ts", "scripts/d.ts", "scripts/e.ts"];
  const res = check(
    ["scripts/a.ts"],
    { gitLsDir: (_root, dir) => (dir === "scripts" ? pile : []) },
    5
  );
  const f = res.findings.find((x) => x.kind === "component-candidate");
  assert.ok(f);
  assert.equal(f!.dir, "scripts");
  assert.match(f!.detail, /5 unregistered implementation files/);
  assert.match(f!.detail, /not a violation/, "悪扱いしない文面");
  assert.match(f!.next_step, /register a Component|carving-allow/);
});

test("component-candidate: 閾値未満なら沈黙 (小さいクラスタは枠を彫らない)", () => {
  const res = check(
    ["scripts/a.ts"],
    { gitLsDir: (_root, dir) => (dir === "scripts" ? ["scripts/a.ts", "scripts/b.ts"] : []) },
    5
  );
  assert.ok(!res.findings.some((x) => x.kind === "component-candidate"));
});

test("carving.json の literal 免除は unregistered 集計からも外れる", () => {
  const vault = writeVaultFromGraph(GRAPH);
  const root = mkdtempSync(path.join(tmpdir(), "grag-frame-root-"));
  mkdirSync(path.join(root, ".graphrag"), { recursive: true });
  writeFileSync(
    path.join(root, ".graphrag", "carving.json"),
    JSON.stringify({ allowed_orphans: [{ path: "scripts/gen.ts", reason: "自動生成の配線" }] })
  );
  const res = frameCheck(
    { vaultDir: vault, root, paths: ["scripts/gen.ts"], inputSource: "files", thresholdFiles: 1 },
    { gitLsDir: () => ["scripts/gen.ts"] }
  );
  assert.equal(res.entries[0].status, "exempt");
  assert.match(res.entries[0].exempt_reason!, /自動生成/);
  assert.ok(!res.findings.some((x) => x.kind === "component-candidate"), "免除は山勘定に入れない");
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildCrosscutIndex, buildAreaMap, claimantsForPath, isImplPath } from "./crosscut-map.ts";

// 2 Component (checkout: src/pay/ に2件 / auth: src/auth/ に2件) + Layer + Concern。
// src/pay/shared.ts は checkout と concern:billing の両方に属する。
const GRAPH = {
  nodes: [
    { id: "file:s:src/pay/cart.ts", type: "File", title: "cart", path: "src/pay/cart.ts" },
    { id: "file:s:src/pay/shared.ts", type: "File", title: "shared", path: "src/pay/shared.ts" },
    { id: "file:s:src/auth/login.ts", type: "File", title: "login", path: "src/auth/login.ts" },
    { id: "file:s:src/auth/token.ts", type: "File", title: "token", path: "src/auth/token.ts" },
    { id: "file:s:src/lonely/one.ts", type: "File", title: "one", path: "src/lonely/one.ts" },
    { id: "component:s:checkout", type: "Component", title: "決済", summary: "s" },
    { id: "component:s:auth", type: "Component", title: "認証", summary: "s" },
    { id: "layer:s:domain", type: "Layer", title: "ドメイン層", summary: "s" },
    { id: "concern:s:billing", type: "Concern", title: "課金", summary: "s" },
    { id: "decision:s:d1", type: "Decision", title: "D1", summary: "s" }
  ],
  edges: [
    { id: "e1", type: "evidenced_by", from: "component:s:checkout", to: "file:s:src/pay/cart.ts" },
    { id: "e2", type: "evidenced_by", from: "component:s:checkout", to: "file:s:src/pay/shared.ts" },
    { id: "e3", type: "evidenced_by", from: "component:s:auth", to: "file:s:src/auth/login.ts" },
    { id: "e4", type: "evidenced_by", from: "component:s:auth", to: "file:s:src/auth/token.ts" },
    { id: "e5", type: "evidenced_by", from: "layer:s:domain", to: "file:s:src/pay/cart.ts" },
    { id: "e6", type: "evidenced_by", from: "concern:s:billing", to: "file:s:src/pay/shared.ts" },
    { id: "e7", type: "documented_by", from: "decision:s:d1", to: "file:s:src/pay/cart.ts" }
  ]
};

test("buildCrosscutIndex: File→所属 と Component 縄張り (dir→数) を逆引きできる", () => {
  const idx = buildCrosscutIndex(GRAPH as any);
  const m = idx.membershipByFileId.get("file:s:src/pay/cart.ts")!.map((r) => r.id).sort();
  assert.deepEqual(m, ["component:s:checkout", "layer:s:domain"]);
  const fp = idx.componentFootprints.get("component:s:checkout")!;
  assert.equal(fp.memberCount, 2);
  assert.equal(fp.dirs.get("src/pay"), 2);
});

test("claimantsForPath: 一意の縄張りは unique、無縁の dir は空", () => {
  const idx = buildCrosscutIndex(GRAPH as any);
  const pay = claimantsForPath(idx, "src/pay/new-tax.ts");
  assert.equal(pay.unique?.id, "component:s:checkout");
  const nowhere = claimantsForPath(idx, "scripts/new.ts");
  assert.equal(nowhere.unique, null);
  assert.equal(nowhere.candidates.length, 0);
});

test("claimantsForPath: フラット配置 (複数 Component が同 dir) では unique を返さない — 誤発砲より沈黙", () => {
  const flat = {
    nodes: [
      { id: "file:s:lib/a.ts", type: "File", title: "a", path: "lib/a.ts" },
      { id: "file:s:lib/b.ts", type: "File", title: "b", path: "lib/b.ts" },
      { id: "component:s:x", type: "Component", title: "X", summary: "s" },
      { id: "component:s:y", type: "Component", title: "Y", summary: "s" }
    ],
    edges: [
      { id: "e1", type: "evidenced_by", from: "component:s:x", to: "file:s:lib/a.ts" },
      { id: "e2", type: "evidenced_by", from: "component:s:y", to: "file:s:lib/b.ts" }
    ]
  };
  const idx = buildCrosscutIndex(flat as any);
  const r = claimantsForPath(idx, "lib/new.ts");
  assert.equal(r.unique, null);
  assert.equal(r.candidates.length, 2, "地図としては両方列挙する");
});

test("buildAreaMap: ヒットした File と知識ノードの所在 File から領域の構造を集計する", () => {
  // scope: Decision d1 (documented_by → cart.ts) + File shared.ts
  const map = buildAreaMap(GRAPH as any, ["decision:s:d1", "file:s:src/pay/shared.ts"]);
  const ids = map.crosscuts.map((c) => c.id);
  assert.ok(ids.includes("component:s:checkout"), "cart+shared 経由で checkout が領域に出る");
  assert.ok(ids.includes("layer:s:domain"));
  assert.ok(ids.includes("concern:s:billing"));
  const checkout = map.crosscuts.find((c) => c.id === "component:s:checkout")!;
  assert.equal(checkout.files_in_scope, 2);
  assert.equal(checkout.files_total, 2);
  assert.equal(map.unframed_files.length, 0);
  assert.match(map.note, /Place new code inside the frame/);
});

test("buildAreaMap: 横断構造ノード自体のヒットは matched_directly、無所属 File は unframed に出る (無所属は正当)", () => {
  const map = buildAreaMap(GRAPH as any, ["concern:s:billing", "file:s:src/lonely/one.ts"]);
  const billing = map.crosscuts.find((c) => c.id === "concern:s:billing")!;
  assert.equal(billing.matched_directly, true);
  assert.deepEqual(map.unframed_files, [{ id: "file:s:src/lonely/one.ts", path: "src/lonely/one.ts" }]);
});

test("buildAreaMap: 構造ゼロの領域は空の地図 + 中立の note (悪扱いしない)", () => {
  const map = buildAreaMap(GRAPH as any, ["file:s:src/lonely/one.ts"]);
  assert.equal(map.crosscuts.length, 0);
  assert.match(map.note, /can be legitimate/);
});

test("isImplPath: 実装拡張子のみ true、.d.ts と拡張子なしは false", () => {
  assert.equal(isImplPath("src/a.ts"), true);
  assert.equal(isImplPath("hooks/x.mjs"), true);
  assert.equal(isImplPath("src/vite-env.d.ts"), false);
  assert.equal(isImplPath("README.md"), false);
  assert.equal(isImplPath("Makefile"), false);
});

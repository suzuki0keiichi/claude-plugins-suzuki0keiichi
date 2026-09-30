// issue #45: 型固有の任意属性 (Source の source_kind/url/fetched_at 等) は attribute_check で
// unknown 扱いにならない。既知語彙は対象 node の型ごとに決まる。
// graphrag:enforces constraint:graphrag-skill-dev:typed-add-attributes-known — typed-add / 文書化済みの型固有属性は unknown にならない
import assert from "node:assert/strict";
import test from "node:test";
import { unknownAttributeWarnings } from "./mutation-core.ts";
import { PROJECT_SCHEMA } from "./schema-project.ts";
import { PRINCIPAL_SCHEMA } from "./schema-principal.ts";
import { buildAddSourcePlan, buildAddResourcePlan } from "./cli-typed-add-project.ts";

const empty = { nodes: [], edges: [] };
const warnKeys = (plan: any, schema: any) =>
  unknownAttributeWarnings({ currentGraph: empty, plan, schema }).map((w) => w.key);

const sourcePlan = {
  reason: "r",
  nodes: [{
    op: "create", id: "source:p:s", type: "Source", title: "S", summary: "s",
    source_kind: "regulation", url: "https://example.com", fetched_at: "2026-09-30",
    refresh_method: "manual", staleness_threshold: "90d"
  }],
  edges: []
};

test("Source の文書化済み属性は project / principal の両 preset で warn されない", () => {
  assert.deepEqual(warnKeys(sourcePlan, PROJECT_SCHEMA), []);
  assert.deepEqual(warnKeys(sourcePlan, PRINCIPAL_SCHEMA), []);
});

test("型固有属性は別型に書くと warn される (型別の既知語彙)", () => {
  const plan = { reason: "r", nodes: [{ op: "create", id: "decision:p:d", type: "Decision", title: "D", summary: "d", url: "x", certainty: "Assumed" }], edges: [] };
  assert.deepEqual(warnKeys(plan, PROJECT_SCHEMA).sort(), ["certainty", "url"]);
});

test("typed-add (add-source / add-resource) が書く属性はすべて既知語彙", () => {
  const plans = [
    buildAddSourcePlan({ system: "p", slug: "s", title: "S", summary: "s", sourceKind: "document", aliases: ["x"], description: "d" } as any),
    buildAddResourcePlan({ system: "p", slug: "r", title: "R", summary: "r", category: "budget", aliases: ["x"], description: "d" } as any)
  ];
  for (const plan of plans) {
    assert.deepEqual(warnKeys(plan, PROJECT_SCHEMA), []);
    assert.deepEqual(warnKeys(plan, PRINCIPAL_SCHEMA), []);
  }
});

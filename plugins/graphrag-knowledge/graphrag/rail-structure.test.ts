import assert from "node:assert/strict";
import test from "node:test";
import { composeStructureContext, STRUCTURE_BUDGET_CHARS } from "./rail-structure.ts";
import type { StructureSummary } from "./crosscut-map.ts";

const frame = (id: string, summary: string, type = "Component"): StructureSummary => ({
  id, type, title: id, summary, files_in_scope: 1, files_total: 3, paths: ["src/a.ts"]
});

test("structure delivery preserves the full norm including a long final prohibition", () => {
  const s = frame("component:s:storage", "Documented intent. ".repeat(25) + "Never publish a partial write.");
  const result = composeStructureContext("src/a.ts", [s], new Set())!;
  assert.ok(result.context.includes(s.summary));
  assert.ok(result.context.includes("Registered intent (may be stale): src/a.ts"));
  assert.deepEqual(result.bodyIds, [s.id]);
  assert.deepEqual(result.omittedIds, []);
  assert.ok(result.chars <= STRUCTURE_BUDGET_CHARS);
});

test("oversized or missing bodies are references, never delivered; later fitting bodies still get space", () => {
  const long = frame("component:s:long", "x".repeat(1200));
  const empty = frame("component:s:empty", "");
  const small = frame("concern:s:atomic", "Publish atomically.", "Concern");
  const result = composeStructureContext("src/a.ts", [long, empty, small], new Set())!;
  assert.deepEqual(result.bodyIds, [small.id]);
  assert.deepEqual(result.omittedIds, [long.id]);
  assert.deepEqual(result.unavailableIds, [empty.id]);
  assert.ok(result.context.includes("1 structure body/bodies not shown"));
  assert.ok(result.context.includes("1 intent(s) not authored"));
  assert.ok(!result.context.includes("x".repeat(90)), "no clipped norm");
  assert.ok(result.chars <= STRUCTURE_BUDGET_CHARS);
});

test("provisional scaffolds are not delivered or marked read as authored intent", () => {
  const provisional = { ...frame("component:s:candidate", "Temporary machine-generated grouping"), summary_provisional: true };
  const result = composeStructureContext("src/a.ts", [provisional], new Set())!;
  assert.deepEqual(result.bodyIds, []);
  assert.deepEqual(result.omittedIds, []);
  assert.deepEqual(result.unavailableIds, [provisional.id]);
  assert.ok(result.context.includes("not authored (missing/provisional)"));
  assert.ok(!result.context.includes(provisional.summary));
  assert.ok(!result.context.includes("delta-check"), "a full lookup cannot manufacture a missing authored norm");
});

test("at most two bodies per delivery; remaining memberships can be delivered on another file", () => {
  const structures = [frame("component:s:c", "Component intent"), frame("layer:s:l", "Layer intent", "Layer"), frame("concern:s:r", "Concern intent", "Concern")];
  const first = composeStructureContext("src/a.ts", structures, new Set())!;
  assert.deepEqual(first.bodyIds, [structures[0].id, structures[1].id]);
  assert.deepEqual(first.omittedIds, [structures[2].id]);
  const second = composeStructureContext("src/b.ts", structures, new Set(first.bodyIds))!;
  assert.deepEqual(second.bodyIds, [structures[2].id]);
  assert.equal(composeStructureContext("src/c.ts", structures, new Set(structures.map((s) => s.id))), null);
});

test("all wrapper, path and omission text obey the character bound", () => {
  const structures = Array.from({ length: 20 }, (_, i) => frame(`component:s:${"long-id-".repeat(25)}${i}`, "x".repeat(900)));
  const result = composeStructureContext("src/" + "p".repeat(2000), structures, new Set(), 999)!;
  assert.equal(result.bodyIds.length, 0);
  assert.equal(result.omittedIds.length, 20);
  assert.equal(result.chars, result.context.length);
  assert.ok(result.chars <= 999);
  assert.equal(composeStructureContext("src/a.ts", structures, new Set(), 1), null);
});

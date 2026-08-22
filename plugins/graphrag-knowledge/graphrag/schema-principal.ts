// --- Principal vault schema preset ------------------------------------------
// 当事者 (意思決定・責任・署名の主体 — 法人・子会社・常設ユニット) の恒久 vault。
// project preset の perpetual 変種: 時限系型 Task / Milestone を減算し、追加型ゼロ。
//
// このファイルは PROJECT_SCHEMA からの機械的減算で導出する。統治ルール
// 「亜種は引き算と型ペア狭窄のみ」(decision:graphrag-skill-dev:schema-preset-governance-three-rules)
// をコード構造で保証するため、型やエッジをここで宣言し直さない — 追加する能力自体を持たない。
// 入場裁定: decision:graphrag-skill-dev:preset-entry-mandate-principal (2026-07-26)。
//
// 減算の帰結 (宣言的な期待リストは schema-principal.test.ts が固定):
//   - achieves / depends_on / targets はルールが全滅するためエッジごと消える
//   - requires は Decision → Resource のみ残る (恒久方針がリソースを前提とする形)
//   - falls_back_to は Goal → Goal のみ残る
// 時限断片の受け入れ拒否はここから生まれる: validateGraph が Task/Milestone を
// unknown node type として弾く (回送は crawler 側責務 — 器は明示エラーを返すだけ)。

import type { SchemaDefinition, RequiredField } from "./schema.ts";
import { PROJECT_SCHEMA } from "./schema-project.ts";

const REMOVED_TYPES: ReadonlySet<string> = new Set(["Task", "Milestone"]);

type Side = string | readonly string[];
type TypeRule = [Side, Side];

// ルールの片側から減算対象を除く。空になったらそのルール自体が成立しない (null)。
function pruneSide(side: Side): Side | null {
  if (typeof side === "string") return REMOVED_TYPES.has(side) ? null : side;
  const kept = side.filter((t) => !REMOVED_TYPES.has(t));
  return kept.length === 0 ? null : kept;
}

function pruneList(list: readonly string[]): readonly string[] {
  return list.filter((t) => !REMOVED_TYPES.has(t));
}

const nodeTypes = pruneList(PROJECT_SCHEMA.nodeTypes);

const edgeTypeRules: Record<string, TypeRule[]> = {};
for (const [edge, rules] of Object.entries(PROJECT_SCHEMA.edgeTypeRules)) {
  const pruned: TypeRule[] = [];
  for (const [from, to] of rules) {
    const f = pruneSide(from);
    const t = pruneSide(to);
    if (f !== null && t !== null) pruned.push([f, t]);
  }
  if (pruned.length > 0) edgeTypeRules[edge] = pruned;
}

// ルールが全滅したエッジ型は語彙からも消す (achieves / depends_on / targets)。
const edgeTypes = PROJECT_SCHEMA.edgeTypes.filter((e) => edgeTypeRules[e] !== undefined);

const stateVocabulary: Partial<Record<string, readonly string[]>> = {};
for (const [type, vocab] of Object.entries(PROJECT_SCHEMA.stateVocabulary)) {
  if (!REMOVED_TYPES.has(type) && vocab) stateVocabulary[type] = vocab;
}

const requiredFields: Partial<Record<string, readonly RequiredField[]>> = {};
for (const [type, fields] of Object.entries(PROJECT_SCHEMA.requiredFields)) {
  if (!REMOVED_TYPES.has(type) && fields) requiredFields[type] = fields;
}

export const PRINCIPAL_SCHEMA: SchemaDefinition = {
  id: "principal",
  nodeTypes,
  edgeTypes,
  edgeTypeRules: edgeTypeRules as Record<string, [string | readonly string[], string | readonly string[]][]>,
  stateVocabulary,
  requiredFields,
  aliases: { ...PROJECT_SCHEMA.aliases },
  categories: {
    knowledge: pruneList(PROJECT_SCHEMA.categories.knowledge),
    crosscut: pruneList(PROJECT_SCHEMA.categories.crosscut),
    distilled: pruneList(PROJECT_SCHEMA.categories.distilled),
    // provenance はノード型でなく edge type — REMOVED_TYPES の剪定でなく
    // 「principal に残った edge type」で絞る。
    provenance: PROJECT_SCHEMA.categories.provenance.filter((e) => edgeTypes.includes(e)),
    duplicateCheck: pruneList(PROJECT_SCHEMA.categories.duplicateCheck),
    staleness: pruneList(PROJECT_SCHEMA.categories.staleness),
    premiseCandidate: pruneList(PROJECT_SCHEMA.categories.premiseCandidate),
    relation: pruneList(PROJECT_SCHEMA.categories.relation),
  },
  llmReference: "",
};

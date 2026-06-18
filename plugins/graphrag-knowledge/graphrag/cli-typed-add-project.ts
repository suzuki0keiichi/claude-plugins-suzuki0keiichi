/**
 * typed-add 系 CLI の plan 組み立て pure 関数群 — project vault 専用。
 * cli-headlines.ts の runAdd* (project) 関数から呼ばれる。
 *
 * 対象ノード型 (project vault にのみ存在するもの):
 *   Stakeholder / Resource / Milestone / Assumption / Agreement / Task / Source / Theme
 *
 * 使用するエッジ型は schema-project.ts の EDGE_TYPE_RULES に準拠する。
 * Assumption は certainty フィールドが必須 (schema requiredFields)。
 * Task は derived_from evidence が必要 (system vault の Decision 相当)。
 * Source / Agreement / Stakeholder / Resource / Milestone / Theme は evidence 不要。
 */

import { PROJECT_SCHEMA } from "./schema-project.ts";

// プロジェクトスキーマの edge type rules を直接使う
const PROJECT_EDGE_RULES = PROJECT_SCHEMA.edgeTypeRules;
const PROJECT_STATE_VOCABULARY = PROJECT_SCHEMA.stateVocabulary;

// id 接頭辞 → ProjectNodeType のルックアップ。
// schama-project の全 nodeTypes から生成する。
const TYPE_SLUG_TO_PROJECT_NODE: Record<string, string> = {};
for (const t of PROJECT_SCHEMA.nodeTypes) {
  TYPE_SLUG_TO_PROJECT_NODE[t.toLowerCase()] = t;
}
// 歴史的 id 接頭辞 (system vault との互換)
const HISTORICAL_ID_SLUGS: Record<string, string> = {
  "conversation": "ConversationChunk",
  "ok": "OperationalKnowledge",
  "operational-knowledge": "OperationalKnowledge",
  "rejected-option": "RejectedOption",
};
Object.assign(TYPE_SLUG_TO_PROJECT_NODE, HISTORICAL_ID_SLUGS);

function nodeTypeFromId(id: string): string | undefined {
  const prefix = id.split(":")[0]?.toLowerCase() ?? "";
  return TYPE_SLUG_TO_PROJECT_NODE[prefix];
}

type AllowedType = string | ReadonlyArray<string>;

function matchesType(allowed: AllowedType, actual: string | undefined): boolean {
  if (Array.isArray(allowed)) return (allowed as ReadonlyArray<string>).includes(actual as string);
  return allowed === actual;
}

function assertEdgeAllowed(edgeType: string, fromType: string, toId: string, flag: string): void {
  const rules = (PROJECT_EDGE_RULES[edgeType] ?? []).filter(
    ([allowedFrom]: [AllowedType, AllowedType]) => matchesType(allowedFrom, fromType)
  );
  const toType = nodeTypeFromId(toId);
  const ok = rules.some(([, allowedTo]: [AllowedType, AllowedType]) => matchesType(allowedTo, toType));
  if (!ok) {
    const allowedTos = new Set<string>();
    for (const [, allowedTo] of rules) {
      for (const t of Array.isArray(allowedTo) ? allowedTo : [allowedTo]) allowedTos.add(t as string);
    }
    const allowedStr = [...allowedTos].join(", ") || "(none)";
    throw new Error(
      `${flag}: "${toId}" は ${edgeType} (${fromType} -> ?) の宛先に不正です ` +
        `(推定型: ${toType ?? "unknown"}、許容: ${allowedStr})`
    );
  }
}

function nodeId(typeSlug: string, system: string, slug: string): string {
  return `${typeSlug}:${system}:${slug}`;
}

function edgeId(from: string, type: string, to: string): string {
  const norm = (s: string) => s.replace(/:/g, "_");
  return `${norm(from)}__${type}__${norm(to)}`;
}

function makeEdge(edgeType: string, from: string, to: string) {
  return { op: "create", id: edgeId(from, edgeType, to), type: edgeType, from, to };
}

function makeDerivedFromEdges(from: string, evidence: string[] | undefined) {
  return (evidence ?? []).map((to) => ({
    op: "create",
    id: edgeId(from, "derived_from", to),
    type: "derived_from",
    from,
    to
  }));
}

function fanOutEdges(edgeType: string, from: string, fromType: string, tos: string[] | undefined, flag: string) {
  return (tos ?? []).map((to) => {
    assertEdgeAllowed(edgeType, fromType, to, flag);
    return makeEdge(edgeType, from, to);
  });
}

function withDescription(node: Record<string, unknown>, description?: string) {
  if (typeof description === "string" && description.trim() !== "") {
    return { ...node, description };
  }
  return node;
}

function withAliases(node: Record<string, unknown>, aliases?: string[]) {
  const cleaned = (aliases ?? []).map((a) => a.trim()).filter((a) => a !== "");
  if (cleaned.length > 0) {
    return { ...node, aliases: cleaned };
  }
  return node;
}

// ─────────────────────────── Stakeholder ───────────────────────────

export type AddStakeholderArgs = {
  system: string;
  slug: string;
  title: string;
  summary: string;
  description?: string;
  aliases?: string[];
  reason?: string;
  responsibleFor?: string[]; // responsible_for: Stakeholder → Task/Goal/Milestone/Agreement
  concernedWith?: string[];  // concerned_with: Stakeholder → Goal/Decision/Risk/Task/Milestone/Theme
};

export function buildAddStakeholderPlan(args: AddStakeholderArgs) {
  const id = nodeId("stakeholder", args.system, args.slug);
  const edges = [
    ...fanOutEdges("responsible_for", id, "Stakeholder", args.responsibleFor, "--responsible-for"),
    ...fanOutEdges("concerned_with", id, "Stakeholder", args.concernedWith, "--concerned-with"),
  ];
  return {
    reason: args.reason ?? `新規 Stakeholder ${args.slug}`,
    nodes: [withAliases(withDescription({ op: "create", id, type: "Stakeholder", title: args.title, summary: args.summary }, args.description), args.aliases)],
    edges
  };
}

// ─────────────────────────── Resource ───────────────────────────

const RESOURCE_CATEGORIES = ["people", "budget", "asset", "time"] as const;
export type ResourceCategory = typeof RESOURCE_CATEGORIES[number];

export type AddResourceArgs = {
  system: string;
  slug: string;
  title: string;
  summary: string;
  description?: string;
  aliases?: string[];
  reason?: string;
  category?: ResourceCategory;
};

export function buildAddResourcePlan(args: AddResourceArgs) {
  const id = nodeId("resource", args.system, args.slug);
  if (args.category !== undefined && !RESOURCE_CATEGORIES.includes(args.category)) {
    throw new Error(
      `buildAddResourcePlan: invalid --category "${args.category}" (allowed: ${RESOURCE_CATEGORIES.join(", ")})`
    );
  }
  const node: Record<string, unknown> = { op: "create", id, type: "Resource", title: args.title, summary: args.summary };
  if (args.category !== undefined) {
    node.category = args.category;
  }
  return {
    reason: args.reason ?? `新規 Resource ${args.slug}`,
    nodes: [withAliases(withDescription(node, args.description), args.aliases)],
    edges: []
  };
}

// ─────────────────────────── Milestone ───────────────────────────

export type AddMilestoneArgs = {
  system: string;
  slug: string;
  title: string;
  summary: string;
  description?: string;
  aliases?: string[];
  reason?: string;
  state?: string; // planned|achieved|missed
  dependsOn?: string[]; // depends_on: Milestone → Milestone
};

export function buildAddMilestonePlan(args: AddMilestoneArgs) {
  const id = nodeId("milestone", args.system, args.slug);
  const node: Record<string, unknown> = { op: "create", id, type: "Milestone", title: args.title, summary: args.summary };
  if (args.state !== undefined) {
    const vocabulary = PROJECT_STATE_VOCABULARY["Milestone"] ?? [];
    if (!vocabulary.includes(args.state)) {
      throw new Error(
        `buildAddMilestonePlan: invalid --state "${args.state}" (allowed: ${vocabulary.join(", ")})`
      );
    }
    node.state = args.state;
  }
  const edges = fanOutEdges("depends_on", id, "Milestone", args.dependsOn, "--depends-on");
  return {
    reason: args.reason ?? `新規 Milestone ${args.slug}`,
    nodes: [withAliases(withDescription(node, args.description), args.aliases)],
    edges
  };
}

// ─────────────────────────── Assumption ───────────────────────────

const CERTAINTY_LEVELS = ["Established", "Expected", "Assumed", "Speculative"] as const;
export type CertaintyLevel = typeof CERTAINTY_LEVELS[number];

export type AddAssumptionArgs = {
  system: string;
  slug: string;
  title: string;
  summary: string;
  description?: string;
  aliases?: string[];
  reason?: string;
  certainty: CertaintyLevel; // 必須 (schema requiredFields)
  premise?: string[]; // has_premise: Assumption → Decision/Constraint/Goal/OK/Assumption/Agreement
};

export function buildAddAssumptionPlan(args: AddAssumptionArgs) {
  if (!args.certainty) {
    throw new Error("buildAddAssumptionPlan: --certainty is required (Established|Expected|Assumed|Speculative)");
  }
  if (!CERTAINTY_LEVELS.includes(args.certainty)) {
    throw new Error(
      `buildAddAssumptionPlan: invalid --certainty "${args.certainty}" (allowed: ${CERTAINTY_LEVELS.join(", ")})`
    );
  }
  const id = nodeId("assumption", args.system, args.slug);
  const node: Record<string, unknown> = {
    op: "create",
    id,
    type: "Assumption",
    title: args.title,
    summary: args.summary,
    certainty: args.certainty
  };
  const edges = fanOutEdges("has_premise", id, "Assumption", args.premise, "--premise");
  return {
    reason: args.reason ?? `新規 Assumption ${args.slug}`,
    nodes: [withAliases(withDescription(node, args.description), args.aliases)],
    edges
  };
}

// ─────────────────────────── Agreement ───────────────────────────

export type AddAgreementArgs = {
  system: string;
  slug: string;
  title: string;
  summary: string;
  description?: string;
  aliases?: string[];
  reason?: string;
  state?: string; // exploring|negotiating|signed|active|expired
  partyTo?: string[]; // party_to: Stakeholder → Agreement (reversed: we add Stakeholder→this Agreement)
  documentedBy?: string; // documented_by: Agreement → Source
};

export function buildAddAgreementPlan(args: AddAgreementArgs) {
  const id = nodeId("agreement", args.system, args.slug);
  const node: Record<string, unknown> = { op: "create", id, type: "Agreement", title: args.title, summary: args.summary };
  if (args.state !== undefined) {
    const vocabulary = PROJECT_STATE_VOCABULARY["Agreement"] ?? [];
    if (!vocabulary.includes(args.state)) {
      throw new Error(
        `buildAddAgreementPlan: invalid --state "${args.state}" (allowed: ${vocabulary.join(", ")})`
      );
    }
    node.state = args.state;
  }
  const edges: ReturnType<typeof makeEdge>[] = [];
  // party_to: Stakeholder → Agreement 向き (from が stakeholder、to が this agreement)
  for (const stId of (args.partyTo ?? [])) {
    assertEdgeAllowed("party_to", "Stakeholder", id, "--party-to");
    edges.push(makeEdge("party_to", stId, id));
  }
  // documented_by: Agreement → Source
  if (args.documentedBy !== undefined) {
    assertEdgeAllowed("documented_by", "Agreement", args.documentedBy, "--documented-by");
    edges.push(makeEdge("documented_by", id, args.documentedBy));
  }
  return {
    reason: args.reason ?? `新規 Agreement ${args.slug}`,
    nodes: [withAliases(withDescription(node, args.description), args.aliases)],
    edges
  };
}

// ─────────────────────────── Task ───────────────────────────

export type AddTaskArgs = {
  system: string;
  slug: string;
  title: string;
  summary: string;
  description?: string;
  aliases?: string[];
  reason?: string;
  evidence?: string[]; // derived_from: Task → ConversationChunk/Investigation/Source
  state?: string; // planned|active|completed|cancelled
  achieves?: string[]; // achieves: Task → Goal
  requires?: string[]; // requires: Task → Resource
  dependsOn?: string[]; // depends_on: Task → Task
};

export function buildAddTaskPlan(args: AddTaskArgs) {
  const id = nodeId("task", args.system, args.slug);
  const node: Record<string, unknown> = { op: "create", id, type: "Task", title: args.title, summary: args.summary };
  if (args.state !== undefined) {
    const vocabulary = PROJECT_STATE_VOCABULARY["Task"] ?? [];
    if (!vocabulary.includes(args.state)) {
      throw new Error(
        `buildAddTaskPlan: invalid --state "${args.state}" (allowed: ${vocabulary.join(", ")})`
      );
    }
    node.state = args.state;
  }
  const edges = [
    ...makeDerivedFromEdges(id, args.evidence),
    ...fanOutEdges("achieves", id, "Task", args.achieves, "--achieves"),
    ...fanOutEdges("requires", id, "Task", args.requires, "--requires"),
    ...fanOutEdges("depends_on", id, "Task", args.dependsOn, "--depends-on"),
  ];
  return {
    reason: args.reason ?? `新規 Task ${args.slug}`,
    nodes: [withAliases(withDescription(node, args.description), args.aliases)],
    edges
  };
}

// ─────────────────────────── Source ───────────────────────────

const SOURCE_KINDS = ["document", "event", "regulation", "incident"] as const;
export type SourceKind = typeof SOURCE_KINDS[number];

export type AddSourceArgs = {
  system: string;
  slug: string;
  title: string;
  summary: string;
  description?: string;
  aliases?: string[];
  reason?: string;
  sourceKind?: SourceKind;
};

export function buildAddSourcePlan(args: AddSourceArgs) {
  const id = nodeId("source", args.system, args.slug);
  if (args.sourceKind !== undefined && !SOURCE_KINDS.includes(args.sourceKind)) {
    throw new Error(
      `buildAddSourcePlan: invalid --source-kind "${args.sourceKind}" (allowed: ${SOURCE_KINDS.join(", ")})`
    );
  }
  const node: Record<string, unknown> = { op: "create", id, type: "Source", title: args.title, summary: args.summary };
  if (args.sourceKind !== undefined) {
    node.source_kind = args.sourceKind;
  }
  return {
    reason: args.reason ?? `新規 Source ${args.slug}`,
    nodes: [withAliases(withDescription(node, args.description), args.aliases)],
    edges: []
  };
}

// ─────────────────────────── Theme ───────────────────────────

export type AddThemeArgs = {
  system: string;
  slug: string;
  title: string;
  summary: string;
  description?: string;
  aliases?: string[];
  reason?: string;
  encompasses?: string[]; // encompasses: Theme → Goal/Decision/Risk/Task/Resource/Assumption
};

export function buildAddThemePlan(args: AddThemeArgs) {
  const id = nodeId("theme", args.system, args.slug);
  const edges = fanOutEdges("encompasses", id, "Theme", args.encompasses, "--encompasses");
  return {
    reason: args.reason ?? `新規 Theme ${args.slug}`,
    nodes: [withAliases(withDescription({ op: "create", id, type: "Theme", title: args.title, summary: args.summary }, args.description), args.aliases)],
    edges
  };
}

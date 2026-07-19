/**
 * typed-add 系 CLI の plan 組み立て pure 関数群。
 * 各関数は引数だけから mutation plan オブジェクトを返す。
 * id 規約は `<typeSlug>:<system>:<slug>`。`<system>` は名前空間ラベル
 * (v3.3 で System ノードと contains は撤去済み。所属は vault 境界が担う)。
 *
 * Evidence エッジは全て `documented_by` を使う:
 *   schema EDGE_TYPE_RULES.documented_by =
 *     [["Decision", "RejectedOption", "Risk", "OperationalKnowledge", "Investigation"], "File"]
 *   = 5 typed-add 全て対象 (Constraint/Goal は documented_by 不可)。
 *
 * RejectedOption と「選ばれた Decision」の繋ぎは schema 上 `supersedes` (Decision → RejectedOption) のみ。
 * `rejected_in` は RejectedOption → Investigation のみ許容なので使えない。
 * --rejected-in-favor-of <decision-id> は Decision → RejectedOption の supersedes エッジに変換する。
 *
 * エッジフラグ (--constrains / --sets-policy-for / --premise / --from-investigation /
 * --refines / --reduces-risk / --risks-in / --derived-from) は schema 文法
 * (EDGE_TYPE_RULES) に厳密対応する。文法違反になる宛先 (id 接頭辞から推定した型) を
 * 受け取ったら黙って落とさず具体的なメッセージで throw する。
 */

import { STATE_VOCABULARY, EDGE_TYPE_RULES, NODE_TYPES, NODE_TYPE_ALIASES } from "./schema.ts";
import type { NodeType, EdgeType } from "./schema.ts";

type Evidence = string; // "file:<system>:<path>" 形式

// id 接頭辞 (`<typeSlug>:...`) → NodeType。typeSlug は型名の小文字。
// 文法検証で「宛先がこのエッジに許される型か」を id だけから判定するために使う。
const TYPE_SLUG_TO_NODE: Record<string, NodeType> = {};
for (const t of NODE_TYPES) {
  TYPE_SLUG_TO_NODE[t.toLowerCase()] = t;
}
// canonical 化前の地質メタファー alias (Stratum/Vein/Pocket) の id 接頭辞も拾う。
for (const [alias, canonical] of Object.entries(NODE_TYPE_ALIASES)) {
  TYPE_SLUG_TO_NODE[alias.toLowerCase()] = canonical;
}
// 実在 vault の歴史的な id 接頭辞表記。dev-vault は `conversation:` / `ok:` /
// `rejectedoption:`、gestalty (v2 移行由来) は `rejected-option:` / `operational-knowledge:` を
// 使っており、型名小文字だけだと実データで unknown になり正当なエッジを弾く (3.8.0 実地で発覚)。
const HISTORICAL_ID_SLUGS: Record<string, NodeType> = {
  "conversation": "ConversationChunk",
  "ok": "OperationalKnowledge",
  "operational-knowledge": "OperationalKnowledge",
  "rejected-option": "RejectedOption",
};
Object.assign(TYPE_SLUG_TO_NODE, HISTORICAL_ID_SLUGS);

function nodeTypeFromId(id: string): NodeType | undefined {
  const prefix = id.split(":")[0]?.toLowerCase() ?? "";
  return TYPE_SLUG_TO_NODE[prefix];
}

type AllowedType = NodeType | ReadonlyArray<NodeType>;

function matchesType(allowed: AllowedType, actual: NodeType | undefined): boolean {
  return Array.isArray(allowed) ? allowed.includes(actual) : allowed === actual;
}

// from 型を固定したエッジについて、宛先 id (の接頭辞から推定した型) が schema 文法に
// 適うかを検証し、適わなければ throw。許容宛先型一覧をメッセージに添える (黙って落とさない)。
function assertEdgeAllowed(edgeType: EdgeType, fromType: NodeType, toId: string, flag: string): void {
  const rules = (EDGE_TYPE_RULES[edgeType] ?? []).filter(([allowedFrom]) => matchesType(allowedFrom, fromType));
  const toType = nodeTypeFromId(toId);
  const ok = rules.some(([, allowedTo]) => matchesType(allowedTo, toType));
  if (!ok) {
    const allowedTos = new Set<NodeType>();
    for (const [, allowedTo] of rules) {
      for (const t of Array.isArray(allowedTo) ? allowedTo : [allowedTo]) allowedTos.add(t);
    }
    const allowedStr = [...allowedTos].join(", ") || "(none)";
    throw new Error(
      `${flag}: "${toId}" is not a valid target for ${edgeType} (${fromType} -> ?) ` +
        `(inferred type: ${toType ?? "unknown"}, allowed: ${allowedStr})`
    );
  }
}

function makeEdge(edgeType: EdgeType, from: string, to: string) {
  return { op: "create", id: edgeId(from, edgeType, to), type: edgeType, from, to };
}

export type AddDecisionArgs = {
  system: string;
  slug: string;
  title: string;
  summary: string;
  description?: string; // 任意。蒸留散文 (vault body `## 説明` に round-trip marker 付きで出る)
  aliases?: string[]; // 任意。embedding / lexical aliasExact に配線済 (R3)
  evidence?: Evidence[];
  reason?: string;
  // E1 add-decision 追加フラグ (全て任意・複数可)
  setsPolicyFor?: string[]; // sets_policy_for: Decision → File|Investigation|OperationalKnowledge|Layer|Concern|Component
  premise?: string[]; // has_premise: Decision → Decision|OperationalKnowledge|Constraint|Risk|Goal
  fromInvestigation?: string; // led_to: Investigation → この Decision (向きは inv→decision)
  refines?: string; // refines: Decision → Decision
  reducesRisk?: string[]; // reduces_risk: Decision → Risk
};

// description は任意。空/未指定なら node に載せない (undefined を撒かない)。
function withDescription(node: Record<string, unknown>, description?: string) {
  if (typeof description === "string" && description.trim() !== "") {
    return { ...node, description };
  }
  return node;
}

// aliases は任意。空配列/未指定なら node に載せない (空キーを撒かない)。
function withAliases(node: Record<string, unknown>, aliases?: string[]) {
  const cleaned = (aliases ?? []).map((a) => a.trim()).filter((a) => a !== "");
  if (cleaned.length > 0) {
    return { ...node, aliases: cleaned };
  }
  return node;
}

export type AddOkArgs = {
  system: string;
  slug: string;
  title: string;
  summary: string;
  description?: string;
  aliases?: string[];
  evidence?: Evidence[];
  reason?: string;
  // E1 add-ok 追加フラグ
  premise?: string[]; // has_premise: OperationalKnowledge → Decision|OperationalKnowledge|Constraint|Risk|Goal
  refines?: string; // refines: OperationalKnowledge → Decision|OperationalKnowledge
  reducesRisk?: string[]; // reduces_risk: OperationalKnowledge → Risk
};

export type AddRiskArgs = {
  system: string;
  slug: string;
  title: string;
  summary: string;
  description?: string;
  aliases?: string[];
  evidence?: Evidence[];
  reason?: string;
  // E1 add-risk 追加フラグ
  risksIn?: string[]; // risks_in: Risk → Decision|File|OperationalKnowledge|Investigation|Layer|Concern|Component
};

export type AddConstraintArgs = {
  system: string;
  slug: string;
  title: string;
  summary: string;
  description?: string;
  aliases?: string[];
  reason?: string;
  // E2 add-constraint: --constrains 必須 ≥1。constrains: Constraint → Decision|File|OperationalKnowledge
  // Constraint は documented_by 不可・evidence 不要 (契約)。
  constrains: string[];
  // 強制の結線 (どちらか一方が必須 — enforcement contract):
  // enforcedBy: enforced_by: Constraint → File (破ったら落ちる検査: テスト/lint/型)。
  // unenforceable: 機械強制できない外部条件 (法規/SLA 等) の明示宣言 — 理由文字列。
  //   node に enforcement:"none" + enforcement_reason を刻み、constraint-check は
  //   未ガードとして可視化し続ける (登記は許すが、見えなくはしない)。
  enforcedBy?: string[];
  unenforceable?: string;
  // enforcement contract は system プリセット限定 (project vault には File が無く、
  // Constraint は本来的に外部条件)。呼び出し側 (runAddConstraint) が vault の
  // schema を解決して渡す。未指定は system (厳格側に倒す)。
  schemaPreset?: "system" | "project";
};

export type AddGoalArgs = {
  system: string;
  slug: string;
  title: string;
  summary: string;
  description?: string;
  aliases?: string[];
  reason?: string;
  // E2 add-goal
  refines?: string; // refines: Goal → Goal
  derivedFrom?: string; // derived_from: Goal → ConversationChunk|Investigation
  state?: string; // 任意。語彙は STATE_VOCABULARY.Goal。未指定なら state 無し
  // 任意 (他 verb と違い必須ではない): 予約作業 (state: planned) が宿る場所への
  // documented_by。張っておくと、その場所を触った commit の delta-check で浮上する。
  evidence?: string[];
};

export type AddInvestigationArgs = AddDecisionArgs & {
  rawContent: string;
  state?: string; // 未指定なら "active" (--state で上書き、語彙は STATE_VOCABULARY.Investigation)
};

export type AddRejectedOptionArgs = {
  system: string;
  slug: string;
  title: string;
  summary: string;
  description?: string;
  aliases?: string[];
  evidence?: Evidence[];
  reason?: string;
  rejectedInFavorOf: string; // "decision:<system>:<slug>"
};

// id 規約 `<typeSlug>:<system>:<slug>` の 3 セグメント構造を守る入口検証。
// `:` を含む slug は nodeTypeFromId / xref / edgeId のセグメント解釈を壊し、
// 大文字・空白は lexical 照合や slug 規約 (意味を担う kebab-case) から外れる。
// create 専用経路なので既存 vault のレガシー id には影響しない (update は nodeId を通らない)。
const ID_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;

function assertIdSegment(value: string, flag: string): void {
  if (!ID_SEGMENT_RE.test(value)) {
    throw new Error(
      `${flag}: "${value}" is invalid. ` +
        `slug must be meaning-bearing kebab-case: lowercase letters/digits plus . _ - ` +
        `(pattern ${ID_SEGMENT_RE}). ":", whitespace, and uppercase break the id 3-segment convention ` +
        `(<type>:<system>:<slug>) and cannot be used.`
    );
  }
}

function nodeId(typeSlug: string, system: string, slug: string): string {
  assertIdSegment(system, "--system");
  assertIdSegment(slug, "--slug");
  return `${typeSlug}:${system}:${slug}`;
}

// mutation plan のエッジ id 規約 (単一正本)。suggest-policy-edges の plan_fragment も
// この規約で id を組む (同じエッジは同じ id になり、二重付与が validate で弾ける)。
export function edgeId(from: string, type: string, to: string): string {
  const norm = (s: string) => s.replace(/:/g, "_");
  return `${norm(from)}__${type}__${norm(to)}`;
}

function makeDocumentedByEdges(from: string, evidence: Evidence[] | undefined) {
  return (evidence ?? []).map((to) => ({
    op: "create",
    id: edgeId(from, "documented_by", to),
    type: "documented_by",
    from,
    to
  }));
}

// 「from 固定・宛先複数」のエッジフラグを検証付きで展開する共通ヘルパ。
function fanOutEdges(edgeType: EdgeType, from: string, fromType: NodeType, tos: string[] | undefined, flag: string) {
  return (tos ?? []).map((to) => {
    assertEdgeAllowed(edgeType, fromType, to, flag);
    return makeEdge(edgeType, from, to);
  });
}

export function buildAddDecisionPlan(args: AddDecisionArgs) {
  const id = nodeId("decision", args.system, args.slug);
  const edges = [
    ...makeDocumentedByEdges(id, args.evidence),
    ...fanOutEdges("sets_policy_for", id, "Decision", args.setsPolicyFor, "--sets-policy-for"),
    ...fanOutEdges("has_premise", id, "Decision", args.premise, "--premise"),
    ...fanOutEdges("reduces_risk", id, "Decision", args.reducesRisk, "--reduces-risk")
  ];
  if (args.refines !== undefined) {
    assertEdgeAllowed("refines", "Decision", args.refines, "--refines");
    edges.push(makeEdge("refines", id, args.refines));
  }
  // led_to は Investigation → Decision 向き (向きは investigation→新Decision、from が investigation)。
  if (args.fromInvestigation !== undefined) {
    assertEdgeAllowed("led_to", "Investigation", id, "--from-investigation");
    if (nodeTypeFromId(args.fromInvestigation) !== "Investigation") {
      throw new Error(
        `--from-investigation: "${args.fromInvestigation}" is not an Investigation ` +
          `(led_to is Investigation -> Decision, inferred type: ${nodeTypeFromId(args.fromInvestigation) ?? "unknown"})`
      );
    }
    edges.push(makeEdge("led_to", args.fromInvestigation, id));
  }
  return {
    reason: args.reason ?? `新規 Decision ${args.slug}`,
    nodes: [withAliases(withDescription({ op: "create", id, type: "Decision", title: args.title, summary: args.summary }, args.description), args.aliases)],
    edges
  };
}

export function buildAddOkPlan(args: AddOkArgs) {
  const id = nodeId("operationalknowledge", args.system, args.slug);
  const edges = [
    ...makeDocumentedByEdges(id, args.evidence),
    ...fanOutEdges("has_premise", id, "OperationalKnowledge", args.premise, "--premise"),
    ...fanOutEdges("reduces_risk", id, "OperationalKnowledge", args.reducesRisk, "--reduces-risk")
  ];
  if (args.refines !== undefined) {
    assertEdgeAllowed("refines", "OperationalKnowledge", args.refines, "--refines");
    edges.push(makeEdge("refines", id, args.refines));
  }
  return {
    reason: args.reason ?? `新規 OperationalKnowledge ${args.slug}`,
    nodes: [withAliases(withDescription({ op: "create", id, type: "OperationalKnowledge", title: args.title, summary: args.summary }, args.description), args.aliases)],
    edges
  };
}

export function buildAddRiskPlan(args: AddRiskArgs) {
  const id = nodeId("risk", args.system, args.slug);
  const edges = [
    ...makeDocumentedByEdges(id, args.evidence),
    ...fanOutEdges("risks_in", id, "Risk", args.risksIn, "--risks-in")
  ];
  return {
    reason: args.reason ?? `新規 Risk ${args.slug}`,
    nodes: [withAliases(withDescription({ op: "create", id, type: "Risk", title: args.title, summary: args.summary }, args.description), args.aliases)],
    edges
  };
}

export function buildAddConstraintPlan(args: AddConstraintArgs) {
  const constrains = args.constrains ?? [];
  if (constrains.length < 1) {
    throw new Error("buildAddConstraintPlan: --constrains is required (≥1; prevents orphan Constraint)");
  }
  const id = nodeId("constraint", args.system, args.slug);
  // Enforcement contract: 散文だけの Constraint は、コードが違反しても何も落ちず
  // 「注意力による強制」に縮退する (書かれても不活性)。新規 Constraint は必ず
  // 「機械的消費者を結線する」か「機械強制できないと明示宣言する」かのどちらかを選ぶ。
  const enforcedBy = (args.enforcedBy ?? []).filter((s) => s.trim() !== "");
  const unenforceable = typeof args.unenforceable === "string" ? args.unenforceable.trim() : "";
  const preset = args.schemaPreset ?? "system";
  if (preset === "project" && enforcedBy.length > 0) {
    throw new Error(
      "buildAddConstraintPlan: --enforced-by is a system-vault concept (project vaults have no File nodes, " +
        "and their constraints are external conditions by nature). Drop --enforced-by; optionally declare " +
        '--unenforceable "<why>" to record the reason.'
    );
  }
  if (enforcedBy.length > 0 && unenforceable !== "") {
    throw new Error(
      "buildAddConstraintPlan: --enforced-by and --unenforceable are mutually exclusive " +
        "(a constraint either has a mechanical enforcer or is declared unenforceable — not both). Drop one."
    );
  }
  if (preset === "system" && enforcedBy.length === 0 && unenforceable === "") {
    throw new Error(
      "buildAddConstraintPlan: every new Constraint must choose its enforcement. Either:\n" +
        `  (a) --enforced-by file:${args.system}:<path/to/check> — the executable check (test / lint config / type ` +
        "definition) that FAILS when this constraint is violated. Also put a comment marker " +
        `\`graphrag:enforces ${id}\` inside that file so constraint-check can cross-verify both directions; or\n` +
        '  (b) --unenforceable "<why>" — this is an external condition (law / SLA / vendor limitation) that no ' +
        "mechanical check can express. It will stay permanently visible as unguarded in constraint-check.\n" +
        "A prose-only constraint enforces nothing — it decays into a diary entry that never fires when violated."
    );
  }
  // Constraint は documented_by 不可・evidence 不要 (契約)。エッジは constrains + enforced_by。
  const edges = [
    ...fanOutEdges("constrains", id, "Constraint", constrains, "--constrains"),
    ...fanOutEdges("enforced_by", id, "Constraint", enforcedBy, "--enforced-by")
  ];
  const node: Record<string, unknown> = { op: "create", id, type: "Constraint", title: args.title, summary: args.summary };
  if (unenforceable !== "") {
    node.enforcement = "none";
    node.enforcement_reason = unenforceable;
  }
  return {
    reason: args.reason ?? `新規 Constraint ${args.slug}`,
    nodes: [withAliases(withDescription(node, args.description), args.aliases)],
    edges
  };
}

export function buildAddGoalPlan(args: AddGoalArgs) {
  const id = nodeId("goal", args.system, args.slug);
  // state は任意 (契約: 既定 state なし)。指定時のみ語彙検証 (typo ゾンビ防止)。
  const node: Record<string, unknown> = { op: "create", id, type: "Goal", title: args.title, summary: args.summary };
  if (args.state !== undefined) {
    const vocabulary = STATE_VOCABULARY.Goal ?? [];
    if (!vocabulary.includes(args.state)) {
      throw new Error(
        `buildAddGoalPlan: invalid --state "${args.state}" (allowed: ${vocabulary.join(", ")})`
      );
    }
    node.state = args.state;
  }
  const edges = [] as ReturnType<typeof makeEdge>[];
  if (args.refines !== undefined) {
    assertEdgeAllowed("refines", "Goal", args.refines, "--refines");
    edges.push(makeEdge("refines", id, args.refines));
  }
  if (args.derivedFrom !== undefined) {
    assertEdgeAllowed("derived_from", "Goal", args.derivedFrom, "--derived-from");
    edges.push(makeEdge("derived_from", id, args.derivedFrom));
  }
  return {
    reason: args.reason ?? `新規 Goal ${args.slug}`,
    nodes: [withAliases(withDescription(node, args.description), args.aliases)],
    edges: [...edges, ...makeDocumentedByEdges(id, args.evidence)]
  };
}

export function buildAddInvestigationPlan(args: AddInvestigationArgs) {
  const id = nodeId("investigation", args.system, args.slug);
  // 既定 "active" を必ず刻む。state 無し Investigation は resume が現役と判別できず
  // 構造的に空振りするため、新規作成時点で語彙内の state を保証する。
  const state = args.state ?? "active";
  const vocabulary = STATE_VOCABULARY.Investigation ?? [];
  if (!vocabulary.includes(state)) {
    throw new Error(
      `buildAddInvestigationPlan: invalid --state "${state}" (allowed: ${vocabulary.join(", ")})`
    );
  }
  return {
    reason: args.reason ?? `新規 Investigation ${args.slug}`,
    nodes: [withAliases(withDescription({
      op: "create",
      id,
      type: "Investigation",
      title: args.title,
      summary: args.summary,
      state,
      raw_content: args.rawContent
    }, args.description), args.aliases)],
    edges: makeDocumentedByEdges(id, args.evidence)
  };
}

export function buildAddRejectedOptionPlan(args: AddRejectedOptionArgs) {
  if (!args.rejectedInFavorOf) {
    throw new Error("buildAddRejectedOptionPlan: --rejected-in-favor-of is required (prevents orphan RejectedOption)");
  }
  const id = nodeId("rejectedoption", args.system, args.slug);
  // schema 上 'Decision が RejectedOption を選ばなかった' を表すエッジは
  // Decision → RejectedOption の supersedes のみ。
  const supersedesEdge = {
    op: "create",
    id: edgeId(args.rejectedInFavorOf, "supersedes", id),
    type: "supersedes",
    from: args.rejectedInFavorOf,
    to: id
  };
  return {
    reason: args.reason ?? `新規 RejectedOption ${args.slug}`,
    nodes: [withAliases(withDescription({ op: "create", id, type: "RejectedOption", title: args.title, summary: args.summary }, args.description), args.aliases)],
    edges: [supersedesEdge, ...makeDocumentedByEdges(id, args.evidence)]
  };
}

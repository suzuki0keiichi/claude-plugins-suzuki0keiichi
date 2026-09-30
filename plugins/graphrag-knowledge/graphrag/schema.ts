// --- SchemaDefinition: プリセットで差し替え可能なスキーマ定義 -----------------

export interface SchemaDefinition {
  id: string;
  nodeTypes: readonly string[];
  edgeTypes: readonly string[];
  edgeTypeRules: Record<string, TypeRule[]>;
  stateVocabulary: Partial<Record<string, readonly string[]>>;
  requiredFields: Partial<Record<string, readonly RequiredField[]>>;
  // 型固有の任意属性 (書いてよいが必須ではない)。attribute_check の既知語彙に入る (issue #45)。
  optionalFields?: Partial<Record<string, readonly string[]>>;
  aliases: Record<string, string>;
  categories: {
    knowledge: readonly string[];
    crosscut: readonly string[];
    distilled: readonly string[];       // source backing 必須
    provenance: readonly string[];      // source backing に数える edge type (出自エッジ)
    duplicateCheck: readonly string[];  // 重複検査対象
    staleness: readonly string[];       // 陳腐化検査対象
    premiseCandidate: readonly string[]; // has_premise 候補
    relation: readonly string[];        // relation suggestion 対象
  };
  llmReference: string;
}

export interface RequiredField {
  field: string;
  allowed?: readonly string[];  // closed vocabulary (optional)
}

// v3.3: root scope 型 (System/Product/Project/Business) は撤去 (vault=scope)。
// scope は vault 境界自体が担い、種別はグラフのノード型ではなく vault の属性 (自己紹介)。
export const NODE_TYPES = [
  "File",
  "Decision",
  "RejectedOption",
  "Constraint",
  "Goal",
  "Risk",
  "OperationalKnowledge",
  "Investigation",
  "ConversationChunk",
  "Layer",
  "Concern",
  "Component",
  "Deliverable"
];

// v3.3: contains (唯一の整理エッジ) は撤去。所属は vault の存在と id 規約が既に持つ。
export const EDGE_TYPES = [
  "documented_by",
  "derived_from",
  "has_premise",
  "refines",
  "temporary_relation_candidate",
  "led_to",
  "discussed_in",
  "constrains",
  "sets_policy_for",
  "rejected_in",
  "supersedes",
  "reduces_risk",
  "risks_in",
  "evidenced_by",
  "enforced_by",
  "targets"
];

export type NodeType = typeof NODE_TYPES[number];
export type EdgeType = typeof EDGE_TYPES[number];

type GraphNode = {
  id?: string;
  type?: NodeType;
  [key: string]: unknown;
};

type GraphEdge = {
  id?: string;
  type?: string;
  from?: string;
  to?: string;
  [key: string]: unknown;
};

type GraphLike = {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
};

type AllowedType = NodeType | ReadonlyArray<NodeType>;
type TypeRule = [AllowedType, AllowedType];

const ANY_KNOWLEDGE_NODE: NodeType[] = [
  "Decision",
  "RejectedOption",
  "Constraint",
  "Goal",
  "Risk",
  "OperationalKnowledge",
  "Investigation",
  "ConversationChunk"
];

const ANY_CROSSCUT_NODE: NodeType[] = [
  "Layer",
  "Concern",
  "Component"
];

// 地質メタファー互換 alias。canonical は Layer/Concern/Component。
export const NODE_TYPE_ALIASES: Record<string, NodeType> = {
  Stratum: "Layer",
  Vein: "Concern",
  Pocket: "Component"
};

export function canonicalType(t: string | undefined, schema?: SchemaDefinition): NodeType | undefined {
  const aliases = schema ? schema.aliases : NODE_TYPE_ALIASES;
  return t ? ((aliases[t] ?? t) as NodeType) : undefined;
}

// state 語彙 (型ごとの閉集合)。ここに無い型に state があれば validation failure、
// 語彙外の値も failure (typo ゾンビ — "superceded" 等が現役扱いで残るのを防ぐ)。
// state 無しは常に合法 (Decision/OK は state 無し = 現役)。
export const STATE_VOCABULARY: Partial<Record<NodeType, readonly string[]>> = {
  Investigation: ["active", "closed"],
  Decision: ["superseded"],
  OperationalKnowledge: ["superseded"],
  Goal: ["planned", "active", "achieved", "abandoned"]
};

export const EDGE_TYPE_RULES: Record<EdgeType, TypeRule[]> = {
  // Goal → File は「予約作業は場所に宿る」の配線 (v1.23.0)。「あとで/Step N」を Goal
  // (state: planned) で登記する時、残債が宿るファイルへ documented_by を張ると、
  // その場所を触った commit の delta-check で見出しが浮上する — 「あとでやる、と
  // 言った記憶を毎回失う」への構造的手当て。タスク属性 (期限/担当) は持たせない。
  documented_by: [
    [["Decision", "RejectedOption", "Risk", "OperationalKnowledge", "Investigation", "Deliverable", "Goal"], "File"]
  ],
  derived_from: [
    [["Decision", "RejectedOption", "Risk", "OperationalKnowledge", "Goal", "Investigation"], ["ConversationChunk", "Investigation"]]
  ],
  evidenced_by: [
    [ANY_CROSSCUT_NODE, "File"]
  ],
  // from に Constraint を許すのは debt-shadow パターン (v1.24.0): 「この制約は Goal の
  // 未達を前提とする」— 移行途中の凍結が生む一時制約 (『〇〇を片付けるまで△△は正しく
  // 動かない』) を、作業が宿る場所 (Goal 側) と信じてはいけない場所 (Constraint の
  // constrains 側) の両方に配線するための文法。premise Goal が terminal になったのに
  // 生きている Constraint は stocktake が settled-premise として浮上させる。
  has_premise: [
    [["Decision", "OperationalKnowledge", "Investigation", "Goal", "Constraint"], ["Decision", "OperationalKnowledge", "Constraint", "Risk", "Goal"]]
  ],
  refines: [
    [["Decision", "OperationalKnowledge"], ["Decision", "OperationalKnowledge"]],
    [["Goal"], ["Goal"]]
  ],
  temporary_relation_candidate: [
    [ANY_KNOWLEDGE_NODE, ANY_KNOWLEDGE_NODE]
  ],
  led_to: [
    ["Investigation", "Decision"]
  ],
  discussed_in: [
    ["ConversationChunk", "Investigation"]
  ],
  constrains: [
    ["Constraint", ["Decision", "File", "OperationalKnowledge"]]
  ],
  // Constraint の機械的消費者。宛先 File = その不変条件を破ると落ちる実行可能な検査
  // (テスト / lint 設定 / 型定義)。散文の Constraint はコードが違反しても何も落ちず
  // 「注意力による強制」に縮退する — enforced_by は「破ったら落ちる」を検査から借りる
  // 唯一の結線。無い Constraint は constraint-check が未ガードとして可視化し続ける。
  enforced_by: [
    ["Constraint", "File"]
  ],
  // 横断構造 (Layer/Concern/Component) を宛先に許すのは「この部品/層/関心の全体に効く」
  // という方針/リスクの正しい高度を schema に用意するため。File 集合に張ると後から
  // 増えたファイルに方針が黙って効かなくなる。乱用ガードは高度のはしご (正直で
  // いられる一番低い高度を選ぶ) + 自動付与しない + carving-check の次数 WARN。
  sets_policy_for: [
    ["Decision", ["File", "Investigation", "OperationalKnowledge", "Deliverable", ...ANY_CROSSCUT_NODE]]
  ],
  rejected_in: [
    ["RejectedOption", "Investigation"]
  ],
  supersedes: [
    [["Decision", "OperationalKnowledge"], "RejectedOption"],
    ["Deliverable", "Deliverable"]
  ],
  reduces_risk: [
    [["Decision", "OperationalKnowledge"], "Risk"]
  ],
  risks_in: [
    ["Risk", ["Decision", "File", "OperationalKnowledge", "Investigation", "Deliverable", ...ANY_CROSSCUT_NODE]]
  ],
  targets: [
    ["Goal", "Deliverable"]
  ]
};

/**
 * alias を読む全箇所の共通入口 (issue #43)。aliases は string[] が契約だが、CLI 外の書き手が
 * `aliases: "a,b"` のような文字列を残し得る。読み側は落ちずに扱う: 文字列は単一 alias として
 * (カンマを含む alias があり得るので分割しない)、配列中の非文字列/空文字は捨てる。
 * 永続データは変更しない — 不正形は validateGraph (fsck error / 書き込み拒否) が報告する。
 */
export function nodeAliases(node: { aliases?: unknown } | null | undefined): string[] {
  const raw = node?.aliases;
  if (typeof raw === "string") return raw.length > 0 ? [raw] : [];
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is string => typeof a === "string" && a.length > 0);
}

/** aliases が契約 (string[]、空配列可) を満たしていなければ理由を返す。未設定/null は可。 */
export function aliasesShapeProblem(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return `must be an array of strings, got ${typeof raw}`;
  const bad = raw.findIndex((a) => typeof a !== "string");
  return bad >= 0 ? `must be an array of strings, element ${bad} is ${typeof raw[bad]}` : null;
}

export function validateGraph(graph: GraphLike = {}, schema?: SchemaDefinition): string[] {
  const s = schema ?? DEFAULT_SCHEMA;
  const ids = new Set<string | undefined>();
  const edgeIds = new Set<string | undefined>();
  const failures: string[] = [];
  const nodesById = new Map<string | undefined, GraphNode>();

  for (const node of graph.nodes ?? []) {
    if (!node.id) failures.push("node id is required");
    const nodeType = canonicalType(node.type, s);
    if (node.type && !s.nodeTypes.includes(nodeType as string)) {
      // preset 名を添える: 亜種 preset (principal 等) では「型が存在しない」ことが仕様であり、
      // 書き手 (特に機械 writer) への一次シグナルがこのエラーになる。
      failures.push(`unknown node type: ${node.type} (schema: ${s.id})`);
    }
    if (ids.has(node.id)) failures.push(`duplicate node id: ${node.id}`);
    ids.add(node.id);
    nodesById.set(node.id, { ...node, type: nodeType });

    const requiredFields = nodeType ? s.requiredFields[nodeType] : undefined;
    if (requiredFields) {
      for (const rf of requiredFields) {
        const value = node[rf.field];
        if (value === undefined || value === null || value === "") {
          failures.push(`node ${node.id} (${nodeType}) requires field '${rf.field}'`);
        } else if (rf.allowed && !rf.allowed.includes(value as string)) {
          failures.push(
            `node ${node.id} has invalid ${rf.field}: ${value} (allowed: ${rf.allowed.join(", ")})`
          );
        }
      }
    }

    const aliasProblem = aliasesShapeProblem(node.aliases);
    if (aliasProblem) {
      failures.push(
        `node ${node.id} has invalid aliases: ${aliasProblem} ` +
        `(repair with an op:update that sets aliases to a string array)`
      );
    }

    if (node.state !== undefined && node.state !== null) {
      const vocabulary = nodeType ? s.stateVocabulary[nodeType] : undefined;
      if (!vocabulary) {
        failures.push(`node ${node.id} (${node.type}) must not have state: ${node.state}`);
      } else if (!vocabulary.includes(node.state as string)) {
        failures.push(
          `node ${node.id} has invalid state for ${nodeType}: ${node.state} (allowed: ${vocabulary.join(", ")})`
        );
      }
    }
  }

  for (const edge of graph.edges ?? []) {
    if (!edge.id) failures.push("edge id is required");
    if (edgeIds.has(edge.id)) failures.push(`duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    const edgeType = edge.type as EdgeType | undefined;
    if (edgeType && !s.edgeTypes.includes(edgeType)) failures.push(`unknown edge type: ${edgeType}`);
    if (!ids.has(edge.from)) failures.push(`edge ${edge.id} has missing from node: ${edge.from}`);
    const isCrossVaultRef = typeof edge.to === "string" && edge.to.startsWith("vault:");
    if (!isCrossVaultRef && !ids.has(edge.to)) failures.push(`edge ${edge.id} has missing to node: ${edge.to}`);
    if (ids.has(edge.from) && (ids.has(edge.to) || isCrossVaultRef) && edgeType && s.edgeTypes.includes(edgeType)) {
      if (!isCrossVaultRef) {
        const fromType = nodesById.get(edge.from)?.type;
        const toType = nodesById.get(edge.to)?.type;
        if (!edgeTypeAllows(edgeType, fromType, toType, s)) {
          failures.push(`edge ${edge.id} has invalid type pair for ${edgeType}: ${fromType} -> ${toType}`);
        }
      }
    }
  }

  return failures;
}

function edgeTypeAllows(
  edgeType: EdgeType,
  fromType: NodeType | undefined,
  toType: NodeType | undefined,
  schema?: SchemaDefinition
): boolean {
  const rules = (schema ?? DEFAULT_SCHEMA).edgeTypeRules;
  return (rules[edgeType] ?? []).some(([allowedFrom, allowedTo]) =>
    matchesType(allowedFrom, fromType) && matchesType(allowedTo, toType)
  );
}

function matchesType(allowed: AllowedType, actual: NodeType | undefined): boolean {
  return Array.isArray(allowed) ? allowed.includes(actual) : allowed === actual;
}

// --- DEFAULT_SCHEMA: 現行 system スキーマをそのまま SchemaDefinition に包む ----

export const DEFAULT_SCHEMA: SchemaDefinition = {
  id: "system",
  nodeTypes: NODE_TYPES,
  edgeTypes: EDGE_TYPES,
  edgeTypeRules: EDGE_TYPE_RULES,
  stateVocabulary: STATE_VOCABULARY,
  requiredFields: {},
  aliases: NODE_TYPE_ALIASES,
  categories: {
    knowledge: ANY_KNOWLEDGE_NODE,
    crosscut: ANY_CROSSCUT_NODE,
    distilled: ["Decision", "RejectedOption", "Risk", "OperationalKnowledge"],
    // source backing に数える出自エッジの単一正本 (issue #28)。schema 上正当でも
    // sets_policy_for / risks_in 等の非 provenance edge は backing に数えない。
    provenance: ["documented_by", "derived_from"],
    duplicateCheck: [
      "Decision", "RejectedOption", "Constraint", "Goal", "Risk",
      "OperationalKnowledge", "Investigation", "Concern", "Component", "Layer",
      "Deliverable"
    ],
    staleness: ["Decision", "Constraint", "Risk", "OperationalKnowledge"],
    premiseCandidate: ["Decision", "Constraint", "Goal", "OperationalKnowledge"],
    relation: ["Decision", "OperationalKnowledge", "Risk", "Constraint", "Goal", "RejectedOption"],
  },
  llmReference: ""  // 現行は SKILL.md に静的記載、将来 ask 出力に同梱
};

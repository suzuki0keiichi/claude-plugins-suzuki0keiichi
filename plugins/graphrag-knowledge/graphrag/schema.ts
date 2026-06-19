// --- SchemaDefinition: プリセットで差し替え可能なスキーマ定義 -----------------

export interface SchemaDefinition {
  id: string;
  nodeTypes: readonly string[];
  edgeTypes: readonly string[];
  edgeTypeRules: Record<string, TypeRule[]>;
  stateVocabulary: Partial<Record<string, readonly string[]>>;
  requiredFields: Partial<Record<string, readonly RequiredField[]>>;
  aliases: Record<string, string>;
  categories: {
    knowledge: readonly string[];
    crosscut: readonly string[];
    distilled: readonly string[];       // source backing 必須
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
  documented_by: [
    [["Decision", "RejectedOption", "Risk", "OperationalKnowledge", "Investigation", "Deliverable"], "File"]
  ],
  derived_from: [
    [["Decision", "RejectedOption", "Risk", "OperationalKnowledge", "Goal", "Investigation"], ["ConversationChunk", "Investigation"]]
  ],
  evidenced_by: [
    [ANY_CROSSCUT_NODE, "File"]
  ],
  has_premise: [
    [["Decision", "OperationalKnowledge", "Investigation"], ["Decision", "OperationalKnowledge", "Constraint", "Risk", "Goal"]]
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

export function validateGraph(graph: GraphLike = {}, schema?: SchemaDefinition): string[] {
  const s = schema ?? DEFAULT_SCHEMA;
  const ids = new Set<string | undefined>();
  const edgeIds = new Set<string | undefined>();
  const failures: string[] = [];
  const nodesById = new Map<string | undefined, GraphNode>();

  for (const node of graph.nodes ?? []) {
    if (!node.id) failures.push("node id is required");
    const nodeType = canonicalType(node.type, s);
    if (node.type && !s.nodeTypes.includes(nodeType as string)) failures.push(`unknown node type: ${node.type}`);
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

// --- Project vault schema preset -------------------------------------------
// Schema for time-bounded initiatives (business projects).
// Unlike system vaults (code/product knowledge, passive),
// project vaults actively monitor project health.
//
// Deliverable lives in the system vault. Project vaults reference it via cross-vault ref.
// Qualified IDs of the form vault:<slug>/deliverable:<system>:<slug> are allowed in edge `to`.

import type { SchemaDefinition, RequiredField } from "./schema.ts";

const PROJECT_NODE_TYPES = [
  "Decision",
  "RejectedOption",
  "Risk",
  "Constraint",
  "Goal",
  "OperationalKnowledge",
  "Investigation",
  "ConversationChunk",
  "Source",          // Replaces File. External information sources (URL + freshness management).
  "Theme",           // Replaces Layer/Concern/Component. Cross-project cross-cutting concern.
  "Stakeholder",     // Stakeholder / interested party.
  "Resource",        // People, assets, budget, time.
  "Milestone",       // Time-axis milestone.
  "Assumption",      // Premise / assumption. With certainty level.
  "Agreement",       // External commitment / boundary condition.
  "Task",            // Task at the granularity relevant to decisions.
] as const;

type ProjectNodeType = typeof PROJECT_NODE_TYPES[number];

const KNOWLEDGE_NODES: ProjectNodeType[] = [
  "Decision", "RejectedOption", "Constraint", "Goal", "Risk",
  "OperationalKnowledge", "Investigation", "ConversationChunk",
  "Assumption", "Agreement", "Task",
];

const PROJECT_EDGE_TYPES = [
  // --- provenance (出自・根拠) ---
  "documented_by",       // Decision/RejectedOption/Risk/OK/Agreement → Source
  "derived_from",        // Decision/RejectedOption/Risk/OK/Goal/Assumption/Task → ConversationChunk/Investigation/Source

  // --- judgment / knowledge (判断・知識) ---
  "supersedes",          // Decision/OK → RejectedOption
  "has_premise",         // Decision/OK/Risk/Task/Goal/Assumption → Decision/Constraint/Goal/OK/Assumption/Agreement
  "refines",             // Goal→Goal, Decision→Decision, Task→Task
  "led_to",              // Investigation → Decision/RejectedOption/OK/Risk
  "triggered_by",        // Investigation → Risk/Source/ConversationChunk/Assumption/Stakeholder
  "rejected_in",         // RejectedOption → Investigation

  // --- constraint / risk (制約・リスク) ---
  "constrains",          // Constraint/Agreement → Decision/Task/Goal/OK
  "risks_in",            // Risk → Task/Goal/Milestone
  "reduces_risk",        // Decision/Task → Risk

  // --- planning structure (計画構造) ---
  "achieves",            // Task → Goal
  "depends_on",          // Task→Task, Milestone→Milestone
  "targets",             // Task/Goal → Milestone
  "falls_back_to",       // Task→Task, Goal→Goal (PlanB)
  "requires",            // Task → Resource (period_start/end/allocation optional)

  // --- stakeholder (利害関係者) ---
  "concerned_with",      // Stakeholder → Goal/Decision/Risk/Task/Milestone/Theme
  "responsible_for",     // Stakeholder → Task/Goal/Milestone/Agreement
  "party_to",            // Stakeholder → Agreement

  // --- crosscut (横断) ---
  "encompasses",         // Theme → Goal/Decision/Risk/Task/Resource/Assumption

  // --- infrastructure ---
  "discussed_in",        // ConversationChunk → Investigation
  "temporary_relation_candidate",
] as const;

type ProjectEdgeType = typeof PROJECT_EDGE_TYPES[number];

type AllowedType = ProjectNodeType | ReadonlyArray<ProjectNodeType>;
type TypeRule = [AllowedType, AllowedType];

const EDGE_TYPE_RULES: Record<ProjectEdgeType, TypeRule[]> = {
  documented_by: [
    [["Decision", "RejectedOption", "Risk", "OperationalKnowledge", "Investigation", "Agreement"], "Source"]
  ],
  derived_from: [
    [["Decision", "RejectedOption", "Risk", "OperationalKnowledge", "Goal", "Assumption", "Task", "Investigation"],
     ["ConversationChunk", "Investigation", "Source"]]
  ],
  supersedes: [
    [["Decision", "OperationalKnowledge"], "RejectedOption"]
  ],
  has_premise: [
    [["Decision", "OperationalKnowledge", "Risk", "Task", "Goal", "Assumption"],
     ["Decision", "Constraint", "Goal", "OperationalKnowledge", "Assumption", "Agreement"]]
  ],
  refines: [
    [["Decision", "OperationalKnowledge"], ["Decision", "OperationalKnowledge"]],
    ["Goal", "Goal"],
    ["Task", "Task"]
  ],
  led_to: [
    ["Investigation", ["Decision", "RejectedOption", "OperationalKnowledge", "Risk"]]
  ],
  triggered_by: [
    ["Investigation", ["Risk", "Source", "ConversationChunk", "Assumption", "Stakeholder"]]
  ],
  rejected_in: [
    ["RejectedOption", "Investigation"]
  ],
  constrains: [
    [["Constraint", "Agreement"], ["Decision", "Task", "Goal", "OperationalKnowledge"]]
  ],
  risks_in: [
    ["Risk", ["Task", "Goal", "Milestone"]]
  ],
  reduces_risk: [
    [["Decision", "Task", "OperationalKnowledge"], "Risk"]
  ],
  achieves: [
    ["Task", "Goal"]
  ],
  depends_on: [
    ["Task", "Task"],
    ["Milestone", "Milestone"]
  ],
  targets: [
    [["Task", "Goal"], "Milestone"]
  ],
  falls_back_to: [
    ["Task", "Task"],
    ["Goal", "Goal"]
  ],
  requires: [
    ["Task", "Resource"]
  ],
  concerned_with: [
    ["Stakeholder", ["Goal", "Decision", "Risk", "Task", "Milestone", "Theme"]]
  ],
  responsible_for: [
    ["Stakeholder", ["Task", "Goal", "Milestone", "Agreement"]]
  ],
  party_to: [
    ["Stakeholder", "Agreement"]
  ],
  encompasses: [
    ["Theme", ["Goal", "Decision", "Risk", "Task", "Resource", "Assumption"]]
  ],
  discussed_in: [
    ["ConversationChunk", "Investigation"]
  ],
  temporary_relation_candidate: [
    [KNOWLEDGE_NODES, KNOWLEDGE_NODES]
  ],
};

const STATE_VOCABULARY: Partial<Record<ProjectNodeType, readonly string[]>> = {
  Investigation: ["active", "closed"],
  Decision: ["superseded"],
  OperationalKnowledge: ["superseded"],
  Goal: ["planned", "active", "achieved", "abandoned"],
  Agreement: ["exploring", "negotiating", "signed", "active", "expired"],
  Task: ["planned", "active", "completed", "cancelled"],
  Milestone: ["planned", "achieved", "missed"],
};

const CERTAINTY_LEVELS = ["Established", "Expected", "Assumed", "Speculative"] as const;

const REQUIRED_FIELDS: Partial<Record<ProjectNodeType, readonly RequiredField[]>> = {
  Assumption: [
    { field: "certainty", allowed: CERTAINTY_LEVELS },
  ],
};

export const PROJECT_SCHEMA: SchemaDefinition = {
  id: "project",
  nodeTypes: PROJECT_NODE_TYPES as unknown as readonly string[],
  edgeTypes: PROJECT_EDGE_TYPES as unknown as readonly string[],
  edgeTypeRules: EDGE_TYPE_RULES as Record<string, [string | readonly string[], string | readonly string[]][]>,
  stateVocabulary: STATE_VOCABULARY as Partial<Record<string, readonly string[]>>,
  requiredFields: REQUIRED_FIELDS as Partial<Record<string, readonly RequiredField[]>>,
  aliases: {
    OK: "OperationalKnowledge",
  },
  categories: {
    knowledge: KNOWLEDGE_NODES as unknown as readonly string[],
    crosscut: ["Theme"] as readonly string[],
    distilled: ["Decision", "RejectedOption", "Risk", "OperationalKnowledge", "Agreement"] as readonly string[],
    duplicateCheck: [
      "Decision", "RejectedOption", "Constraint", "Goal", "Risk",
      "OperationalKnowledge", "Investigation", "Assumption", "Agreement",
      "Theme", "Stakeholder", "Resource", "Milestone", "Task",
    ] as readonly string[],
    staleness: ["Decision", "Constraint", "Risk", "OperationalKnowledge", "Agreement", "Assumption"] as readonly string[],
    premiseCandidate: ["Decision", "Constraint", "Goal", "OperationalKnowledge", "Assumption", "Agreement"] as readonly string[],
    relation: ["Decision", "OperationalKnowledge", "Risk", "Constraint", "Goal", "RejectedOption", "Agreement"] as readonly string[],
  },
  llmReference: "",
};


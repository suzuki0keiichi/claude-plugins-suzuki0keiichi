import { readFile } from "node:fs/promises";
import { validateGraph } from "./schema.ts";

export async function loadMutationPlan(planPath) {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  return normalizeMutationPlan(plan);
}

export function normalizeMutationPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("Mutation plan must be an object");
  }
  const nodes = Array.isArray(plan.nodes)
    ? plan.nodes.map((node) => normalizeMutationObject(node, "node"))
    : [];
  const edges = Array.isArray(plan.edges)
    ? plan.edges.map((edge) => normalizeMutationObject(edge, "edge"))
    : [];
  if (nodes.length === 0 && edges.length === 0) {
    throw new Error("Mutation plan must include at least one node or edge");
  }
  return {
    reason: typeof plan.reason === "string" ? plan.reason : "",
    nodes,
    edges,
    duplicate_ack: normalizeDuplicateAck(plan.duplicate_ack)
  };
}

// 重複ゲートの承認 (既存ノード id 列)。形が崩れた ack を黙って落とすと
// 「acked のつもりが reject」になり混乱するので、配列以外・非文字列要素は明示エラー。
function normalizeDuplicateAck(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    throw new Error("mutation plan duplicate_ack must be an array of node id strings");
  }
  return value;
}

export function validateMutation({ currentGraph, plan, enforceSourceBacking = false }) {
  const duplicatePlanNodeIds = duplicates(plan.nodes.map((node) => node.id));
  const duplicatePlanEdgeIds = duplicates(plan.edges.map((edge) => edge.id));
  const currentNodeIds = new Set((currentGraph.nodes ?? []).map((node) => node.id));
  const currentEdgeIds = new Set((currentGraph.edges ?? []).map((edge) => edge.id));
  const createNodeIds = plan.nodes
    .filter((node) => mutationOp(node) === "create")
    .map((node) => node.id)
    .filter((id) => currentNodeIds.has(id));
  const updateNodeIds = plan.nodes
    .filter((node) => mutationOp(node) === "update")
    .map((node) => node.id)
    .filter((id) => !currentNodeIds.has(id));
  const createEdgeIds = plan.edges
    .filter((edge) => mutationOp(edge) === "create")
    .map((edge) => edge.id)
    .filter((id) => currentEdgeIds.has(id));
  const updateEdgeIds = plan.edges
    .filter((edge) => mutationOp(edge) === "update")
    .map((edge) => edge.id)
    .filter((id) => !currentEdgeIds.has(id));
  const deleteNodeFailures = plan.nodes
    .filter((node) => mutationOp(node) === "delete")
    .map((node) => node.id)
    .filter((id) => !currentNodeIds.has(id))
    .map((id) => `cannot delete missing node: ${id}`);
  const deleteEdgeFailures = plan.edges
    .filter((edge) => mutationOp(edge) === "delete")
    .map((edge) => edge.id)
    .filter((id) => !currentEdgeIds.has(id))
    .map((id) => `cannot delete missing edge: ${id}`);
  const immutableFailures = immutableUpdateFailures({ currentGraph, plan });
  const failures = [
    ...duplicatePlanNodeIds.map((id) => `mutation plan has duplicate node id: ${id}`),
    ...duplicatePlanEdgeIds.map((id) => `mutation plan has duplicate edge id: ${id}`),
    ...createNodeIds.map((id) => `node already exists in graph: ${id}`),
    ...createEdgeIds.map((id) => `edge already exists in graph: ${id}`),
    ...updateNodeIds.map((id) => `node does not exist in graph for update: ${id}`),
    ...updateEdgeIds.map((id) => `edge does not exist in graph for update: ${id}`),
    ...deleteNodeFailures,
    ...deleteEdgeFailures,
    ...immutableFailures
  ];

  const audit = { cascadedEdgeIds: [] as string[] };
  const nextGraph = applyMutationToGraph(currentGraph, plan, audit);
  if (enforceSourceBacking) {
    failures.push(...sourceBackingFailures({ plan, nextGraph }));
  }
  failures.push(...validateGraph(nextGraph));

  return {
    valid: failures.length === 0,
    failures,
    nextGraph,
    cascadedEdgeIds: audit.cascadedEdgeIds
  };
}

export function applyMutationToGraph(graph, plan, audit?: { cascadedEdgeIds: string[] }) {
  let nextNodes = [...(graph.nodes ?? [])];
  let nextEdges = [...(graph.edges ?? [])];

  // Pass 1: node create/update. Node deletes (DETACH semantics) are applied
  // after, together with edge deletes, so cascaded edges are removed once.
  const deletedNodeIds = new Set<string>();
  for (const node of plan.nodes) {
    if (mutationOp(node) === "delete") {
      deletedNodeIds.add(node.id);
      continue;
    }
    const index = nextNodes.findIndex((existing) => existing.id === node.id);
    const withOutOp = withoutOp(node);
    if (mutationOp(node) === "create") {
      nextNodes.push(withOutOp);
    } else if (index !== -1) {
      nextNodes[index] = mergeMutationEntity(nextNodes[index], node);
    }
  }

  // Pass 2: edge create/update. Explicit edge deletes are collected.
  const deletedEdgeIds = new Set<string>();
  for (const edge of plan.edges) {
    if (mutationOp(edge) === "delete") {
      deletedEdgeIds.add(edge.id);
      continue;
    }
    const index = nextEdges.findIndex((existing) => existing.id === edge.id);
    const withOutOp = withoutOp(edge);
    if (mutationOp(edge) === "create") {
      nextEdges.push(withOutOp);
    } else if (index !== -1) {
      nextEdges[index] = mergeMutationEntity(nextEdges[index], edge);
    }
  }

  // Apply deletes. Node delete = DETACH: drop the node and cascade-remove every
  // edge touching it. Cascaded edge ids (not explicitly listed for deletion)
  // are recorded for audit so the removal is never silent.
  if (deletedNodeIds.size > 0 || deletedEdgeIds.size > 0) {
    if (deletedNodeIds.size > 0) {
      nextNodes = nextNodes.filter((node) => !deletedNodeIds.has(node.id));
    }
    const cascaded = new Set<string>();
    nextEdges = nextEdges.filter((edge) => {
      if (deletedEdgeIds.has(edge.id)) return false;
      if (deletedNodeIds.has(edge.from) || deletedNodeIds.has(edge.to)) {
        if (edge.id) cascaded.add(edge.id);
        return false;
      }
      return true;
    });
    if (audit) audit.cascadedEdgeIds = [...cascaded];
  } else if (audit) {
    audit.cascadedEdgeIds = [];
  }

  return {
    ...graph,
    version: graph.version ?? 1,
    generated_at: graph.generated_at,
    nodes: nextNodes,
    edges: nextEdges
  };
}


export function mutationOp(item) {
  if (item?.op === "update") return "update";
  if (item?.op === "delete") return "delete";
  return "create";
}

function duplicates(values: unknown[]): unknown[] {
  const seen = new Set();
  const duplicated = new Set();
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) duplicated.add(value);
    seen.add(value);
  }
  return [...duplicated];
}

export function withoutOp(item) {
  const { op: _unused, ...rest } = item;
  return stripNullFields(rest);
}

// plan が値 null を渡したフィールドは「削除」を意味する (例: updates: {state: null} で
// state を取り下げる)。null をそのまま残すと frontmatter に `state: null` が
// 文字どおり書き出されて以後 round-trip し続けるため、graph 層には null を持ち込まない。
function stripNullFields(entity) {
  const out = { ...entity };
  for (const [key, value] of Object.entries(out)) {
    if (value === null) delete out[key];
  }
  return out;
}

export function mergeMutationEntity(current, patch) {
  const merged = {
    ...mutationEntityFields(current),
    ...mutationEntityFields(patch)
  };
  return stripNullFields(merged);
}

function normalizeMutationObject(item, kind) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`mutation ${kind} must be an object`);
  }
  const op = item.op ?? "create";
  if (op !== "create" && op !== "update" && op !== "delete") {
    throw new Error(`mutation ${kind} has invalid op: ${String(op)}`);
  }
  return { ...item, op };
}

function mutationEntityFields(item: any = {}) {
  const { op: _unusedOp, updates, ...rest } = item;
  const updateFields = updates && typeof updates === "object" && !Array.isArray(updates)
    ? updates
    : {};
  return {
    ...rest,
    ...updateFields
  };
}

function immutableUpdateFailures({ currentGraph, plan }) {
  const nodesById = new Map<string, any>((currentGraph.nodes ?? []).map((node) => [node.id, node]));
  const edgesById = new Map<string, any>((currentGraph.edges ?? []).map((edge) => [edge.id, edge]));
  const failures = [];

  for (const node of plan.nodes.filter((item) => mutationOp(item) === "update")) {
    const current = nodesById.get(node.id);
    if (!current) continue;
    const patch = mutationEntityFields(node);
    if (patch.type !== undefined && patch.type !== current.type) {
      failures.push(`node update cannot change type for ${node.id}: ${current.type} -> ${patch.type}`);
    }
  }

  for (const edge of plan.edges.filter((item) => mutationOp(item) === "update")) {
    const current = edgesById.get(edge.id);
    if (!current) continue;
    const patch = mutationEntityFields(edge);
    for (const key of ["type", "from", "to"]) {
      if (patch[key] !== undefined && patch[key] !== current[key]) {
        failures.push(`edge update cannot change ${key} for ${edge.id}: ${current[key]} -> ${patch[key]}`);
      }
    }
  }

  return failures;
}

// Exactly the EDGE_TYPE_RULES.derived_from from-list. Constraint is excluded
// on purpose: the schema gives Constraint no outgoing edge to a source
// (ConversationChunk/Investigation); its provenance is the incoming
// has_premise from a source-backed Decision/OperationalKnowledge. Requiring a
// direct source link for Constraint would be structurally impossible. Legacy
// Constraint damage-control still happens in migrate-raw-content.ts.
const DISTILLED_NODE_TYPES = new Set([
  "Decision",
  "RejectedOption",
  "Risk",
  "OperationalKnowledge"
]);

type GraphNodeLike = {
  id: string;
  type?: string;
  path?: string;
  raw_content?: string;
  raw_content_status?: string;
};
type GraphEdgeLike = { from: string; to: string };

function isQualifyingSource(node: GraphNodeLike | undefined) {
  if (!node) return false;
  if (node.type === "File") {
    return typeof node.path === "string" && node.path.trim().length > 0;
  }
  if (node.type === "ConversationChunk" || node.type === "Investigation") {
    return (
      typeof node.raw_content === "string" &&
      node.raw_content.trim().length > 0 &&
      node.raw_content_status !== "copied_from_summary"
    );
  }
  return false;
}

function sourceBackingFailures({ plan, nextGraph }: { plan: { nodes: { id: string; op?: string }[] }; nextGraph: { nodes?: GraphNodeLike[]; edges?: GraphEdgeLike[] } }) {
  const nodesById = new Map<string, GraphNodeLike>((nextGraph.nodes ?? []).map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of nextGraph.edges ?? []) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }
  const failures = [];
  for (const planNode of plan.nodes) {
    if (mutationOp(planNode) === "delete") continue;
    const node = nodesById.get(planNode.id);
    if (!node || !node.type || !DISTILLED_NODE_TYPES.has(node.type)) continue;
    // Legacy damage-control exception: an explicitly stamped node carries its
    // own copied-from-summary raw_content. This is the honest "unverified
    // legacy" marker; it must be allowed so the migration and benign updates
    // to already-stamped legacy nodes are not blocked.
    if (
      typeof node.raw_content === "string" &&
      node.raw_content.trim().length > 0 &&
      node.raw_content_status === "copied_from_summary"
    ) {
      continue;
    }
    const targets = outgoing.get(node.id) ?? [];
    const ok = targets.some((targetId) => isQualifyingSource(nodesById.get(targetId)));
    if (!ok) {
      failures.push(
        `distilled node ${node.id} has no qualifying source (link it to a ConversationChunk/Investigation with raw_content (status != copied_from_summary), or a File with path)`
      );
    }
  }
  return failures;
}

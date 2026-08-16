import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { validateGraph, DEFAULT_SCHEMA, type SchemaDefinition } from "./schema.ts";

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
    duplicate_ack: normalizeDuplicateAck(plan.duplicate_ack),
    successors: normalizeSuccessors(plan.successors)
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

// 削除ノードの後継 (301) 対応。delete+create+対応付けを1コミットで原子化するための
// 入力で、tombstone 台帳の successor に記録される。形が崩れた対応は黙って落とすと
// 「301 を書いたつもりが台帳に無い」になるので明示エラー。
function normalizeSuccessors(value: unknown): Array<{ old: string; new: string }> {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.some((s) => typeof s?.old !== "string" || typeof s?.new !== "string")
  ) {
    throw new Error('mutation plan successors must be an array of { "old": <node id>, "new": <node id> }');
  }
  return value.map((s) => ({ old: s.old, new: s.new }));
}

// ── idempotent replay (issue #24) ────────────────────────────────────────────
//
// 書き込みのリトライ (タイムアウト後の再実行等) を毒にしない: op:create で id が既存、
// かつ plan の内容が既存エンティティと実質同一 (generated_at を除く全フィールドが
// deep-equal) なら、それは「既に成功した書き込みの再送」なので失敗ではなく no-op と
// して吸収する。内容が違う create-on-existing は従来どおり validateMutation が
// fail-loud する (それは再送ではなく衝突)。
//
// 判定は plan 側が持つフィールドのみ比較する (既存ノードにだけある indexer 付与
// フィールド等は再送の否定材料にしない)。generated_at は書き込み時に打刻される値
// なので比較から除外する。
export function partitionIdempotentReplays(
  plan: any,
  currentGraph: any
): { plan: any; replayedNodeIds: string[]; replayedEdgeIds: string[] } {
  const nodesById = new Map<string, any>((currentGraph.nodes ?? []).map((n: any) => [n.id, n]));
  const edgesById = new Map<string, any>((currentGraph.edges ?? []).map((e: any) => [e.id, e]));

  const isNodeReplay = (item: any): boolean => {
    if (mutationOp(item) !== "create") return false;
    const existing = nodesById.get(item.id);
    if (!existing) return false;
    const fields = withoutOp(item);
    for (const [key, value] of Object.entries(fields)) {
      if (key === "generated_at") continue;
      if (!isDeepStrictEqual(existing[key], value)) return false;
    }
    return true;
  };
  const isEdgeReplay = (item: any): boolean => {
    if (mutationOp(item) !== "create") return false;
    const existing = edgesById.get(item.id);
    if (!existing) return false;
    return (
      existing.type === item.type && existing.from === item.from && existing.to === item.to
    );
  };

  const replayedNodeIds = plan.nodes.filter(isNodeReplay).map((n: any) => String(n.id));
  const replayedEdgeIds = plan.edges.filter(isEdgeReplay).map((e: any) => String(e.id));
  if (replayedNodeIds.length === 0 && replayedEdgeIds.length === 0) {
    return { plan, replayedNodeIds, replayedEdgeIds };
  }
  const replayedNodes = new Set(replayedNodeIds);
  const replayedEdges = new Set(replayedEdgeIds);
  return {
    plan: {
      ...plan,
      nodes: plan.nodes.filter((n: any) => !replayedNodes.has(String(n.id)) || mutationOp(n) !== "create"),
      edges: plan.edges.filter((e: any) => !replayedEdges.has(String(e.id)) || mutationOp(e) !== "create")
    },
    replayedNodeIds,
    replayedEdgeIds
  };
}

export function validateMutation({ currentGraph, plan, enforceSourceBacking = false, schema }: {
  currentGraph: any; plan: any; enforceSourceBacking?: boolean; schema?: SchemaDefinition;
}) {
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
    ...createNodeIds.map(
      (id) =>
        `node already exists in graph: ${id} (this plan's content DIFFERS from the existing node — ` +
        `an identical re-send would have been absorbed as an idempotent replay; ` +
        `to change the node, re-send as {"op":"update","id":"${id}","updates":{...}})`
    ),
    ...createEdgeIds.map(
      (id) =>
        `edge already exists in graph: ${id} (same id but different type/from/to — ` +
        `identical re-sends are absorbed as idempotent replays)`
    ),
    ...updateNodeIds.map((id) => `node does not exist in graph for update: ${id}`),
    ...updateEdgeIds.map((id) => `edge does not exist in graph for update: ${id}`),
    ...deleteNodeFailures,
    ...deleteEdgeFailures,
    ...immutableFailures
  ];

  const audit = { cascadedEdgeIds: [] as string[], cascadedEdges: [] as any[] };
  const nextGraph = applyMutationToGraph(currentGraph, plan, audit);
  failures.push(...successorFailures({ plan, nextGraph }));
  if (enforceSourceBacking) {
    failures.push(...sourceBackingFailures({ plan, nextGraph, schema }));
  }
  failures.push(...validateGraph(nextGraph, schema));

  return {
    valid: failures.length === 0,
    failures,
    nextGraph,
    cascadedEdgeIds: audit.cascadedEdgeIds,
    cascadedEdges: audit.cascadedEdges,
    attributeWarnings: unknownAttributeWarnings({ currentGraph, plan, schema })
  };
}

// --- unknown attribute warnings (issue #20) --------------------------------
//
// updates/create の属性名は型 (node type / edge type) と違い意図的なモデル外キーの
// 運用があるため reject できない。代わりに「既存エンティティのキーでも、mutation
// 書き手の既知語彙でもない属性名」を WARN として返し、typo (summary_append 等) に
// その場で気付けるようにする。null 値は「キー削除」の正当な文法なので、未知キーへの
// null (= 迷い込んだキーの掃除そのもの) は警告しない。
//
// この語彙は「mutation plan が正当に新設する属性」であり、indexer (index-codebase)
// が File ノードへ書く属性群 (role / imports / exported_symbols …) は含めない —
// それらの更新は current-entity キー例外で通り、plan からの新設は警告対象で正しい。
const MUTATION_NODE_ATTRIBUTES = [
  "id", "type", "title", "summary", "description", "state",
  "aliases", "tags", "display", "path",
  "raw_content", "raw_content_status", "generated_at",
  "enforcement", "enforcement_reason"
];
const MUTATION_EDGE_ATTRIBUTES = ["id", "type", "from", "to"];

export interface AttributeWarning {
  entity: "node" | "edge";
  id: string;
  key: string;
  did_you_mean?: string;
  message: string;
}

function knownNodeAttributes(schema?: SchemaDefinition): Set<string> {
  const known = new Set(MUTATION_NODE_ATTRIBUTES);
  // preset 固有の必須フィールド (project の certainty 等) は schema 定義から導出する。
  // preset を足した時にこの警告語彙を別途保守しなくて済むようにするため。
  const s = schema ?? DEFAULT_SCHEMA;
  for (const fields of Object.values(s.requiredFields)) {
    for (const rf of fields ?? []) known.add(rf.field);
  }
  return known;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return dp[a.length];
}

// typo 候補: 片方がもう片方を含む (summary_append ⊃ summary) か、編集距離 2 以内。
function nearestAttribute(key: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const cand of candidates) {
    if (cand === key) continue;
    const contains =
      (key.length >= 4 && cand.length >= 4) && (key.includes(cand) || cand.includes(key));
    const dist = levenshtein(key, cand);
    const score = contains ? Math.min(dist, 2) : dist;
    if (score <= 2 && score < bestScore) {
      best = cand;
      bestScore = score;
    }
  }
  return best;
}

function attributeWarning(args: {
  entity: "node" | "edge";
  id: string;
  key: string;
  op: string;
  entityType: string | undefined;
  candidates: Iterable<string>;
}): AttributeWarning {
  const { entity, id, key, op, entityType } = args;
  const didYouMean = nearestAttribute(key, args.candidates);
  const where = op === "update" ? `updates key '${key}'` : `attribute '${key}'`;
  const repairTarget = didYouMean ?? "<intended attribute>";
  const message =
    `${where} on ${entity} ${id}${entityType ? ` (${entityType})` : ""} is not an existing ` +
    `attribute of that ${entity} and not a known model attribute — it was written verbatim as a ` +
    `NEW frontmatter key. 'updates' replaces whole attributes by exact name; no append/merge ` +
    `key variants exist.` +
    (didYouMean ? ` Did you mean '${didYouMean}'?` : "") +
    ` If this is a typo, repair with: {"op":"update","id":"${id}","updates":` +
    `{"${repairTarget}":"<full new value>","${key}":null}} (null deletes the stray key).` +
    ` If this out-of-model key is intentional, ignore this warning (it round-trips as-is).`;
  return {
    entity,
    id,
    key,
    ...(didYouMean ? { did_you_mean: didYouMean } : {}),
    message
  };
}

export function unknownAttributeWarnings(args: {
  currentGraph: any;
  plan: any;
  schema?: SchemaDefinition;
}): AttributeWarning[] {
  const { currentGraph, plan, schema } = args;
  const knownNode = knownNodeAttributes(schema);
  const nodesById = new Map<string, any>((currentGraph.nodes ?? []).map((n: any) => [n.id, n]));
  const edgesById = new Map<string, any>((currentGraph.edges ?? []).map((e: any) => [e.id, e]));
  const warnings: AttributeWarning[] = [];

  const check = (
    entity: "node" | "edge",
    item: any,
    known: Set<string>,
    current: any | undefined
  ) => {
    const currentKeys = current ? Object.keys(current) : [];
    const patch = mutationEntityFields(item);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) continue; // key deletion — the repair verb itself, never warn
      if (known.has(key)) continue;
      if (current && key in current) continue; // updating an intentional out-of-model key
      warnings.push(
        attributeWarning({
          entity,
          id: String(item.id),
          key,
          op: mutationOp(item),
          entityType: current?.type ?? patch.type,
          candidates: [...known, ...currentKeys]
        })
      );
    }
  };

  const knownEdge = new Set(MUTATION_EDGE_ATTRIBUTES);
  for (const node of plan.nodes ?? []) {
    if (mutationOp(node) === "delete") continue;
    check("node", node, knownNode, nodesById.get(node.id));
  }
  for (const edge of plan.edges ?? []) {
    if (mutationOp(edge) === "delete") continue;
    check("edge", edge, knownEdge, edgesById.get(edge.id));
  }
  return warnings;
}

// successors (301) の妥当性: old はこの plan で delete されるノード、new は mutation 後の
// グラフに実在するノードに限る。ここを緩めると「台帳に書いた後継が最初から解決不能」
// という自己矛盾した tombstone が生まれるため、typo をこの時点で fail-loud に弾く。
function successorFailures(args: { plan: any; nextGraph: any }): string[] {
  const successors: Array<{ old: string; new: string }> = args.plan.successors ?? [];
  if (successors.length === 0) return [];
  const failures: string[] = [];
  const deletedIds = new Set(
    args.plan.nodes.filter((n: any) => mutationOp(n) === "delete").map((n: any) => n.id)
  );
  const nextIds = new Set((args.nextGraph.nodes ?? []).map((n: any) => n.id));
  for (const dup of duplicates(successors.map((s) => s.old))) {
    failures.push(`mutation plan successors has duplicate old id: ${dup}`);
  }
  for (const s of successors) {
    if (!deletedIds.has(s.old)) {
      failures.push(`successor old node is not deleted by this plan: ${s.old}`);
    }
    if (!nextIds.has(s.new)) {
      failures.push(`successor new node does not exist after mutation: ${s.new}`);
    }
  }
  return failures;
}

export function applyMutationToGraph(
  graph,
  plan,
  audit?: { cascadedEdgeIds: string[]; cascadedEdges?: any[] }
) {
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
      const current = nextNodes[index];
      const merged = mergeMutationEntity(current, node);
      // op:update = 「今この時点で再検証された」。ただし generated_at を進めてよいのは
      // 実際に中身が変わった時だけ。無変更 patch まで進めると re-apply のたびに
      // 内容が動き、writeVaultDelta の差分検知が誤爆して無用な vault commit と
      // OCC の stale base 誤判定を生む (update idempotence の破壊)。
      // plan が generated_at を明示した場合は「他が無変更でも」その値を必ず尊重する
      // (明示的な再検証スタンプは正当な更新)。
      const patchStampsGeneratedAt = mutationEntityFields(node).generated_at !== undefined;
      if (patchStampsGeneratedAt) {
        nextNodes[index] = merged;
      } else if (entityContentChanged(current, merged)) {
        nextNodes[index] = { ...merged, generated_at: new Date().toISOString() };
      } else {
        nextNodes[index] = merged;
      }
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
    // カスケードされたエッジは id だけでなく全タプルも残す — 消えたエッジは grep でも
    // 引けなくなるので、tombstone 台帳が「後継へ張り直す」修復材料として from/to/type を持つ。
    const cascadedEdges: any[] = [];
    nextEdges = nextEdges.filter((edge) => {
      if (deletedEdgeIds.has(edge.id)) return false;
      if (deletedNodeIds.has(edge.from) || deletedNodeIds.has(edge.to)) {
        if (edge.id) cascaded.add(edge.id);
        cascadedEdges.push({ id: edge.id, type: edge.type, from: edge.from, to: edge.to });
        return false;
      }
      return true;
    });
    if (audit) {
      audit.cascadedEdgeIds = [...cascaded];
      audit.cascadedEdges = cascadedEdges;
    }
  } else if (audit) {
    audit.cascadedEdgeIds = [];
    audit.cascadedEdges = [];
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

// generated_at を進めるべきかの判定材料。generated_at 自体はここでは無視する
// (それを進めるかどうかを決めるための比較なので、それ自身の差は判定に使えない)。
function entityContentChanged(current, merged) {
  const keys = new Set([...Object.keys(current), ...Object.keys(merged)]);
  keys.delete("generated_at");
  for (const key of keys) {
    if (!isDeepStrictEqual(current[key], merged[key])) return true;
  }
  return false;
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

// categories.distilled (source backing 必須型) から取得。
// Constraint は除外 (schema が Constraint に source への outgoing edge を持たないため)。

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

function sourceBackingFailures({ plan, nextGraph, schema }: { plan: { nodes: { id: string; op?: string }[] }; nextGraph: { nodes?: GraphNodeLike[]; edges?: GraphEdgeLike[] }; schema?: SchemaDefinition }) {
  const DISTILLED_NODE_TYPES = new Set((schema ?? DEFAULT_SCHEMA).categories.distilled);
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

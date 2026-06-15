export type GraphNode = {
  id?: string;
  type?: string;
  [key: string]: unknown;
};

export type GraphEdge = {
  id?: string;
  type?: string;
  from?: string;
  to?: string;
  [key: string]: unknown;
};

export type GraphLike = {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
};

export type PropertyDiff = Record<string, { before: unknown; after: unknown }>;

export type NodeModification = {
  id: string;
  before: GraphNode;
  after: GraphNode;
  propertyDiff: PropertyDiff;
};

export type EdgeModification = {
  id: string;
  before: GraphEdge;
  after: GraphEdge;
  propertyDiff: PropertyDiff;
};

export type GraphDiff = {
  nodes: {
    added: GraphNode[];
    removed: GraphNode[];
    modified: NodeModification[];
  };
  edges: {
    added: GraphEdge[];
    removed: GraphEdge[];
    modified: EdgeModification[];
  };
};

export function graphDiff(base: GraphLike, current: GraphLike): GraphDiff {
  const nodeDelta = diffById<GraphNode, NodeModification>(
    base.nodes ?? [],
    current.nodes ?? [],
    (id, before, after, propertyDiff) => ({ id, before, after, propertyDiff })
  );
  const edgeDelta = diffById<GraphEdge, EdgeModification>(
    base.edges ?? [],
    current.edges ?? [],
    (id, before, after, propertyDiff) => ({ id, before, after, propertyDiff })
  );

  return { nodes: nodeDelta, edges: edgeDelta };
}

type WithId = { id?: string };

function diffById<TItem extends WithId, TModification>(
  baseItems: TItem[],
  currentItems: TItem[],
  buildModification: (
    id: string,
    before: TItem,
    after: TItem,
    propertyDiff: PropertyDiff
  ) => TModification
) {
  const baseById = indexById(baseItems);
  const currentById = indexById(currentItems);

  const added: TItem[] = [];
  const removed: TItem[] = [];
  const modified: TModification[] = [];

  for (const item of baseItems) {
    if (item.id == null) continue;
    if (!currentById.has(item.id)) removed.push(item);
  }

  for (const item of currentItems) {
    if (item.id == null) continue;
    const before = baseById.get(item.id);
    if (!before) {
      added.push(item);
      continue;
    }
    const propertyDiff = diffProperties(before, item);
    if (Object.keys(propertyDiff).length > 0) {
      modified.push(buildModification(item.id, before, item, propertyDiff));
    }
  }

  return { added, removed, modified };
}

function indexById<T extends WithId>(items: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (item.id == null) continue;
    map.set(item.id, item);
  }
  return map;
}

function diffProperties(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): PropertyDiff {
  const propertyDiff: PropertyDiff = {};
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === "id") continue;
    const beforeValue = before[key];
    const afterValue = after[key];
    if (!deepEqual(beforeValue, afterValue)) {
      propertyDiff[key] = { before: beforeValue, after: afterValue };
    }
  }
  return propertyDiff;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, key)) return false;
    if (!deepEqual(ao[key], bo[key])) return false;
  }
  return true;
}

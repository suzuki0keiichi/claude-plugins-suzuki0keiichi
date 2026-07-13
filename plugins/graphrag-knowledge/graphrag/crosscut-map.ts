/**
 * crosscut-map: 横断構造 (Component/Layer/Concern) を「地図」として機械算出する純関数群。
 *
 * 元フィードバックの読み側非対称への手当て: 構造ノードは「コードを書くその瞬間に照合される」
 * 時にしか価値を出せないのに、その瞬間に発火する仕組みが無かった。ここでは裁く (gate) のでは
 * なく地図を見せる (reference) 向きで3点に配線する:
 *   ① ask 出力に area_map を同乗させる (設計時 — 発火実績のあるトリガーに載せる)
 *   ② 新規ファイル作成時の hook に局所地図を注入する (配置時 — 非難なし)
 *   ③ frame-check の高精度2判定のみ所見化する (縄張り内未配線 / クラスタ閾値超え)
 *
 * 「どこにも属さない = 悪」とはしない: 小さいクラスタは Component を彫らないのが carving の
 * 思想なので、無所属は正当。判定は誤報率の低い2ケースに限る。
 *
 * 縄張り (footprint) = Component のメンバー File (evidenced_by 宛先) のディレクトリ集合。
 * フラット配置では複数 Component の縄張りが重なる → 一意 claimant を要求する判定は発火しない
 * (誤発砲より沈黙を選ぶ)。地図表示 (claimants 列挙) は重なっていても価値がある。
 */

import { canonicalType } from "./schema.ts";

type AnyNode = Record<string, unknown> & { id?: unknown; type?: unknown };
type AnyEdge = Record<string, unknown> & { type?: unknown; from?: unknown; to?: unknown };
type GraphLike = { nodes: AnyNode[]; edges: AnyEdge[] };

export interface CrosscutRef {
  id: string;
  type: string; // Component | Layer | Concern
  title: string;
}

export interface CrosscutIndex {
  /** File ノード id → 所属する横断構造 (evidenced_by: crosscut → File の逆引き) */
  membershipByFileId: Map<string, CrosscutRef[]>;
  /** File path (POSIX, repo-root 相対) → File ノード id */
  fileIdByPath: Map<string, string>;
  /** File ノード id → path */
  pathByFileId: Map<string, string>;
  /** Component id → 縄張り: dir → そのdir内メンバー数。memberCount は総メンバー数 */
  componentFootprints: Map<string, { ref: CrosscutRef; dirs: Map<string, number>; memberCount: number }>;
}

const CROSSCUT_TYPES = new Set(["Component", "Layer", "Concern"]);

/** 知識ノード → File の「所在を示す」エッジ (area 展開に使う)。evidenced_by は含めない
 *  (crosscut がマッチした場合にメンバー全 File へ膨らませない — crosscut 自体を地図に載せる)。 */
const KNOWLEDGE_TO_FILE_EDGES = new Set(["documented_by", "sets_policy_for", "constrains", "enforced_by", "risks_in"]);

function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "." : p.slice(0, i);
}

function refOf(node: AnyNode): CrosscutRef {
  return {
    id: String(node.id),
    type: canonicalType(node.type as string) ?? String(node.type),
    title: String(node.title ?? node.id)
  };
}

export function buildCrosscutIndex(graph: GraphLike): CrosscutIndex {
  const nodesById = new Map<string, AnyNode>();
  for (const n of graph.nodes) if (typeof n.id === "string") nodesById.set(n.id, n);

  const membershipByFileId = new Map<string, CrosscutRef[]>();
  const fileIdByPath = new Map<string, string>();
  const pathByFileId = new Map<string, string>();
  const componentFootprints = new Map<string, { ref: CrosscutRef; dirs: Map<string, number>; memberCount: number }>();

  for (const n of graph.nodes) {
    if (typeof n.id !== "string") continue;
    if (canonicalType(n.type as string) === "File" && typeof n.path === "string") {
      fileIdByPath.set(n.path as string, n.id);
      pathByFileId.set(n.id, n.path as string);
    }
  }

  for (const e of graph.edges) {
    if (e.type !== "evidenced_by" || typeof e.from !== "string" || typeof e.to !== "string") continue;
    const from = nodesById.get(e.from);
    if (!from) continue;
    const fromType = canonicalType(from.type as string) ?? "";
    if (!CROSSCUT_TYPES.has(fromType)) continue;
    const ref = refOf(from);
    if (!membershipByFileId.has(e.to)) membershipByFileId.set(e.to, []);
    membershipByFileId.get(e.to)!.push(ref);

    if (fromType === "Component") {
      const p = pathByFileId.get(e.to);
      if (!componentFootprints.has(e.from)) {
        componentFootprints.set(e.from, { ref, dirs: new Map(), memberCount: 0 });
      }
      const fp = componentFootprints.get(e.from)!;
      fp.memberCount += 1;
      if (p) {
        const dir = posixDirname(p);
        fp.dirs.set(dir, (fp.dirs.get(dir) ?? 0) + 1);
      }
    }
  }

  return { membershipByFileId, fileIdByPath, pathByFileId, componentFootprints };
}

// ── ① ask 同乗用: area map ────────────────────────────────────────────────────

export interface AreaMapCrosscut extends CrosscutRef {
  files_in_scope: number;
  files_total: number;
  matched_directly?: boolean; // 横断構造ノード自体が検索にヒットした
}

export interface AreaMap {
  crosscuts: AreaMapCrosscut[];
  /** scope 内で、どの横断構造にも属さない File (無所属は正当 — 情報として出すだけ) */
  unframed_files: { id: string; path: string | null }[];
  unframed_overflow: number;
  note: string;
}

const AREA_MAP_CAP = 8;

/**
 * ask がヒットさせたノード集合から「今回触る領域の登記済み構造」を集計する。
 * scope File = ヒットした File + ヒットした知識ノードの所在エッジが指す File。
 */
export function buildAreaMap(graph: GraphLike, scopeNodeIds: Iterable<string>): AreaMap {
  const index = buildCrosscutIndex(graph);
  const nodesById = new Map<string, AnyNode>();
  for (const n of graph.nodes) if (typeof n.id === "string") nodesById.set(n.id, n);

  const scope = new Set(scopeNodeIds);
  const scopeFileIds = new Set<string>();
  const directCrosscuts = new Map<string, CrosscutRef>();

  for (const id of scope) {
    const n = nodesById.get(id);
    if (!n) continue;
    const t = canonicalType(n.type as string) ?? "";
    if (t === "File") scopeFileIds.add(id);
    else if (CROSSCUT_TYPES.has(t)) directCrosscuts.set(id, refOf(n));
  }
  for (const e of graph.edges) {
    if (typeof e.type !== "string" || !KNOWLEDGE_TO_FILE_EDGES.has(e.type)) continue;
    if (typeof e.from !== "string" || typeof e.to !== "string") continue;
    if (!scope.has(e.from)) continue;
    const toNode = nodesById.get(e.to);
    if (toNode && canonicalType(toNode.type as string) === "File") scopeFileIds.add(e.to);
  }

  // 集計: crosscut id → scope 内メンバー数
  const inScope = new Map<string, { ref: CrosscutRef; count: number }>();
  const unframed: { id: string; path: string | null }[] = [];
  for (const fid of scopeFileIds) {
    const memberships = index.membershipByFileId.get(fid) ?? [];
    if (memberships.length === 0) {
      unframed.push({ id: fid, path: index.pathByFileId.get(fid) ?? null });
      continue;
    }
    for (const ref of memberships) {
      if (!inScope.has(ref.id)) inScope.set(ref.id, { ref, count: 0 });
      inScope.get(ref.id)!.count += 1;
    }
  }

  // 総メンバー数 (files_total) を1パスで数える
  const totals = new Map<string, number>();
  for (const members of index.membershipByFileId.values()) {
    for (const ref of members) totals.set(ref.id, (totals.get(ref.id) ?? 0) + 1);
  }

  const crosscuts: AreaMapCrosscut[] = [];
  for (const { ref, count } of inScope.values()) {
    crosscuts.push({ ...ref, files_in_scope: count, files_total: totals.get(ref.id) ?? count, ...(directCrosscuts.has(ref.id) ? { matched_directly: true } : {}) });
  }
  for (const [id, ref] of directCrosscuts) {
    if (!inScope.has(id)) crosscuts.push({ ...ref, files_in_scope: 0, files_total: totals.get(id) ?? 0, matched_directly: true });
  }
  crosscuts.sort((a, b) => (b.matched_directly ? 1 : 0) - (a.matched_directly ? 1 : 0) || b.files_in_scope - a.files_in_scope || a.id.localeCompare(b.id));

  const cappedCrosscuts = crosscuts.slice(0, AREA_MAP_CAP);
  const cappedUnframed = unframed.slice(0, AREA_MAP_CAP);
  return {
    crosscuts: cappedCrosscuts,
    unframed_files: cappedUnframed,
    unframed_overflow: Math.max(0, unframed.length - cappedUnframed.length),
    note:
      crosscuts.length === 0
        ? "No registered crosscut structure touches this area (that can be legitimate — small clusters don't earn a Component). If you are about to add code here, consult the map before choosing a home; frame-check gives per-path claimants."
        : "Registered structure covering the area you are about to touch. Place new code inside the frame it belongs to; if it starts a genuinely new concept, register the frame (Component/Layer/Concern) instead of squatting."
  };
}

// ── ②③ 配置判定用: claimant / 実装ファイル判定 ────────────────────────────────

/** 拡張子ベースの実装ファイル判定 (indexer role が無い生パス用の近似)。 */
const IMPL_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "py", "go", "rs", "java", "kt", "kts", "rb", "php", "cs",
  "c", "cc", "cpp", "h", "hpp", "m", "mm", "swift", "scala",
  "sh", "bash", "zsh", "pl", "lua", "sql"
]);

export function isImplPath(relPath: string): boolean {
  if (relPath.endsWith(".d.ts")) return false; // ambient 型定義は配置判定の対象外
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return IMPL_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

export interface ClaimantResult {
  /** dir を縄張りに持つ Component 群 (dir 内メンバー数の降順) */
  candidates: { ref: CrosscutRef; dir_members: number }[];
  /** 縄張りが一意 (このdirにメンバーを持つ Component がちょうど1つ) の場合のみ */
  unique: CrosscutRef | null;
}

/** relPath のディレクトリを縄張りに持つ Component を探す。フラット配置では複数返る (unique=null)。 */
export function claimantsForPath(index: CrosscutIndex, relPath: string): ClaimantResult {
  const dir = posixDirname(relPath);
  const candidates: { ref: CrosscutRef; dir_members: number }[] = [];
  for (const fp of index.componentFootprints.values()) {
    const n = fp.dirs.get(dir);
    if (n && n > 0) candidates.push({ ref: fp.ref, dir_members: n });
  }
  candidates.sort((a, b) => b.dir_members - a.dir_members || a.ref.id.localeCompare(b.ref.id));
  return { candidates, unique: candidates.length === 1 ? candidates[0].ref : null };
}

// Decision / OperationalKnowledge / Risk が「触るべき File」を embedding 近接で機械抽出
//
// 動機: indexer は File ノードだけ作り、Decision/OK/Risk は LLM concept pass で
// 後から乗せる構造。そのため Decision 作成時点では実装ファイルへの sets_policy_for
// 紐付けが系統的に漏れる (実証: VDU で 56/78 件)。
//
// 本コマンドは各 knowledge ノードの embedding ベクトルと全 File の embedding 間の
// cosine similarity を計算し、top N 個を候補として出力する。LLM concept pass が
// この JSON を読んで「妥当なら sets_policy_for を張る」mutation を作る。
//
// 機械が出すのは素材 (近接候補)、解釈は LLM。Concern との直接エッジは schema 上
// 不可なので、対象は Decision / OperationalKnowledge / Risk のみ。
import fs from "node:fs";
import { canonicalType } from "./schema.ts";
// relations モードは write-time の relations 副産物 (duplicate-check) と同じ帯・同じ思想。
// 閾値はあちらの単一正本を import して共有する (band がズレると「書けたのに後で別基準」になる)。
import { RELATION_BAND_LOW, RELATION_BAND_HIGH } from "./duplicate-check.ts";

// ── E0 書き込み時 binding 提案の中核 ──────────────────────────────────────
// suggest-policy-edges の CLI も書き込み時提案 (mutate-vault) も、同じ
// 「knowledge ノード embedding ↔ File embedding の近接候補列挙」を行う。
// 中核を suggestBindingsForNodes に切り出し、CLI verb と提案器の両方から呼ぶ。
//
// 提案エッジ型は knowledge 型ごとに固定 (契約 E0):
//   Decision → sets_policy_for / Risk → risks_in / OK → documented_by /
//   Constraint → constrains。
// 機械が出すのは候補 (近接 File) のみ。エッジを張るのは LLM/人間 (自動付与しない)。
export const BINDING_EDGE_TYPE_BY_NODE: Record<string, string> = {
  Decision: "sets_policy_for",
  Risk: "risks_in",
  OperationalKnowledge: "documented_by",
  Constraint: "constrains",
};

// typed-add verb は知識型ごとに違う。binding 候補に「そのまま実行できる確定手段」を
// 添えるため、型 → verb と紐付けフラグの対応をここで持つ。
const BINDING_VERB_BY_NODE: Record<string, { verb: string; flag: string }> = {
  Decision: { verb: "add-decision", flag: "--sets-policy-for" },
  Risk: { verb: "add-risk", flag: "--risks-in" },
  OperationalKnowledge: { verb: "add-ok", flag: "--documented-by" },
  Constraint: { verb: "add-constraint", flag: "--constrains" },
};

function vnorm(v: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += v[i] * v[i];
  return Math.sqrt(s);
}

// docs/knowhow/plans/design-decisions の File は「出所」であって実装ファイルではない。
// binding (方針が効く実装) の候補からは除外する (suggest-policy-edges の従来基準と一致)。
function isImplFileId(id: string): boolean {
  return id.startsWith("file:") && !/docs\/knowhow\/|plans\/|docs\/design-decisions\//.test(id);
}

export type BindingCandidate = {
  file_id: string;
  path?: string;
  title?: string;
  similarity: number;
  // LLM/人間がそのまま実行できる確定手段 (typed-add フラグ断片)。
  apply: { verb: string; flag: string; example: string };
};

export type NodeBindingSuggestion = {
  node_id: string;
  node_type: string;
  edge_type: string; // 型固定 (BINDING_EDGE_TYPE_BY_NODE)
  candidates: BindingCandidate[];
};

/**
 * 与えられた knowledge ノード集合 (Decision/Risk/OK/Constraint) について、vector index の
 * File 行と embedding cosine を計算し threshold 以上の top N を binding 候補として返す。
 *
 * - embed は contract の embedForIndex(vectorIndex, text, "document") 相当を DI で受ける
 *   (テストは endpoint 非依存)。新ノードは索引にまだ無いのでその場で埋め込む。
 * - index / File 行不在は空配列で skip (reason は呼び出し元が組む)。エッジは決して張らない。
 */
export async function suggestBindingsForNodes(args: {
  vectorIndex: { rows?: any[] } | null | undefined;
  nodes: any[];
  embed: (text: string) => Promise<number[]>;
  threshold?: number;
  topN?: number;
}): Promise<NodeBindingSuggestion[]> {
  const threshold = args.threshold ?? 0.7;
  const topN = args.topN ?? 5;
  const rows: any[] = Array.isArray(args.vectorIndex?.rows) ? args.vectorIndex!.rows! : [];

  // 索引行から File の embedding を引く。型は索引行に無いので node_id の prefix で判定。
  const fileRows = rows.filter(
    (r) => typeof r?.node_id === "string" && Array.isArray(r?.vector) && isImplFileId(r.node_id)
  );
  if (fileRows.length === 0) return [];
  const fileNorm = new Map<string, number>(fileRows.map((r) => [r.node_id, vnorm(r.vector)]));
  // path/title は索引行が持つこともあるが保証されないので best-effort。
  const fileMeta = new Map<string, { path?: string; title?: string }>(
    fileRows.map((r) => [r.node_id, { path: r.path, title: r.title }])
  );

  const out: NodeBindingSuggestion[] = [];
  for (const node of args.nodes) {
    const ctype = canonicalType(node?.type);
    if (!ctype || !BINDING_EDGE_TYPE_BY_NODE[ctype]) continue;
    const text = [node.title, node.summary, node.description]
      .filter((v) => typeof v === "string" && v.trim().length > 0)
      .join(" ");
    if (!text) continue;
    const vec = await args.embed(text);
    const nNorm = vnorm(vec);
    if (nNorm === 0) continue;

    const cands: BindingCandidate[] = [];
    for (const r of fileRows) {
      const fNorm = fileNorm.get(r.node_id) ?? 0;
      if (fNorm === 0) continue;
      let dot = 0;
      const len = Math.min(vec.length, r.vector.length);
      for (let i = 0; i < len; i += 1) dot += vec[i] * r.vector[i];
      const sim = dot / (nNorm * fNorm);
      if (sim < threshold) continue;
      const verb = BINDING_VERB_BY_NODE[ctype];
      const meta = fileMeta.get(r.node_id) ?? {};
      cands.push({
        file_id: r.node_id,
        path: meta.path,
        title: meta.title,
        similarity: Number(sim.toFixed(4)),
        apply: {
          verb: verb.verb,
          flag: verb.flag,
          // そのまま実行できる断片: <verb> ... <flag> <file-id>
          example: `${verb.verb} --slug <slug> ... ${verb.flag} ${r.node_id}`,
        },
      });
    }
    if (cands.length === 0) continue;
    cands.sort((a, b) => b.similarity - a.similarity);
    out.push({
      node_id: node.id,
      node_type: ctype,
      edge_type: BINDING_EDGE_TYPE_BY_NODE[ctype],
      candidates: cands.slice(0, topN),
    });
  }
  return out;
}

function parseArgs(argv: string[]) {
  const p: any = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") continue;
    if (!a?.startsWith("--")) continue;
    const key = a.slice(2);
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) {
      p[key] = value;
      i += 1;
    } else {
      p[key] = true;
    }
  }
  return {
    graphPath: typeof p.graph === "string" ? p.graph : process.env.GRAPHRAG_GRAPH_JSON_PATH,
    vectorPath: typeof p["vector-index"] === "string" ? p["vector-index"]
      : typeof p.vector === "string" ? p.vector
      : process.env.GRAPHRAG_VECTOR_INDEX_PATH,
    out: typeof p.out === "string" ? p.out : undefined,
    threshold: Number.isFinite(Number(p.threshold)) ? Number(p.threshold) : 0.7,
    topN: Number.isFinite(Number(p["top-n"])) ? Number(p["top-n"]) : 8,
    // --missing-only: 既に sets_policy_for / 実装ファイル紐付けがある knowledge は skip
    missingOnly: Boolean(p["missing-only"]),
    // --changed-files: 指定された変更ファイルだけを候補対象にする (post-merge hook 用)
    changedFiles: typeof p["changed-files"] === "string" ? p["changed-files"] : undefined,
    // --relations: binding (知識↔File) ではなく知識↔知識の関係候補を一括列挙するモード
    relations: Boolean(p.relations)
  };
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}
function norm(v: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += v[i] * v[i];
  return Math.sqrt(s);
}
function cosine(a: number[], b: number[], na: number, nb: number): number {
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

// 知識↔知識の関係候補を一括列挙する対象型 (同型ペアのみ照合する)。
// duplicate-check の relations 副産物が「同型 cosine の [0.80,0.92)」を拾うのと同じ思想で、
// ストックの知識ノード同士の refines / has_premise / supersede 候補を後付けで洗い出す。
const RELATION_NODE_TYPES = [
  "Decision",
  "OperationalKnowledge",
  "Risk",
  "Constraint",
  "Goal",
  "RejectedOption",
] as const;

export type RelationPair = {
  a_id: string;
  a_title?: string;
  b_id: string;
  b_title?: string;
  similarity: number;
  note: string;
};

/**
 * 同型の知識ノードペアのうち、cosine が [RELATION_BAND_LOW, RELATION_BAND_HIGH) に入るものを
 * similarity 降順で列挙する。embedding の追加計算はせず vector index の既存ベクトルのみ使う。
 * 0.92 以上は重複疑い (carving-check #10 の領域) なので含めない。
 */
export function suggestRelationsForNodes(args: {
  nodes: any[];
  embById: Map<string, number[]>;
  normById: Map<string, number>;
  topN?: number;
}): RelationPair[] {
  const topN = args.topN ?? 50;
  const note =
    "refines / has_premise / supersede (方針転換レシピ) のどれかは LLM が中身を読んで判断";
  const relationTypeSet = new Set<string>(RELATION_NODE_TYPES);

  // 型ごとにノードをまとめ、同型内の総当たり (i<j) でペアを作る。
  const byType = new Map<string, any[]>();
  for (const n of args.nodes) {
    const ctype = canonicalType(n?.type);
    if (!ctype || !relationTypeSet.has(ctype)) continue;
    if (!args.embById.has(n.id) || !args.normById.has(n.id)) continue;
    (byType.get(ctype) || byType.set(ctype, []).get(ctype)!).push(n);
  }

  const pairs: RelationPair[] = [];
  for (const group of byType.values()) {
    for (let i = 0; i < group.length; i += 1) {
      const a = group[i];
      const aEmb = args.embById.get(a.id)!;
      const aNorm = args.normById.get(a.id)!;
      for (let j = i + 1; j < group.length; j += 1) {
        const b = group[j];
        const bEmb = args.embById.get(b.id)!;
        const bNorm = args.normById.get(b.id)!;
        const sim = cosine(aEmb, bEmb, aNorm, bNorm);
        if (sim < RELATION_BAND_LOW || sim >= RELATION_BAND_HIGH) continue;
        pairs.push({
          a_id: a.id,
          a_title: a.title,
          b_id: b.id,
          b_title: b.title,
          similarity: Number(sim.toFixed(4)),
          note,
        });
      }
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  return pairs.slice(0, topN);
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  if (!args.graphPath) {
    console.error("Refusing: graph.json path not specified.");
    console.error("Pass --graph <path> or set GRAPHRAG_GRAPH_JSON_PATH env.");
    process.exit(1);
  }
  if (!args.vectorPath) {
    console.error("Refusing: vector-index.json path not specified.");
    console.error("Pass --vector-index <path> or set GRAPHRAG_VECTOR_INDEX_PATH env.");
    process.exit(1);
  }

  const graph = JSON.parse(fs.readFileSync(args.graphPath, "utf8"));
  const vector = JSON.parse(fs.readFileSync(args.vectorPath, "utf8"));

  // embedding 読み込み (binding / relations 両モードで使う)
  const rows: any[] = Array.isArray(vector.rows) ? vector.rows : [];
  const embById = new Map<string, number[]>();
  const normById = new Map<string, number>();
  for (const r of rows) {
    embById.set(r.node_id, r.vector);
    normById.set(r.node_id, norm(r.vector));
  }

  // ── relations モード: 知識↔知識の関係候補を一括列挙して終わる ──────────────
  if (args.relations) {
    const pairs = suggestRelationsForNodes({
      nodes: graph.nodes,
      embById,
      normById,
      topN: args.topN,
    });
    const result = {
      mode: "relations",
      graph_path: args.graphPath,
      vector_path: args.vectorPath,
      band: [RELATION_BAND_LOW, RELATION_BAND_HIGH],
      top_n: args.topN,
      // 0.92 以上は重複疑いなので carving-check #10 (node-duplicate-suspect) の領域。ここには出さない。
      note: `cosine [${RELATION_BAND_LOW}, ${RELATION_BAND_HIGH}) の同型知識ペアのみ。${RELATION_BAND_HIGH} 以上は重複疑い (carving-check #10) の領域で、ここには含めない。`,
      pairs,
      pair_count: pairs.length,
    };
    if (args.out) {
      fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
      console.error(`Wrote ${args.out} (${pairs.length} relation pairs)`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  // ノード分類 (binding モード)。Constraint も一括対象に含める (3.8 以前ストックの生やし直し)。
  // 提案エッジ型は BINDING_EDGE_TYPE_BY_NODE 駆動に統一する。
  const knowledgeNodes = graph.nodes.filter(
    (n: any) => !!BINDING_EDGE_TYPE_BY_NODE[canonicalType(n.type) ?? ""]
  );
  const fileNodes = graph.nodes.filter((n: any) => n.type === "File");

  // 既存紐付けマップ (--missing-only 用)
  const out: Record<string, any[]> = {};
  for (const e of graph.edges) (out[e.from] = out[e.from] || []).push(e);
  const isImplFile = (toId: string) =>
    toId.startsWith("file:") && !/docs\/knowhow\/|plans\/|docs\/design-decisions\//.test(toId);
  // binding 済み判定は型ごと。
  // - D/OK/R: sets_policy_for または documented_by が実装 File 宛 (従来定義)
  // - Constraint: constrains エッジが 1 本でもあれば skip
  //   (check-carving.ts の constraint-binding-missing と同じ定義。宛先は File に限らない)
  const hasImplBinding = (knowledgeId: string, ctype: string): boolean => {
    const oe = out[knowledgeId] || [];
    if (ctype === "Constraint") {
      return oe.some(e => e.type === "constrains");
    }
    if (oe.some(e => e.type === "sets_policy_for" && isImplFile(e.to))) return true;
    if (oe.some(e => e.type === "documented_by" && isImplFile(e.to))) return true;
    return false;
  };

  // --changed-files で対象 File を絞る
  let targetFileIds: Set<string> | null = null;
  if (args.changedFiles) {
    targetFileIds = new Set<string>();
    const paths = args.changedFiles.split(/[\s,\n]+/).filter(Boolean);
    for (const p of paths) {
      const f = fileNodes.find((fn: any) => fn.path === p || fn.path?.endsWith(`/${p}`));
      if (f) targetFileIds.add(f.id);
    }
  }

  // 各 knowledge ノードについて、File top N の近接候補を出す
  const suggestions: any[] = [];
  for (const k of knowledgeNodes) {
    const ctype = canonicalType(k.type) ?? k.type;
    if (args.missingOnly && hasImplBinding(k.id, ctype)) continue;
    const kEmb = embById.get(k.id);
    const kNorm = normById.get(k.id);
    if (!kEmb || !kNorm) continue;

    const candidates: any[] = [];
    for (const f of fileNodes) {
      if (targetFileIds && !targetFileIds.has(f.id)) continue;
      // 既知の docs/knowhow/plans/design-decisions は出所として既存紐付き候補、除外
      if (!isImplFile(f.id)) continue;
      const fEmb = embById.get(f.id);
      const fNorm = normById.get(f.id);
      if (!fEmb || !fNorm) continue;
      const sim = cosine(kEmb, fEmb, kNorm, fNorm);
      if (sim < args.threshold) continue;
      candidates.push({
        file_id: f.id,
        path: f.path,
        title: f.title,
        summary: (f.summary || "").slice(0, 100),
        similarity: Number(sim.toFixed(4))
      });
    }
    candidates.sort((a, b) => b.similarity - a.similarity);
    const topCandidates = candidates.slice(0, args.topN);

    if (topCandidates.length === 0) continue;

    suggestions.push({
      knowledge_id: k.id,
      knowledge_type: ctype,
      // 提案エッジ型 (write-time suggestions と同形)。型ごとに固定。
      edge_type: BINDING_EDGE_TYPE_BY_NODE[ctype],
      knowledge_title: k.title,
      knowledge_summary: (k.summary || "").slice(0, 200),
      has_impl_binding: hasImplBinding(k.id, ctype),
      top_candidates: topCandidates
    });
  }

  const result = {
    graph_path: args.graphPath,
    vector_path: args.vectorPath,
    threshold: args.threshold,
    top_n: args.topN,
    missing_only: args.missingOnly,
    changed_files_filter: args.changedFiles ? args.changedFiles.split(/[\s,\n]+/).filter(Boolean) : null,
    knowledge_total: knowledgeNodes.length,
    suggestion_count: suggestions.length,
    suggestions
  };

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
    console.error(`Wrote ${args.out} (${suggestions.length} suggestions)`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

if (process.argv[1] && process.argv[1].endsWith("suggest-policy-edges.ts")) { main(); }

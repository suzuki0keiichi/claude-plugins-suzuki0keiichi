import { canonicalType } from "./schema.ts";
import { cosineSimilarity } from "./vector.ts";
import { mutationOp } from "./mutation-core.ts";

// check-carving の node-duplicate-suspect (#10) と同値の閾値。事後検出 (carving) と
// 書き込み時ゲートで基準が割れると「書けたのに後で WARN」になり混乱するため揃える。
export const DUPLICATE_SUSPECT_THRESHOLD = 0.92;

// E0 relations 帯 (suggest-only): 重複ゲートが副産物として既に計算した同型 cosine のうち、
// 「重複ではないが近い」[0.80, 0.92) を関係候補として転用する (追加 embedding はしない)。
// refines / has_premise / supersede のどれにするかは LLM/人間の判断 (機械は band 検出のみ)。
export const RELATION_BAND_LOW = 0.8;
export const RELATION_BAND_HIGH = DUPLICATE_SUSPECT_THRESHOLD; // = 0.92 (重複帯の直下まで)

// 書き込み時重複ゲートの対象 = 知識/横断ノード。File は path が同一性そのもの、
// ConversationChunk は生ログで同話題の別会話が正常 (重複ではない) ため対象外。
export const DUPLICATE_CHECK_NODE_TYPES = [
  "Decision",
  "RejectedOption",
  "Constraint",
  "Goal",
  "Risk",
  "OperationalKnowledge",
  "Investigation",
  "Vein",
  "Pocket",
  "Stratum"
] as const;

const DUPLICATE_CHECK_TYPE_SET = new Set<string>(DUPLICATE_CHECK_NODE_TYPES);

export type DuplicateSuspect = {
  new_id: string;
  existing_id: string;
  similarity: number;
};

// [0.80, 0.92) 帯の同型近接ペア。重複ではないので reject には絡まない関係候補 (suggest-only)。
export type RelationCandidate = {
  new_id: string;
  existing_id: string;
  similarity: number;
};

// status は出力契約の "ok"|"acked"|"skipped" に加え、内部用に "rejected" を持つ
// (reject 時は mutation 自体が失敗するので出力フィールドには現れない)。
// relations は副産物 (band 検出済みペア)。status に関わらず常に同梱され、reject 挙動には
// 影響しない (suggest-only)。
export type DuplicateCheckResult = {
  status: "ok" | "acked" | "skipped" | "rejected";
  reason?: string;
  suspects: DuplicateSuspect[];
  failures: string[];
  relations: RelationCandidate[];
};

function vectorNorm(vector: number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

// 索引行は provider 正規化済みだが、注入 embed (テスト・将来の別 provider) は
// 保証されないので両ノルムで割って真の cosine にする。
function cosine(left: number[], right: number[], leftNorm: number, rightNorm: number): number {
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return cosineSimilarity(left, right) / (leftNorm * rightNorm);
}

function duplicateGateText(node: any): string {
  return [node.title, node.summary]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join(" ");
}

/**
 * op:create の knowledge/crosscut ノードを vault の vector index 内の同型ノードと
 * embedding cosine で照合し、threshold 以上を duplicate suspect とする書き込み時ゲート。
 * - suspect 無し → ok
 * - 全 suspect の existing_id が plan.duplicate_ack に含まれる → acked (続行可)
 * - 覆われない suspect がある → rejected (failures に列挙、呼び出し元が all-or-nothing で拒否)
 * - vector index 不在 / embedding 不達 → skipped (非致命。reason に理由)
 * embedding と index 読みは引数注入なのでネットワーク・FS 非依存でテストできる。
 */
export async function runDuplicateCheck(args: {
  plan: { nodes: any[]; duplicate_ack?: string[] };
  currentGraph: { nodes?: any[] };
  vectorIndex: { rows?: any[] } | null | undefined;
  embed: (text: string) => Promise<number[]>;
  threshold?: number;
}): Promise<DuplicateCheckResult> {
  const threshold = args.threshold ?? DUPLICATE_SUSPECT_THRESHOLD;
  const candidates = (args.plan.nodes ?? []).filter((node) => {
    if (mutationOp(node) !== "create") return false;
    const type = canonicalType(node.type);
    return type !== undefined && DUPLICATE_CHECK_TYPE_SET.has(type);
  });
  if (candidates.length === 0) {
    return { status: "ok", suspects: [], failures: [], relations: [] };
  }

  const rows: any[] = Array.isArray(args.vectorIndex?.rows) ? args.vectorIndex.rows : [];
  if (rows.length === 0) {
    return {
      status: "skipped",
      reason: "vector index unavailable (build it to enable the duplicate gate)",
      suspects: [],
      failures: [],
      relations: []
    };
  }

  // 既存ノードの型は索引行に無いので currentGraph から引く。索引にだけ残る
  // stale な行 (削除済みノード) は型が引けず自然に比較対象から外れる。
  const typeById = new Map<string, string | undefined>(
    (args.currentGraph.nodes ?? []).map((node) => [node.id, canonicalType(node.type)])
  );

  const suspects: DuplicateSuspect[] = [];
  // relations: 同じ照合ループで [0.80, 0.92) 帯のペアを副産物として拾う (追加 embedding なし)。
  const relations: RelationCandidate[] = [];
  try {
    for (const candidate of candidates) {
      const text = duplicateGateText(candidate);
      if (!text) continue;
      const candidateVector = await args.embed(text);
      const candidateNorm = vectorNorm(candidateVector);
      const candidateType = canonicalType(candidate.type);
      for (const row of rows) {
        if (!Array.isArray(row?.vector) || typeof row?.node_id !== "string") continue;
        if (row.node_id === candidate.id) continue;
        if (typeById.get(row.node_id) !== candidateType) continue;
        const similarity = cosine(
          candidateVector,
          row.vector,
          candidateNorm,
          vectorNorm(row.vector)
        );
        if (similarity >= threshold) {
          suspects.push({
            new_id: candidate.id,
            existing_id: row.node_id,
            similarity: Number(similarity.toFixed(4))
          });
        } else if (similarity >= RELATION_BAND_LOW && similarity < RELATION_BAND_HIGH) {
          relations.push({
            new_id: candidate.id,
            existing_id: row.node_id,
            similarity: Number(similarity.toFixed(4))
          });
        }
      }
    }
  } catch (error: any) {
    // embedding endpoint 不達等は非致命スキップ (index_status と同じ扱い)。
    return {
      status: "skipped",
      reason: `embedding unavailable: ${String(error?.message ?? error)}`,
      suspects: [],
      failures: [],
      relations: []
    };
  }

  if (suspects.length === 0) {
    return { status: "ok", suspects: [], failures: [], relations };
  }

  const acked = new Set(args.plan.duplicate_ack ?? []);
  const unacked = suspects.filter((s) => !acked.has(s.existing_id));
  if (unacked.length === 0) {
    return { status: "acked", suspects, failures: [], relations };
  }
  return {
    status: "rejected",
    suspects,
    failures: unacked.map(
      (s) =>
        `duplicate-suspect: ${s.new_id} ~ ${s.existing_id} (similarity ${s.similarity.toFixed(2)})`
    ),
    relations
  };
}

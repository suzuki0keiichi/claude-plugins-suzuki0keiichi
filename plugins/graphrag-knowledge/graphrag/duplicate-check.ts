import { canonicalType, DEFAULT_SCHEMA, type SchemaDefinition } from "./schema.ts";
import { cosineSimilarity, nodeVectorText } from "./vector.ts";
import { mutationOp } from "./mutation-core.ts";

// check-carving の node-duplicate-suspect と同値の閾値。事後検出 (carving) と
// 書き込み時ゲートで基準が割れると「書けたのに後で WARN」になり混乱するため揃える。
// 0.92 は「索引行どうし (document 埋め込み × nodeVectorText)」で較正した値なので、
// ゲート側の候補も同じテキスト構成 (duplicateGateText = nodeVectorText) を document
// 接頭辞で埋め込む (query 埋め込みで比較すると空間がずれ系統的に検出漏れする)。
export const DUPLICATE_SUSPECT_THRESHOLD = 0.92;

// E0 relations 帯 (suggest-only): 重複ゲートが副産物として既に計算した同型 cosine のうち、
// 「重複ではないが近い」[0.80, 0.92) を関係候補として転用する (追加 embedding はしない)。
// refines / has_premise / supersede のどれにするかは LLM/人間の判断 (機械は band 検出のみ)。
export const RELATION_BAND_LOW = 0.8;
export const RELATION_BAND_HIGH = DUPLICATE_SUSPECT_THRESHOLD; // = 0.92 (重複帯の直下まで)

// 書き込み時重複ゲートの対象 = 知識/横断ノード。File は path が同一性そのもの、
// ConversationChunk は生ログで同話題の別会話が正常 (重複ではない) ため対象外。
// 単一正本は schema の categories.duplicateCheck (check-carving の重複監査もここから引く)。
export const DUPLICATE_CHECK_NODE_TYPES = DEFAULT_SCHEMA.categories.duplicateCheck;

// 型を跨いだ重複疑いを「提案として」検査する型グループ (suggest-only・reject しない)。
// Decision↔OperationalKnowledge の境界は設計上ファジーなので、同型フィルタだけだと
// 構造的に取りこぼす。Risk↔Constraint も同様。
export const CROSS_TYPE_DUP_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ["Decision", "OperationalKnowledge"],
  ["Risk", "Constraint"],
];

// 既存ノードの要点 (suspect/relations に同梱する判断材料)。
export type ExistingNodeBrief = {
  type?: string;
  title?: string;
  summary?: string;
  state?: string;
};

export type DuplicateSuspect = {
  new_id: string;
  existing_id: string;
  similarity: number;
  // "embedding" = cosine 照合 / "lexical" = 正規化 title/alias 完全一致 (similarity 1)
  basis: "embedding" | "lexical";
  existing?: ExistingNodeBrief;
  // 拒否を「壁」でなく判断材料にする: 次に取れる行動の定型ヒント。
  next_step: string;
};

// 同型フィルタでは拾えない型跨ぎの重複疑い (suggest-only。reject には決して使わない)。
export type CrossTypeSuspect = {
  new_id: string;
  existing_id: string;
  similarity: number;
  existing?: ExistingNodeBrief;
};

// [0.80, 0.92) 帯の同型近接ペア。重複ではないので reject には絡まない関係候補 (suggest-only)。
export type RelationCandidate = {
  new_id: string;
  existing_id: string;
  similarity: number;
  existing?: ExistingNodeBrief;
};

// status は出力契約の "ok"|"acked"|"skipped" に加え、内部用に "rejected" を持つ
// (reject 時は mutation 自体が失敗するので出力フィールドには現れない)。
// relations / cross_type_suspects は副産物。status に関わらず常に同梱され、reject 挙動には
// 影響しない (suggest-only)。lexical pre-pass は embedding 不達でも走るので、
// status "skipped" (embedding 側の skip) でも lexical suspect があれば rejected/acked になる。
export type DuplicateCheckResult = {
  status: "ok" | "acked" | "skipped" | "rejected";
  reason?: string;
  suspects: DuplicateSuspect[];
  failures: string[];
  relations: RelationCandidate[];
  cross_type_suspects: CrossTypeSuspect[];
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

/**
 * ゲート候補の埋め込みテキスト。索引行の埋め込み入力 (nodeVectorText) と同一構成に
 * しないと同じノードでも別ベクトルになり 0.92 閾値が意味を失うため、自前で組まず
 * nodeVectorText を再利用する (単一正本)。
 */
export function duplicateGateText(node: any): string {
  return nodeVectorText(node);
}

/**
 * 重複ゲートの検査対象 (op:create の知識/横断ノード) を plan から列挙する。
 * 呼び出し元 (mutate-vault) がロック取得前に候補の埋め込みを先行計算するためにも使う。
 */
export function duplicateGateCandidates(
  plan: { nodes?: any[] },
  schema?: SchemaDefinition
): any[] {
  const dupCheckTypes = new Set((schema ?? DEFAULT_SCHEMA).categories.duplicateCheck);
  return (plan.nodes ?? []).filter((node) => {
    if (mutationOp(node) !== "create") return false;
    const type = canonicalType(node.type, schema);
    return type !== undefined && dupCheckTypes.has(type);
  });
}

function existingBrief(node: any): ExistingNodeBrief | undefined {
  if (!node) return undefined;
  const brief: ExistingNodeBrief = {};
  if (typeof node.type === "string") brief.type = canonicalType(node.type) ?? node.type;
  if (typeof node.title === "string") brief.title = node.title;
  if (typeof node.summary === "string") brief.summary = node.summary;
  if (typeof node.state === "string") brief.state = node.state;
  return brief;
}

function nextStepFor(existingId: string): string {
  return (
    `update ${existingId} via commit-mutation | ` +
    `supersede (state:superseded + refines from successor) | ` +
    `--dup-ack ${existingId} if genuinely distinct`
  );
}

// ── lexical exact pre-pass ────────────────────────────────────────────────
// embedding が落ちていてもゲートが素通りにならないための安価な完全一致検査。
// 正規化 (trim / lowercase / 空白圧縮) した title↔title / title↔alias / alias↔alias が
// 同型・同 <system> セグメントの既存ノードと衝突したら similarity 1 の suspect。

function normalizeLexical(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function systemSegment(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const segment = id.split(":")[1];
  return segment && segment.length > 0 ? segment : null;
}

function lexicalNames(node: any): Set<string> {
  const names = new Set<string>();
  const title = normalizeLexical(node?.title);
  if (title) names.add(title);
  for (const alias of Array.isArray(node?.aliases) ? node.aliases : []) {
    const n = normalizeLexical(alias);
    if (n) names.add(n);
  }
  return names;
}

function lexicalExactSuspects(
  candidates: any[],
  currentNodes: any[],
  schema?: SchemaDefinition
): DuplicateSuspect[] {
  const suspects: DuplicateSuspect[] = [];
  for (const candidate of candidates) {
    const candidateType = canonicalType(candidate.type, schema);
    const candidateSystem = systemSegment(candidate.id);
    const candidateNames = lexicalNames(candidate);
    if (!candidateType || !candidateSystem || candidateNames.size === 0) continue;
    for (const existing of currentNodes) {
      if (!existing || existing.id === candidate.id) continue;
      if (canonicalType(existing.type) !== candidateType) continue;
      if (systemSegment(existing.id) !== candidateSystem) continue;
      const existingNames = lexicalNames(existing);
      let collides = false;
      for (const name of candidateNames) {
        if (existingNames.has(name)) {
          collides = true;
          break;
        }
      }
      if (!collides) continue;
      suspects.push({
        new_id: candidate.id,
        existing_id: existing.id,
        similarity: 1,
        basis: "lexical",
        existing: existingBrief(existing),
        next_step: nextStepFor(existing.id),
      });
    }
  }
  return suspects;
}

/**
 * op:create の knowledge/crosscut ノードを既存グラフ/索引と照合する書き込み時ゲート。
 * 2 段構成:
 *   1. lexical exact pre-pass — 正規化 title/alias の完全一致 (同型・同 system)。
 *      索引・embedding 不要なので endpoint が落ちていても必ず走る。
 *   2. embedding cosine — vault の vector index 内の同型ノードと照合し、threshold 以上を
 *      duplicate suspect とする。候補は索引と同じ document 空間で埋め込むこと (呼び出し元
 *      契約: embed は embedForIndex(index, text, "document") 相当)。
 * 判定:
 * - suspect 無し → ok
 * - 全 suspect の existing_id が plan.duplicate_ack に含まれる → acked (続行可)
 * - 覆われない suspect がある → rejected (failures に列挙、呼び出し元が all-or-nothing で拒否)
 * - vector index 不在 / embedding 不達 → embedding 段のみ skip (reason に理由)。
 *   lexical suspect が無ければ従来どおり status "skipped"。
 * 副産物 (suggest-only・reject に不使用):
 * - relations: 同型 cosine [0.80, 0.92) 帯のペア
 * - cross_type_suspects: {Decision,OperationalKnowledge} / {Risk,Constraint} グループ内の
 *   型跨ぎ threshold 以上ペア
 * embedding と index 読みは引数注入なのでネットワーク・FS 非依存でテストできる。
 */
export async function runDuplicateCheck(args: {
  plan: { nodes: any[]; duplicate_ack?: string[] };
  currentGraph: { nodes?: any[] };
  vectorIndex: { rows?: any[] } | null | undefined;
  embed: (text: string) => Promise<number[]>;
  threshold?: number;
  schema?: SchemaDefinition;
}): Promise<DuplicateCheckResult> {
  const threshold = args.threshold ?? DUPLICATE_SUSPECT_THRESHOLD;
  const candidates = duplicateGateCandidates(args.plan, args.schema);
  if (candidates.length === 0) {
    return { status: "ok", suspects: [], failures: [], relations: [], cross_type_suspects: [] };
  }

  const currentNodes = args.currentGraph.nodes ?? [];
  // 既存ノードの型/title/summary/state は索引行に無いので currentGraph から引く。
  // 索引にだけ残る stale な行 (削除済みノード) はノードが引けず自然に比較対象から外れる。
  const nodeById = new Map<string, any>(currentNodes.map((node) => [node.id, node]));

  // 1. lexical exact pre-pass (索引/embedding 非依存 — endpoint が落ちていても走る)。
  const suspects: DuplicateSuspect[] = lexicalExactSuspects(candidates, currentNodes, args.schema);
  const suspectPairs = new Set(suspects.map((s) => `${s.new_id} ${s.existing_id}`));

  // 2. embedding cosine pass (skip = 非致命。reason に理由を残す)。
  const relations: RelationCandidate[] = [];
  const crossTypeSuspects: CrossTypeSuspect[] = [];
  let skipReason: string | undefined;
  const rows: any[] = Array.isArray(args.vectorIndex?.rows) ? args.vectorIndex.rows : [];
  if (rows.length === 0) {
    skipReason = "vector index unavailable (build it to enable the duplicate gate)";
  } else {
    try {
      for (const candidate of candidates) {
        const text = duplicateGateText(candidate);
        if (!text) continue;
        const candidateVector = await args.embed(text);
        const candidateNorm = vectorNorm(candidateVector);
        const candidateType = canonicalType(candidate.type);
        const crossGroup = CROSS_TYPE_DUP_GROUPS.find((g) => g.includes(candidateType ?? ""));
        for (const row of rows) {
          if (!Array.isArray(row?.vector) || typeof row?.node_id !== "string") continue;
          if (row.node_id === candidate.id) continue;
          const existingNode = nodeById.get(row.node_id);
          const existingType = canonicalType(existingNode?.type);
          if (existingType === undefined) continue;
          const sameType = existingType === candidateType;
          const sameGroup =
            !sameType && crossGroup !== undefined && crossGroup.includes(existingType);
          if (!sameType && !sameGroup) continue;
          const similarity = cosine(
            candidateVector,
            row.vector,
            candidateNorm,
            vectorNorm(row.vector)
          );
          if (sameGroup) {
            // 型跨ぎは常に suggest-only (reject に使わない)。threshold 以上のみ列挙。
            if (similarity >= threshold) {
              crossTypeSuspects.push({
                new_id: candidate.id,
                existing_id: row.node_id,
                similarity: Number(similarity.toFixed(4)),
                existing: existingBrief(existingNode),
              });
            }
            continue;
          }
          if (similarity >= threshold) {
            // lexical pre-pass が既に同ペアを挙げていれば二重計上しない。
            if (suspectPairs.has(`${candidate.id} ${row.node_id}`)) continue;
            suspectPairs.add(`${candidate.id} ${row.node_id}`);
            suspects.push({
              new_id: candidate.id,
              existing_id: row.node_id,
              similarity: Number(similarity.toFixed(4)),
              basis: "embedding",
              existing: existingBrief(existingNode),
              next_step: nextStepFor(row.node_id),
            });
          } else if (similarity >= RELATION_BAND_LOW && similarity < RELATION_BAND_HIGH) {
            relations.push({
              new_id: candidate.id,
              existing_id: row.node_id,
              similarity: Number(similarity.toFixed(4)),
              existing: existingBrief(existingNode),
            });
          }
        }
      }
    } catch (error: any) {
      // embedding endpoint 不達等は embedding 段のみ非致命スキップ (lexical suspect は保持)。
      skipReason = `embedding unavailable: ${String(error?.message ?? error)}`;
    }
  }

  if (suspects.length === 0) {
    if (skipReason) {
      return {
        status: "skipped",
        reason: skipReason,
        suspects: [],
        failures: [],
        relations,
        cross_type_suspects: crossTypeSuspects,
      };
    }
    return { status: "ok", suspects: [], failures: [], relations, cross_type_suspects: crossTypeSuspects };
  }

  const acked = new Set(args.plan.duplicate_ack ?? []);
  const unacked = suspects.filter((s) => !acked.has(s.existing_id));
  if (unacked.length === 0) {
    return {
      status: "acked",
      ...(skipReason ? { reason: skipReason } : {}),
      suspects,
      failures: [],
      relations,
      cross_type_suspects: crossTypeSuspects,
    };
  }
  return {
    status: "rejected",
    ...(skipReason ? { reason: skipReason } : {}),
    suspects,
    failures: unacked.map((s) =>
      s.basis === "lexical"
        ? `duplicate-suspect: ${s.new_id} ~ ${s.existing_id} (lexical exact match)`
        : `duplicate-suspect: ${s.new_id} ~ ${s.existing_id} (similarity ${s.similarity.toFixed(2)})`
    ),
    relations,
    cross_type_suspects: crossTypeSuspects,
  };
}

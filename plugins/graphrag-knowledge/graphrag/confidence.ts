// Shared retrieval confidence grading + weak-model steering.
//
// Single home for the (trial-and-error tuned) score thresholds so brief.ts and
// evidence-packet.ts cannot drift apart — they used to carry separate copies of
// these constants and of judgeMatchConfidence/confidenceMessage.

export type MatchConfidence = "high" | "low" | "none";

// ── vector 判定はコーパス相対 (noise baseline) が本則 ─────────────────────────
// 絶対 cosine 閾値はモデル依存で使い物にならない (multilingual-e5 系は無関係な
// 文書対でも ~0.85 を返し、旧 0.65 閾値では何でも high になった実測)。索引構築時に
// ランダムなノード対の cosine 分布 (median / p90) を noise_baseline として索引メタに
// 打刻し、top1 の cosine を「コーパス中央値からの、分布の広がり (p90−median) を
// 単位とした相対マージン」で判定する:
//   margin = (top1 − median) / max(p90 − median, SPREAD_FLOOR)
//   high: margin ≥ 0 (top1 がコーパスのノード対中央値以上に近い)
//   low:  margin ≥ −1 (中央値より低いが分布の広がり 1 つ分以内)
//   none: それ未満 (無関係なノード対と同程度以下)
// dev vault (222 nodes, e5-base) 実測: on-topic top1 は margin +0.06〜+0.39、
// off-topic ("chocolate cake" 等) は −0.6〜−4.0 で分離する。
const VECTOR_MARGIN_HIGH = 0;
const VECTOR_MARGIN_LOW = -1;
const SPREAD_FLOOR = 0.01;
// baseline 無し (旧 index) 用の暫定の絶対値フォールバック。ローカル既定モデル系の
// 実測ノイズ床 (off-topic top1 ~0.79-0.83) に合わせる。索引を再構築すれば
// noise_baseline 判定に切り替わる。
const VECTOR_ABS_HIGH = 0.83;
const VECTOR_ABS_LOW = 0.78;
const NGRAM_HIGH = 0.65;
const NGRAM_LOW = 0.45;
const COVERAGE_HIGH = 0.65;
const COVERAGE_LOW = 0.45;

// 索引メタ (vector.json) の noise_baseline。build-vector-index.ts が打刻する。
export interface VectorNoiseBaseline {
  median_cosine: number;
  p90_cosine: number;
}

export interface ConfidenceOptions {
  noiseBaseline?: VectorNoiseBaseline | null;
}

function gradeVector(value: number, baseline?: VectorNoiseBaseline | null): MatchConfidence {
  const median = Number(baseline?.median_cosine);
  const p90 = Number(baseline?.p90_cosine);
  if (Number.isFinite(median) && Number.isFinite(p90)) {
    const spread = Math.max(p90 - median, SPREAD_FLOOR);
    const margin = (value - median) / spread;
    if (margin >= VECTOR_MARGIN_HIGH) return "high";
    if (margin >= VECTOR_MARGIN_LOW) return "low";
    return "none";
  }
  return gradeBand(value, VECTOR_ABS_HIGH, VECTOR_ABS_LOW);
}

// R4 standout (world.ts の実測済み手法の輸入): conf が high でない時、上位 2 件の
// 相対差 (top1.score - top2.score) / max(top1.score, 1) が十分大きければ「この問いの
// 領域に固有」とみなし 1 段格上げする。命名・思想は world.ts (standout: clear/none/single,
// gap_above_next) に合わせる。world は絶対 gap 閾値、こちらは合算スコアのレンジが
// クエリで動くため相対 gap を使う。
const STANDOUT_REL_GAP = 0.30;

export interface ConfidenceStandout {
  state: "clear" | "none" | "single";
  gap_above_next: number | null;
}

// 1 件のマッチの reason から、vector / ngram / coverage / aliasExact の信号を取り出す。
// retrieval.ts が出す reason 語彙: "vector:<n>" / "ngram:<n>" / "term:<t>" (語ごと) /
// "alias-exact"。coverage は単一数値の reason が無いので、現状は term 数では測れない
// (将来 coverage:<n> を retrieval が出せば拾えるよう口だけ用意する)。
function extractScoreSignal(reasons: string[]): {
  vector?: number;
  ngram?: number;
  coverage?: number;
  aliasExact?: boolean;
} {
  const result: { vector?: number; ngram?: number; coverage?: number; aliasExact?: boolean } = {};
  for (const reason of reasons) {
    if (typeof reason !== "string") continue;
    const vectorMatch = reason.match(/^vector:([0-9.]+)/);
    if (vectorMatch) result.vector = Number(vectorMatch[1]);
    const ngramMatch = reason.match(/^ngram:([0-9.]+)/);
    if (ngramMatch) result.ngram = Number(ngramMatch[1]);
    const coverageMatch = reason.match(/^coverage:([0-9.]+)/);
    if (coverageMatch) result.coverage = Number(coverageMatch[1]);
    if (reason === "alias-exact") result.aliasExact = true;
  }
  return result;
}

function gradeBand(value: number, high: number, low: number): MatchConfidence {
  if (value >= high) return "high";
  if (value >= low) return "low";
  return "none";
}

const RANK: Record<MatchConfidence, number> = { none: 0, low: 1, high: 2 };

function stronger(a: MatchConfidence, b: MatchConfidence): MatchConfidence {
  return RANK[a] >= RANK[b] ? a : b;
}

// R4: vector と lexical を **独立に** 判定し強い方を採る (旧: vector があれば vector のみ)。
// lexical = aliasExact (=1.0 は単独で high) / coverage / ngram の最大バンド。
// opts.noiseBaseline (索引メタ) があれば vector はコーパス相対マージンで判定する。
export function judgeMatchConfidence(match: any | undefined, opts: ConfidenceOptions = {}): MatchConfidence {
  if (!match) return "none";
  const reasons = Array.isArray(match.reasons) ? match.reasons : [];
  const { vector, ngram, coverage, aliasExact } = extractScoreSignal(reasons);

  const vectorConf: MatchConfidence = typeof vector === "number"
    ? gradeVector(vector, opts.noiseBaseline)
    : "none";

  let lexicalConf: MatchConfidence = "none";
  if (aliasExact) lexicalConf = "high"; // 別名完全一致は単独で high
  if (typeof coverage === "number") lexicalConf = stronger(lexicalConf, gradeBand(coverage, COVERAGE_HIGH, COVERAGE_LOW));
  if (typeof ngram === "number") lexicalConf = stronger(lexicalConf, gradeBand(ngram, NGRAM_HIGH, NGRAM_LOW));

  return stronger(vectorConf, lexicalConf);
}

// R4: top1 の confidence を、上位 2 件の相対 gap で 1 段格上げするか判定する。
// 戻り値の standout は world.ts と整合: single (top が 1 件 → 格上げなし) /
// clear (突出 → 格上げ対象) / none (横並び → 格上げなし)。
// confidence: top1 の最終 confidence (格上げ適用後)。
export function gradeConfidence(matches: any[] | undefined, opts: ConfidenceOptions = {}): {
  confidence: MatchConfidence;
  standout: ConfidenceStandout;
} {
  const list = Array.isArray(matches) ? matches : [];
  const base = judgeMatchConfidence(list[0], opts);
  if (list.length === 0) {
    return { confidence: "none", standout: { state: "single", gap_above_next: null } };
  }
  if (list.length === 1) {
    // top が 1 件なら相対判定できない (格上げなし)。
    return { confidence: base, standout: { state: "single", gap_above_next: null } };
  }
  const top1 = Number(list[0]?.score ?? 0);
  const top2 = Number(list[1]?.score ?? 0);
  const gap = (top1 - top2) / Math.max(top1, 1);
  const clear = gap >= STANDOUT_REL_GAP;
  let confidence = base;
  // high でない時だけ 1 段格上げ (none→low, low→high)。
  if (clear && confidence !== "high") {
    confidence = confidence === "none" ? "low" : "high";
  }
  return {
    confidence,
    standout: { state: clear ? "clear" : "none", gap_above_next: Number(gap.toFixed(3)) }
  };
}

export function confidenceMessage(confidence: MatchConfidence): string | null {
  if (confidence === "high") return null;
  if (confidence === "low") {
    return "Weak hit. Graph may not cover this concept. Try one alternative keyword; if still no hit, switch to code/doc direct reading instead of repeating graph queries.";
  }
  // v3-safe wording: must not name specific node types (the old message
  // went stale when canonical names changed; keep type-agnostic).
  return "No matching evidence in graph. Try one alternative keyword; if still no hit, switch to code/doc direct reading instead of repeating graph queries.";
}

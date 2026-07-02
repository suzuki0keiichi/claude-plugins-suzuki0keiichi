import assert from "node:assert/strict";
import test from "node:test";
import { confidenceMessage, judgeMatchConfidence, gradeConfidence } from "./confidence.ts";

test("judgeMatchConfidence returns 'none' when match is missing", () => {
  assert.equal(judgeMatchConfidence(undefined), "none");
});

// baseline 無し (旧 index) の絶対値フォールバック: pre-1.10 の定数 high ≥ 0.65 /
// low ≥ 0.50 に復元 (契約は「旧 index → 旧挙動」)。索引を再構築して noise_baseline
// が打刻されれば下のコーパス相対判定に切り替わる。
test("judgeMatchConfidence: vector absolute stopgap bands (no baseline)", () => {
  assert.equal(judgeMatchConfidence({ reasons: ["vector:0.72", "ngram:0.10"] }), "high");
  // vector low + ngram low → どちらも弱い → low (強い方=low)
  assert.equal(judgeMatchConfidence({ reasons: ["vector:0.55", "ngram:0.20"] }), "low");
  // vector none + ngram low → low
  assert.equal(judgeMatchConfidence({ reasons: ["vector:0.30", "ngram:0.50"] }), "low");
  // vector none + ngram none → none
  assert.equal(judgeMatchConfidence({ reasons: ["vector:0.30", "ngram:0.20"] }), "none");
});

test("judgeMatchConfidence: R4 lexical is judged independently and the stronger wins", () => {
  // vector low (0.55) だが ngram high (0.80) → 独立判定で強い方=high
  assert.equal(judgeMatchConfidence({ reasons: ["vector:0.55", "ngram:0.80"] }), "high");
  // vector none (0.30) でも ngram high なら high
  assert.equal(judgeMatchConfidence({ reasons: ["vector:0.30", "ngram:0.80"] }), "high");
});

// noise_baseline (索引メタ) が在れば vector はコーパス相対マージンで判定する:
// spread = max(p90 − median, 0.01)、margin = (v − median) / spread。
// high: margin ≥ 0 / low: margin ≥ −1 / none: それ未満。
test("judgeMatchConfidence: corpus-relative margin when noise baseline present", () => {
  const noiseBaseline = { median_cosine: 0.85, p90_cosine: 0.88 }; // spread 0.03
  const judge = (v: number) => judgeMatchConfidence({ reasons: [`vector:${v}`] }, { noiseBaseline });
  assert.equal(judge(0.86), "high", "median 以上は high");
  assert.equal(judge(0.85), "high", "median ちょうども high (margin 0)");
  assert.equal(judge(0.83), "low", "median−spread 以内は low");
  assert.equal(judge(0.79), "none", "median−spread を割ると none");
  // 絶対値では 0.86 も 0.79 も旧判定なら同じ側に落ちる — 相対判定だけが分離できる
});

test("judgeMatchConfidence: malformed baseline falls back to absolute bands", () => {
  const judge = (baseline: any) =>
    judgeMatchConfidence({ reasons: ["vector:0.85"] }, { noiseBaseline: baseline });
  assert.equal(judge(null), "high");
  assert.equal(judge({ median_cosine: "x", p90_cosine: null }), "high");
});

test("judgeMatchConfidence: aliasExact alone is high (no vector/ngram needed)", () => {
  assert.equal(judgeMatchConfidence({ reasons: ["alias-exact"] }), "high");
  // 別名一致は vector が弱くても high を担保する
  assert.equal(judgeMatchConfidence({ reasons: ["alias-exact", "vector:0.10"] }), "high");
});

test("judgeMatchConfidence uses ngram when vector is absent", () => {
  assert.equal(judgeMatchConfidence({ reasons: ["ngram:0.70"] }), "high");
  assert.equal(judgeMatchConfidence({ reasons: ["ngram:0.50"] }), "low");
  assert.equal(judgeMatchConfidence({ reasons: ["ngram:0.20"] }), "none");
});

test("judgeMatchConfidence uses coverage band when present", () => {
  assert.equal(judgeMatchConfidence({ reasons: ["coverage:0.70"] }), "high");
  assert.equal(judgeMatchConfidence({ reasons: ["coverage:0.50"] }), "low");
});

test("gradeConfidence: standout 'clear' upgrades low→high (relative gap >= 0.30)", () => {
  // top1 は ngram low (0.50) で base=low。top2 が大きく離れている (gap=0.5>=0.3) → high へ格上げ。
  const matches = [
    { score: 100, reasons: ["ngram:0.50"] },
    { score: 40, reasons: ["ngram:0.50"] }
  ];
  const { confidence, standout } = gradeConfidence(matches);
  assert.equal(confidence, "high", "low が standout clear で high に格上げ");
  assert.equal(standout.state, "clear");
  assert.ok(standout.gap_above_next! >= 0.30);
});

test("gradeConfidence: standout 'none' when top1/top2 are crowded (no upgrade)", () => {
  const matches = [
    { score: 100, reasons: ["ngram:0.50"] },
    { score: 95, reasons: ["ngram:0.50"] }
  ];
  const { confidence, standout } = gradeConfidence(matches);
  assert.equal(confidence, "low", "横並びなら格上げしない");
  assert.equal(standout.state, "none");
});

test("gradeConfidence: single top → state 'single', no upgrade", () => {
  const { confidence, standout } = gradeConfidence([{ score: 100, reasons: ["ngram:0.50"] }]);
  assert.equal(confidence, "low");
  assert.equal(standout.state, "single");
  assert.equal(standout.gap_above_next, null);
});

test("gradeConfidence: passes noise baseline through to the vector grade", () => {
  const noiseBaseline = { median_cosine: 0.85, p90_cosine: 0.88 };
  // 同じ vector:0.60 が、baseline 有無で判定が変わることを確認する:
  // baseline 相対では median (0.85) からかけ離れており none、
  // baseline 無しの絶対フォールバック (pre-1.10 復元: 0.50≤v<0.65) では low。
  const low = gradeConfidence([{ score: 100, reasons: ["vector:0.60"] }, { score: 99, reasons: [] }], { noiseBaseline });
  assert.equal(low.confidence, "none", "相対判定で median−spread 未満は none");
  const abs = gradeConfidence([{ score: 100, reasons: ["vector:0.60"] }, { score: 99, reasons: [] }]);
  assert.equal(abs.confidence, "low", "baseline 無しなら絶対フォールバック (0.50≤v<0.65 = low)");
});

test("gradeConfidence: already-high top1 is not further upgraded", () => {
  const matches = [
    { score: 100, reasons: ["vector:0.90"] },
    { score: 10, reasons: ["ngram:0.10"] }
  ];
  const { confidence, standout } = gradeConfidence(matches);
  assert.equal(confidence, "high");
  // gap は clear だが既に high なので state は clear でも confidence は据え置き
  assert.equal(standout.state, "clear");
});

test("gradeConfidence: empty list → none/single", () => {
  const { confidence, standout } = gradeConfidence([]);
  assert.equal(confidence, "none");
  assert.equal(standout.state, "single");
});

test("confidenceMessage steers weak/empty hits and stays type-name agnostic (v3-safe)", () => {
  assert.equal(confidenceMessage("high"), null);
  assert.match(confidenceMessage("low") ?? "", /alternative keyword/);
  const none = confidenceMessage("none") ?? "";
  assert.match(none, /No matching evidence/);
  // must not reference removed v2 axis-2 type names
  assert.doesNotMatch(none, /Concern|Component|Layer/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { confidenceMessage, judgeMatchConfidence, gradeConfidence } from "./confidence.ts";

test("judgeMatchConfidence returns 'none' when match is missing", () => {
  assert.equal(judgeMatchConfidence(undefined), "none");
});

test("judgeMatchConfidence: vector high alone is high", () => {
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

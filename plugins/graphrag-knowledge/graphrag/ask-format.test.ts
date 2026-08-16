import assert from "node:assert/strict";
import test from "node:test";
import { formatAskMarkdown } from "./ask-format.ts";

const payload = () => ({
  question: "テスト質問",
  call_number: 2,
  final_stage: "brief",
  area_map: {
    crosscuts: [
      { id: "component:s:engine", type: "Component", title: "エンジン層", files_in_scope: 3, files_total: 31 }
    ]
  },
  enforcement_debt: { unguarded_constraints: 2, constraints_total: 5, hint: "2 Constraint(s) unguarded" },
  next_action_hint: "brief result is sufficient — proceed to judgment from here",
  stages: [
    {
      stage: "brief",
      output: {
        query: {
          match_confidence: "high",
          confidence_message: "Strong hit.",
          vector: { model: "multilingual-e5-base" },
          repeat: { repeat_state: "fresh", message: null },
          matches: [
            {
              rank: 1,
              score: 150.5,
              node: {
                id: "decision:s:a",
                type: "Decision",
                title: "決定A",
                summary: "要約A",
                state: "active"
              },
              state_note: "superseded — check refines reverse for successor",
              evidence_stale: {
                paths: [{ path: "src/a.ts", changed_at: "2026-02-01T00:00:00.000Z" }],
                verified_at: "2026-01-15T00:00:00.000Z",
                note: "⚠ evidence file(s) changed AFTER this node was last verified"
              },
              relations: [
                { relation: "refines", direction: "out", node: { id: "decision:s:b", type: "Decision", title: "決定B" } },
                { relation: "documented_by", direction: "out", id: "file:s:src/a.ts" }
              ]
            }
          ]
        }
      }
    }
  ]
});

test("formatAskMarkdown: 見出し・confidence・match 本体 (id/summary/state_note/evidence_stale/relations) が載る", () => {
  const md = formatAskMarkdown(payload());
  assert.match(md, /# ask: テスト質問/);
  assert.match(md, /final_stage: brief/);
  assert.match(md, /confidence: \*\*high\*\* — Strong hit\./);
  assert.match(md, /retrieval: semantic \(multilingual-e5-base\)/);
  assert.match(md, /### 1\. \[Decision\] 決定A \(score 150\.5\)/);
  assert.match(md, /- id: `decision:s:a` \(state: active\)/);
  assert.match(md, /要約A/);
  assert.match(md, /state_note: superseded/);
  assert.match(md, /evidence_stale: ⚠/);
  assert.match(md, /src\/a\.ts \(changed 2026-02-01/);
  assert.match(md, /refines→ \[Decision\] 決定B `decision:s:b`/);
  assert.match(md, /documented_by→ `file:s:src\/a\.ts`/);
  assert.match(md, /## area_map\n- \[Component\] エンジン層 `component:s:engine` \(files 3\/31\)/);
  assert.match(md, /## enforcement_debt\n2 Constraint\(s\) unguarded/);
  assert.match(md, /## next_action\nbrief result is sufficient/);
});

test("formatAskMarkdown: lexical-only は DEGRADED を焼き込む", () => {
  const p: any = payload();
  p.retrieval_mode = { semantic: false, reason: "--lexical-only", warning: "DEGRADED: keyword only" };
  const md = formatAskMarkdown(p);
  assert.match(md, /retrieval: \*\*DEGRADED \(lexical-only\)\*\* — DEGRADED: keyword only/);
});

test("formatAskMarkdown: evidence 段の direct_evidence も列挙する / matches 空は (none)", () => {
  const p: any = payload();
  p.final_stage = "evidence";
  p.stages[0].output.query.matches = [];
  p.stages.push({
    stage: "evidence",
    output: {
      match_confidence: "medium",
      direct_evidence: [
        { score: 9.9, node: { id: "ok:s:x", type: "OperationalKnowledge", title: "運用知X", summary: "s" } }
      ]
    }
  });
  const md = formatAskMarkdown(p);
  assert.match(md, /## matches\n\(none\)/);
  assert.match(md, /## direct_evidence \(1\) — confidence: medium/);
  assert.match(md, /\[OperationalKnowledge\] 運用知X/);
});

test("formatAskMarkdown: 欠損だらけの payload でも throw しない", () => {
  const md = formatAskMarkdown({ question: "q" });
  assert.match(md, /# ask: q/);
  assert.match(md, /\(none\)/);
});

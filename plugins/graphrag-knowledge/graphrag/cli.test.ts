import assert from "node:assert/strict";
import test from "node:test";
import { listKnownVerbs, isHeadlineVerb, isPrimitiveVerb } from "./cli.ts";

test("cli has expected primitive verbs", () => {
  const expected = [
    "brief", "search", "evidence", "index", "vector-index",
    "vault-build", "vault-import",
    "concern-hint", "edge-suggest-policy", "carving-check",
    "branch-merge", "world-refresh",
    "carving-allow", "harvest-history", "staleness-check",
    "xref-check", "fsck"
  ];
  for (const v of expected) {
    assert.ok(isPrimitiveVerb(v), `expected primitive: ${v}`);
  }
});

test("cli has no FalkorDB verbs after 作業C (removed)", () => {
  for (const v of ["mutate", "falkor-sync", "falkor-export", "list", "drop", "branch", "worktree-drop"]) {
    assert.equal(isPrimitiveVerb(v), false, `${v} should be removed`);
    assert.equal(isHeadlineVerb(v), false, `${v} should be removed`);
  }
});

test("cli has expected headline verbs", () => {
  const expected = [
    "ask", "carve", "commit-mutation",
    "add-decision", "add-ok", "add-risk", "add-constraint", "add-goal",
    "add-investigation", "add-rejected-option",
    "add-stakeholder", "add-resource", "add-milestone", "add-assumption",
    "add-agreement", "add-task", "add-source", "add-theme",
    "inspect", "checkpoint-mark"
  ];
  for (const v of expected) {
    assert.ok(isHeadlineVerb(v), `expected headline: ${v}`);
  }
});

test("listKnownVerbs returns all 38 verbs (18 primitive + 20 headline)", () => {
  const all = listKnownVerbs();
  assert.equal(all.length, 38);
  // Guard against a verb id being registered twice across the primitive/headline lists.
  assert.equal(new Set(all).size, all.length, "duplicate verb id across primitive/headline lists");
});

test("isHeadlineVerb / isPrimitiveVerb are disjoint", () => {
  for (const v of listKnownVerbs()) {
    if (isHeadlineVerb(v)) assert.equal(isPrimitiveVerb(v), false, `${v} double-classified`);
    else assert.ok(isPrimitiveVerb(v), `${v} not classified`);
  }
});

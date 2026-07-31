import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { filterPromptText, pickInjectable, railPrompt } from "./rail-prompt.ts";
import {
  composeRailContext, loadRailSeen, saveRailSeen, sanitizeSessionId,
  RAIL_MAX_ITEMS, RAIL_TOTAL_BUDGET_CHARS
} from "./rail-common.ts";

// ── filterPromptText: 機械生成メッセージ・信号ゼロは沈黙 ──────────────────────

test("filterPromptText: 実プロンプトは通し、機械生成クラスは理由付きで落とす", () => {
  assert.equal(filterPromptText("checkpoint の復元が効かないので調べたい"), null);
  assert.equal(filterPromptText("短い"), "too-short");
  assert.equal(filterPromptText("/graphrag-knowledge:graphrag-checkpoint"), "slash-command");
  assert.equal(filterPromptText("<system-reminder>..."), "markup");
  assert.equal(filterPromptText("[SYSTEM NOTIFICATION - NOT USER INPUT] ..."), "markup");
  assert.equal(filterPromptText("Caveat: The messages below were generated..."), "caveat");
  assert.equal(filterPromptText("Base directory for this skill: /Users/k/.claude/plugins/..."), "skill-preamble");
  assert.equal(filterPromptText("Another Claude session sent a message: <teammate-message ...>"), "teammate-message");
  assert.equal(filterPromptText("This session is being continued from a previous conversation..."), "session-continuation");
});

// ── pickInjectable: seen 除外と cap ──────────────────────────────────────────

test("pickInjectable: seen のノードを除外し、RAIL_MAX_ITEMS でキャップする", () => {
  const matches = ["a", "b", "c", "d", "e"].map((s) => ({
    node: { id: `decision:s:${s}`, type: "Decision", title: `title ${s}`, summary: `summary ${s}` }
  }));
  const items = pickInjectable(matches, new Set(["decision:s:b"]));
  assert.equal(items.length, RAIL_MAX_ITEMS);
  assert.deepEqual(items.map((i) => i.id), ["decision:s:a", "decision:s:c", "decision:s:d"]);
  assert.equal(items[0].headline, "summary a");
});

test("pickInjectable: state を保持する (superseded は superseded と見えることに価値がある)", () => {
  const items = pickInjectable(
    [{ node: { id: "decision:s:x", type: "Decision", title: "t", state: "superseded" } }],
    new Set()
  );
  assert.equal(items[0].state, "superseded");
});

// ── composeRailContext: 注入予算の強制 ───────────────────────────────────────

test("composeRailContext: title/headline はクリップされ、合計予算超過なら件数を削って収める", () => {
  const long = "こ".repeat(300);
  const items = ["a", "b", "c"].map((s) => ({ id: s, type: "Decision", title: long, headline: long }));
  const longHeader = "h".repeat(180); // クリップ後の3件 (~570字) + このヘッダで予算 700 を超えさせる
  const composed = composeRailContext("graphrag prompt rail", longHeader, items);
  assert.ok(composed, "1件は収まるはず");
  assert.ok(composed!.chars <= RAIL_TOTAL_BUDGET_CHARS, `budget: ${composed!.chars}`);
  assert.ok(composed!.ids.length < 3, "件数が削られている");
  assert.ok(!composed!.context.includes(long), "300字の title が素通りしていない (クリップ済み)");
});

test("composeRailContext: 空なら null (沈黙)", () => {
  assert.equal(composeRailContext("t", "h", []), null);
});

// ── seen-set: セッション別ファイルの roundtrip ────────────────────────────────

test("rail-seen: セッション別ファイルに保存・読込でき、別セッションと混ざらない", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grag-rail-seen-"));
  saveRailSeen(dir, { session_id: "sess1", updated_at: 0, injected_node_ids: ["n1"], touched_files: ["f1.ts"] });
  saveRailSeen(dir, { session_id: "sess2", updated_at: 0, injected_node_ids: ["n2"], touched_files: [] });
  assert.deepEqual(loadRailSeen(dir, "sess1").injected_node_ids, ["n1"]);
  assert.deepEqual(loadRailSeen(dir, "sess2").injected_node_ids, ["n2"]);
  assert.deepEqual(loadRailSeen(dir, "sess3").injected_node_ids, []);
});

test("sanitizeSessionId: ファイル名安全な形に落とし、空は null", () => {
  assert.equal(sanitizeSessionId("abc-123_XYZ"), "abc-123_XYZ");
  assert.equal(sanitizeSessionId("../../etc/passwd"), "etcpasswd");
  assert.equal(sanitizeSessionId("///"), null);
  assert.equal(sanitizeSessionId(undefined), null);
});

// ── railPrompt: fail-open (vault 不在で沈黙、例外を漏らさない) ─────────────────

test("railPrompt: vault が無い環境では brief-error で沈黙する (fail-open)", async () => {
  const prevVault = process.env.GRAPHRAG_VAULT_DIR;
  delete process.env.GRAPHRAG_VAULT_DIR;
  try {
    const r = await railPrompt("checkpoint の復元が効かないので調べたい", null);
    assert.equal(r.status, "silent");
  } finally {
    if (prevVault !== undefined) process.env.GRAPHRAG_VAULT_DIR = prevVault;
  }
});

test("railPrompt: フィルタ対象は brief を呼ぶ前に沈黙する", async () => {
  const r = await railPrompt("/graphrag-knowledge:graphrag-checkpoint を実行して", null);
  assert.deepEqual(r, { status: "silent", reason: "slash-command" });
});

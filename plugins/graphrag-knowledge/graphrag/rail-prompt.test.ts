import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { filterPromptText, pickInjectable, railPrompt } from "./rail-prompt.ts";
import {
  appendRailSeen, composeRailContext, loadRailSeen, sanitizeSessionId,
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

test("rail-seen: セッション別ファイルに追記・読込でき、別セッションと混ざらない", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grag-rail-seen-"));
  appendRailSeen(dir, "sess1", { nodeIds: ["n1"], list: "touch", files: ["f1.ts"] });
  appendRailSeen(dir, "sess2", { nodeIds: ["n2"] });
  assert.deepEqual(loadRailSeen(dir, "sess1").injected_node_ids, ["n1"]);
  assert.deepEqual(loadRailSeen(dir, "sess1").touched_files, ["f1.ts"]);
  assert.deepEqual(loadRailSeen(dir, "sess2").injected_node_ids, ["n2"]);
  assert.deepEqual(loadRailSeen(dir, "sess3").injected_node_ids, []);
});

test("rail-seen: append-only なので交互の load→append で更新が消えない (並列 Read 相当)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grag-rail-seen-race-"));
  // 旧実装 (read-modify-write) では A/B が同時に load した後の save で last-writer-wins に
  // なり片方の記録が消えた。append-only では両方残る。
  loadRailSeen(dir, "sess"); // A が load (空)
  loadRailSeen(dir, "sess"); // B が load (空)
  appendRailSeen(dir, "sess", { list: "read", files: ["a.ts"], nodeIds: ["nA"] }); // A が書く
  appendRailSeen(dir, "sess", { list: "read", files: ["b.ts"], nodeIds: ["nB"] }); // B が書く
  const merged = loadRailSeen(dir, "sess");
  assert.deepEqual(merged.read_files.sort(), ["a.ts", "b.ts"]);
  assert.deepEqual(merged.injected_node_ids.sort(), ["nA", "nB"]);
});

test("rail-seen: 旧形式 .json (v1.41.0 以前) も読み側で合流する (アップグレード互換)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grag-rail-seen-legacy-"));
  writeFileSync(
    path.join(dir, "rail-seen-old.json"),
    JSON.stringify({ injected_node_ids: ["legacy-node"], touched_files: ["t.ts"], read_files: ["r.ts"] })
  );
  appendRailSeen(dir, "old", { nodeIds: ["new-node"] });
  const seen = loadRailSeen(dir, "old");
  assert.deepEqual(seen.injected_node_ids.sort(), ["legacy-node", "new-node"]);
  assert.deepEqual(seen.touched_files, ["t.ts"]);
  assert.deepEqual(seen.read_files, ["r.ts"]);
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

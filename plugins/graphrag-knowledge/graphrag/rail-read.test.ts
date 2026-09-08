import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import { railRead } from "./rail-read.ts";
import { railTouch } from "./rail-touch.ts";
import { loadRailSeen, appendRailSeen, RAIL_COMBINED_BUDGET_CHARS } from "./rail-common.ts";

// rail-touch.test と同じ経路忠実主義: 合成 graph → 本物の vault ファイル経由。
function makeVault(graph: Record<string, unknown>): { vaultDir: string; cacheDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "grag-rail-read-"));
  const vaultDir = path.join(root, ".graphrag", "vault");
  for (const f of buildVaultFiles(graph as any)) {
    const abs = path.join(vaultDir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return { vaultDir, cacheDir: path.join(root, ".graphrag", "cache") };
}

const GRAPH = {
  nodes: [
    { id: "file:s:src/pay.ts", type: "File", title: "pay", path: "src/pay.ts", summary: "決済" },
    { id: "file:s:src/free.ts", type: "File", title: "free", path: "src/free.ts", summary: "配線なし" },
    { id: "constraint:s:no-sync-io", type: "Constraint", title: "決済経路で同期 IO 禁止", summary: "落ちる検査あり" },
    { id: "decision:s:retry-policy", type: "Decision", title: "リトライは指数バックオフ", summary: "なぜそうしたか" }
  ],
  edges: [
    { id: "e1", type: "constrains", from: "constraint:s:no-sync-io", to: "file:s:src/pay.ts" },
    { id: "e2", type: "documented_by", from: "decision:s:retry-policy", to: "file:s:src/pay.ts" }
  ]
};

const STRUCTURE = {
  id: "component:s:pay", type: "Component", title: "Payment",
  summary: "Payment responsibility. ".repeat(10) + "Never duplicate settlement authority."
};
const WITH_STRUCTURE = {
  nodes: [...GRAPH.nodes, STRUCTURE],
  edges: [...GRAPH.edges,
    { id: "s1", type: "evidenced_by", from: STRUCTURE.id, to: "file:s:src/pay.ts" },
    { id: "s2", type: "evidenced_by", from: STRUCTURE.id, to: "file:s:src/free.ts" }
  ]
};

function withVault(graph: Record<string, unknown>, fn: (cacheDir: string) => void) {
  const { vaultDir, cacheDir } = makeVault(graph);
  const prev = process.env.GRAPHRAG_VAULT_DIR;
  process.env.GRAPHRAG_VAULT_DIR = vaultDir;
  try {
    fn(cacheDir);
  } finally {
    if (prev !== undefined) process.env.GRAPHRAG_VAULT_DIR = prev;
    else delete process.env.GRAPHRAG_VAULT_DIR;
  }
}

test("railRead: 配線ありで注入 + read_files に記録、同一ファイル2回目は沈黙", () => {
  withVault(GRAPH, (cacheDir) => {
    const r1 = railRead("src/pay.ts", "sessA");
    assert.equal(r1.status, "inject");
    assert.ok(r1.context!.includes("graphrag read rail"));
    assert.ok(r1.chars! <= 700);

    const seen = loadRailSeen(cacheDir, "sessA");
    assert.ok(seen.read_files.includes("src/pay.ts"));
    assert.ok(seen.injected_node_ids.includes("constraint:s:no-sync-io"));
    assert.deepEqual(seen.touched_files, [], "touch レールの既読とは独立");

    const r2 = railRead("src/pay.ts", "sessA");
    assert.deepEqual(r2, { status: "silent", reason: "file-seen" });
  });
});

test("structure body delivery is independent of a previously injected prompt headline", () => {
  withVault(WITH_STRUCTURE, (cacheDir) => {
    appendRailSeen(cacheDir, "struct", { nodeIds: [STRUCTURE.id] });
    const result = railRead("src/pay.ts", "struct");
    assert.equal(result.status, "inject");
    assert.ok(result.context!.includes(STRUCTURE.summary));
    assert.deepEqual(result.structure_ids, [STRUCTURE.id]);
    assert.deepEqual(loadRailSeen(cacheDir, "struct").delivered_structure_ids, [STRUCTURE.id]);
    assert.deepEqual(railRead("src/pay.ts", "struct"), { status: "silent", reason: "file-seen" });
    assert.deepEqual(railRead("src/free.ts", "struct"), { status: "silent", reason: "all-seen" });
    assert.ok(railRead("src/free.ts", "another").context!.includes(STRUCTURE.summary), "new session gets the norm");
  });
});

test("structure output does not displace any existing knowledge and combined context is bounded", () => {
  let original = "";
  withVault(GRAPH, () => { original = railRead("src/pay.ts", "baseline").context!; });
  withVault(WITH_STRUCTURE, (cacheDir) => {
    const result = railRead("src/pay.ts", "combined");
    assert.ok(result.context!.includes(original), "the old complete knowledge block survives unchanged");
    assert.ok(result.context!.startsWith(original), "knowledge and its Constraints stay first");
    assert.ok(result.chars! <= RAIL_COMBINED_BUDGET_CHARS);
    const entry = JSON.parse(readFileSync(path.join(cacheDir, "rail-log.jsonl"), "utf8").trim());
    assert.equal(entry.knowledge_chars, original.length);
    assert.ok(entry.structure_chars <= 1000);
    assert.equal(entry.structure_bodies, 1);
    assert.equal(entry.chars, result.context!.length);
  });
});

test("three Constraints do not starve structure delivery or lose knowledge items", () => {
  const constraints = Array.from({ length: 3 }, (_, i) => ({ id: `constraint:s:c${i}`, type: "Constraint", title: "Constraint " + "t".repeat(100), summary: "c".repeat(150) }));
  const graph = {
    nodes: [...WITH_STRUCTURE.nodes, ...constraints],
    edges: [...WITH_STRUCTURE.edges, ...constraints.map((n, i) => ({ id: `c${i}`, type: "constrains", from: n.id, to: "file:s:src/pay.ts" }))]
  };
  let baseline = "";
  withVault({ nodes: graph.nodes, edges: graph.edges.filter((e) => e.type !== "evidenced_by") }, () => { baseline = railRead("src/pay.ts", "b").context!; });
  withVault(graph, () => {
    const result = railRead("src/pay.ts", "saturated");
    assert.ok(result.context!.includes(baseline));
    assert.ok(result.context!.includes(STRUCTURE.summary));
    assert.ok(result.chars! <= 1700);
  });
});

test("references to an oversized body do not mark its summary as delivered", () => {
  const graph = { ...WITH_STRUCTURE, nodes: WITH_STRUCTURE.nodes.map((n) => n.id === STRUCTURE.id ? { ...n, summary: "x".repeat(1200) } : n) };
  withVault(graph, (cacheDir) => {
    const first = railRead("src/pay.ts", "oversized");
    assert.deepEqual(first.structure_ids, []);
    assert.deepEqual(first.structure_omitted_ids, [STRUCTURE.id]);
    assert.deepEqual(loadRailSeen(cacheDir, "oversized").delivered_structure_ids, []);
    const second = railRead("src/free.ts", "oversized");
    assert.equal(second.status, "inject");
    assert.deepEqual(second.structure_omitted_ids, [STRUCTURE.id]);
  });
});

test("provisional and missing summaries stay un-authored across the stateful delivery path", () => {
  const graph = {
    ...WITH_STRUCTURE,
    nodes: [...WITH_STRUCTURE.nodes.map((n) => n.id === STRUCTURE.id ? { ...n, summary_provisional: true } : n),
      { id: "layer:s:empty", type: "Layer", title: "Empty", summary: "" }],
    edges: [...WITH_STRUCTURE.edges, { id: "empty", type: "evidenced_by", from: "layer:s:empty", to: "file:s:src/free.ts" }]
  };
  withVault(graph, (cacheDir) => {
    const result = railRead("src/free.ts", "provisional");
    assert.deepEqual(result.structure_ids, []);
    assert.deepEqual(result.structure_omitted_ids, []);
    assert.deepEqual(result.structure_unavailable_ids, [STRUCTURE.id, "layer:s:empty"]);
    assert.deepEqual(loadRailSeen(cacheDir, "provisional").delivered_structure_ids, []);
    assert.ok(!result.context!.includes(STRUCTURE.summary));
    const log = JSON.parse(readFileSync(path.join(cacheDir, "rail-log.jsonl"), "utf8").trim());
    assert.equal(log.structure_unavailable, 2);
    assert.equal(log.structure_omitted, 0);
  });
});

test("railRead: 配線ゼロのファイルは沈黙するが read_files には記録する (再走査抑止)", () => {
  withVault(GRAPH, (cacheDir) => {
    const r = railRead("src/free.ts", "sessB");
    assert.equal(r.status, "silent");
    assert.equal(r.reason, "unwired");
    assert.ok(loadRailSeen(cacheDir, "sessB").read_files.includes("src/free.ts"));
  });
});

test("railRead: 注入済みノードは touch レールと共有で再注入しない (全レール共有 seen)", () => {
  withVault(GRAPH, () => {
    assert.equal(railRead("src/pay.ts", "sessC").status, "inject");
    // 同ノードしか配線されていないファイルを touch しても all-seen で沈黙
    const t = railTouch("src/pay.ts", "sessC");
    assert.equal(t.status, "silent");
    assert.equal(t.reason, "all-seen");
  });
});

test("railRead: rail-log.jsonl に rail=read で発火が記録される。file-seen 沈黙も記録される", () => {
  withVault(GRAPH, (cacheDir) => {
    railRead("src/pay.ts", "sessD");
    railRead("src/pay.ts", "sessD"); // 2回目 = file-seen (hook fast-path と CLI が食い違った兆候の観測点)
    const log = path.join(cacheDir, "rail-log.jsonl");
    assert.ok(existsSync(log));
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const fired = lines.find((l) => l.rail === "read" && l.fired === true);
    assert.ok(fired, "fired=true の行がある");
    assert.equal(fired.file, "src/pay.ts");
    assert.ok(lines.some((l) => l.rail === "read" && l.reason === "file-seen"), "file-seen も記録される");
  });
});

test("railRead: 自レール内の all-seen — 同一ノードだけ配線の別ファイルは沈黙し read_files には載る", () => {
  const graph = {
    nodes: [
      { id: "file:s:src/a.ts", type: "File", title: "a", path: "src/a.ts", summary: "a" },
      { id: "file:s:src/b.ts", type: "File", title: "b", path: "src/b.ts", summary: "b" },
      { id: "decision:s:shared", type: "Decision", title: "共有判断", summary: "a/b 両方に配線" }
    ],
    edges: [
      { id: "e1", type: "documented_by", from: "decision:s:shared", to: "file:s:src/a.ts" },
      { id: "e2", type: "documented_by", from: "decision:s:shared", to: "file:s:src/b.ts" }
    ]
  };
  withVault(graph, (cacheDir) => {
    assert.equal(railRead("src/a.ts", "sessE").status, "inject");
    const r = railRead("src/b.ts", "sessE");
    assert.equal(r.status, "silent");
    assert.equal(r.reason, "all-seen");
    assert.ok(loadRailSeen(cacheDir, "sessE").read_files.includes("src/b.ts"), "沈黙でも再走査抑止に載る");
  });
});

test("railRead: セッション総量の上限は無い — 別配線のファイルは何件でも注入される (設計 pin)", () => {
  const N = 5;
  const nodes: any[] = [];
  const edges: any[] = [];
  for (let i = 0; i < N; i++) {
    nodes.push({ id: `file:s:src/f${i}.ts`, type: "File", title: `f${i}`, path: `src/f${i}.ts`, summary: "x" });
    nodes.push({ id: `decision:s:d${i}`, type: "Decision", title: `判断${i}`, summary: `f${i} の判断` });
    edges.push({ id: `e${i}`, type: "documented_by", from: `decision:s:d${i}`, to: `file:s:src/f${i}.ts` });
  }
  withVault({ nodes, edges }, () => {
    for (let i = 0; i < N; i++) {
      assert.equal(railRead(`src/f${i}.ts`, "sessF").status, "inject", `f${i} も注入される (総量予算で沈黙しない)`);
    }
  });
});

// ── hook → CLI 統合 (スタブなし・実 spawn): verb 名/引数配線/出力契約の一気通貫 ──

test("read-rail hook 統合: スタブなしで実 CLI を spawn し additionalContext が返る", () => {
  const { vaultDir } = (() => makeVault(GRAPH))();
  const root = path.resolve(vaultDir, "..", "..");
  writeFileSync(path.join(root, ".graphrag", ".env"), "GRAPHRAG_RAIL_READ=on\n");
  const hook = path.resolve(import.meta.dirname, "..", "hooks", "read-rail.mjs");
  const input = JSON.stringify({
    tool_name: "Read",
    tool_input: { file_path: path.join(root, "src", "pay.ts") },
    session_id: "sessInteg"
  });
  const out = execFileSync(process.execPath, [hook], {
    input,
    encoding: "utf8",
    env: { ...process.env, GRAPHRAG_VAULT_DIR: vaultDir, GRAPHRAG_READ_RAIL_CLI: "" }
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(parsed.hookSpecificOutput.additionalContext, /graphrag read rail/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /同期 IO|no-sync-io/);
});

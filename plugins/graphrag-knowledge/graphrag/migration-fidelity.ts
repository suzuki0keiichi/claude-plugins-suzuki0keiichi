import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchGraph } from "./retrieval.ts";
import { migrateV2Graph, reimportVaultFiles, canonicalizeId } from "./migrate-v2.ts";
import { canonicalType } from "./schema.ts";
import { buildVaultFiles } from "./build-vault.ts";
import { buildVectorIndex } from "./build-vector-index.ts";
import { resolveVectorProvider } from "./vector.ts";

type Graph = { nodes?: any[]; edges?: any[] };

// 各ノードの title と alias をクエリにする (重複除去・空は除外)。移行前後で
// 「あるものを探して同じものが引けるか」を網羅的・自動に確かめるため。
// alias も含めるのは検索が alias でもヒットするため (title だけだと取りこぼし)。
export function autoQueriesFromGraph(graph: Graph): string[] {
  const seen = new Set<string>();
  for (const n of graph.nodes ?? []) {
    const t = typeof n.title === "string" ? n.title.trim() : "";
    if (t) seen.add(t);
    for (const a of Array.isArray(n.aliases) ? n.aliases : []) {
      const s = typeof a === "string" ? a.trim() : "";
      if (s) seen.add(s);
    }
  }
  return [...seen];
}

// 移行の「意図的変換」(軸2 の type/id の canonical 化) を除いて、v2 入力そのものと
// after (最終 vault 再読込) を突き合わせる。これにより vault 往復の劣化「だけでなく」
// migrate ロジック自体のフィールド脱落・誤変換も捕捉する (before=migrate後 では
// 両側に同じバグが入り捕捉できない、というレビュー指摘への対応)。
export function compareAcrossMigration(v2: Graph, after: Graph, opts: any = {}): string[] {
  const nodeOverrides = opts.nodeOverrides ?? {};
  const edgeOverrides = opts.edgeOverrides ?? {};
  // migrate と同じ idMap: override.id 優先、無ければ canonicalizeId。
  const idMap = new Map<string, string>();
  for (const n of v2.nodes ?? []) {
    const ov = nodeOverrides[String(n.id)];
    idMap.set(String(n.id), ov && typeof ov.id === "string" ? ov.id : canonicalizeId(String(n.id)));
  }
  const mapId = (id: unknown) => idMap.get(String(id)) ?? canonicalizeId(String(id));

  // v3.3 整理構造の撤去 (vault=scope): migrate は root ノード (System/Product/
  // Project/Business) と contains を意図的に落とす。fidelity ゲートは「意図しない
  // 欠損」の検出器なので、この意図された撤去は比較母数から除外する。
  const ROOT_TYPES = new Set(["System", "Product", "Project", "Business"]);
  const failures: string[] = [];
  const v2Nodes = (v2.nodes ?? []).filter((n) => !ROOT_TYPES.has(String(n.type)));
  const afterNodes = after.nodes ?? [];
  if (v2Nodes.length !== afterNodes.length) {
    failures.push(`node count: v2 ${v2Nodes.length} != after ${afterNodes.length}`);
  }
  const afterById = new Map(afterNodes.map((n) => [String(n.id), n]));
  for (const src of v2Nodes) {
    const ov = nodeOverrides[String(src.id)] ?? {};
    const expectedId = mapId(src.id);
    const got = afterById.get(expectedId);
    if (!got) {
      failures.push(`node ${src.id} (→${expectedId}) missing after migration`);
      continue;
    }
    const expectedType = "type" in ov ? ov.type : canonicalType(src.type);
    if (src.type !== undefined && expectedType !== got.type) {
      failures.push(`node ${src.id}: type ${src.type}→${got.type} (expected ${expectedType})`);
    }
    for (const [k, v] of Object.entries(src)) {
      if (k === "id" || k === "type") continue; // 意図的変換
      const expected = k in ov ? ov[k] : v; // override されたフィールドは期待値も override
      try {
        assert.deepEqual(got[k], expected);
      } catch {
        failures.push(`node ${src.id}: field "${k}" changed by migration`);
      }
    }
  }
  const afterEById = new Map((after.edges ?? []).map((e) => [String(e.id), e]));
  for (const src of v2.edges ?? []) {
    if (String(src.type) === "contains") continue; // 意図された撤去 (v3.3)
    const ov = edgeOverrides[String(src.id)] ?? {};
    const got = afterEById.get(String(src.id));
    if (!got) {
      failures.push(`edge ${src.id} missing after migration`);
      continue;
    }
    for (const [k, v] of Object.entries(src)) {
      if (k === "from" || k === "to") {
        const expected = k in ov ? ov[k] : mapId(v);
        if (got[k] !== expected) {
          failures.push(`edge ${src.id}: ${k} ${v}→${got[k]} (expected ${expected})`);
        }
        continue;
      }
      const expected = k in ov ? ov[k] : v;
      try {
        assert.deepEqual(got[k], expected);
      } catch {
        failures.push(`edge ${src.id}: field "${k}" changed by migration`);
      }
    }
  }
  return failures;
}

// before で上位 limit に引けたノードが、after の上位 limit に出てこないものを
// 「取りこぼし」として報告する (順位は不問、recall のみ。ユーザー確定基準)。
// before/after で id が canonical 化でずれるため mapId で対応付ける (既定は恒等)。
export function searchRecallLoss(
  before: Graph,
  after: Graph,
  queries: string[],
  opts: any = {}
): string[] {
  const limit = opts.limit ?? 10;
  const mapId = opts.mapId ?? ((id: string) => id);
  const failures: string[] = [];
  for (const q of queries) {
    const b = searchGraph(before, q, {
      limit,
      vectorIndex: opts.beforeIndex,
      queryVector: opts.queryVectors?.[q]
    });
    const a = searchGraph(after, q, {
      limit,
      vectorIndex: opts.afterIndex,
      queryVector: opts.queryVectors?.[q]
    });
    const afterIds = new Set(a.map((m) => String(m.node.id)));
    for (const m of b) {
      if (!afterIds.has(mapId(String(m.node.id)))) {
        failures.push(`query "${q}": node ${m.node.id} retrievable before but not after`);
      }
    }
  }
  return failures;
}

export interface FidelityResult {
  v2: Graph;
  after: Graph;
  structureLoss: string[];
  recallLoss: string[];
}

// 移行忠実性チェック: v2 graph (移行前) を基準に、migrate → vault 書き戻し →
// 再読込した after と突き合わせる。
// (1) 構造: 意図的変換 (type/id の canonical 化) を除き v2 の全フィールドが after に
//     保たれるか (compareAcrossMigration) ── migrate のフィールド脱落も捕捉。
// (2) 検索リコール: v2 で引けたノードが after でも引けるか (取りこぼしゼロ、id 対応)。
// before を v2 入力にするのが要 ── before=migrate後 にすると migrate 自体のバグが
// before/after 両側に入り捕捉できない (レビュー指摘)。
export async function runFidelityCheck(v2Graph: Graph, deps: any = {}): Promise<FidelityResult> {
  // 確認済みの意味変換 (Requirement→Goal 等) は overrides で渡す。migrate と検証で
  // 同じ overrides を使い、意図的変換を劣化と誤検出しない。
  const overrides = deps.overrides ?? {};
  const nodeOverrides = overrides.nodeOverrides ?? {};
  const migrated = migrateV2Graph(v2Graph, overrides);
  const files = buildVaultFiles(migrated);
  const after = reimportVaultFiles(files);          // vault 書き戻し → 再読込
  const structureLoss = compareAcrossMigration(v2Graph, after, overrides);

  // recall 比較の before からも意図撤去分 (root/contains) を除外する。
  // 整理構造の検索可能性は「知識の取りこぼし」ではない (compareAcrossMigration と同じ理由)。
  const ROOT_TYPES = new Set(["System", "Product", "Project", "Business"]);
  const v2ForRecall = {
    ...v2Graph,
    nodes: (v2Graph.nodes ?? []).filter((n) => !ROOT_TYPES.has(String(n.type))),
    edges: (v2Graph.edges ?? []).filter((e) => String(e.type) !== "contains")
  };
  const queries = autoQueriesFromGraph(v2ForRecall);
  let beforeIndex: any;
  let afterIndex: any;
  let queryVectors: Record<string, number[]> | undefined;
  if (deps.provider) {
    beforeIndex = await buildVectorIndex({}, { provider: deps.provider, graphObject: v2ForRecall });
    afterIndex = await buildVectorIndex({}, { provider: deps.provider, graphObject: after });
    queryVectors = {};
    for (const q of queries) queryVectors[q] = await deps.provider.embed(q);
  }
  const recallLoss = searchRecallLoss(v2ForRecall, after, queries, {
    limit: deps.limit ?? 10,
    beforeIndex,
    afterIndex,
    queryVectors,
    mapId: (id: string) => {
      const ov = nodeOverrides[id];
      return ov && typeof ov.id === "string" ? ov.id : canonicalizeId(id);
    }
  });
  return { v2: v2Graph, after, structureLoss, recallLoss };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // 入力: v2 graph.json (falkor-export 出力)。CLI 引数 > GRAPHRAG_GRAPH_JSON_PATH env。
  const graphPath = argv[0] ?? process.env.GRAPHRAG_GRAPH_JSON_PATH;
  if (!graphPath) {
    console.error("Refusing to check: v2 graph.json input path is not specified.");
    console.error("Pass it as the first CLI argument or set GRAPHRAG_GRAPH_JSON_PATH env.");
    process.exit(1);
  }
  const v2 = JSON.parse(readFileSync(graphPath, "utf8"));
  // semantic 非交渉: 実 embedding provider を解決して検証する。
  const provider = await resolveVectorProvider({});
  const { v2: checked, structureLoss, recallLoss } = await runFidelityCheck(v2, { provider });
  console.log(JSON.stringify({
    checked: graphPath,
    nodes: checked.nodes?.length ?? 0,
    edges: checked.edges?.length ?? 0,
    structure_loss: structureLoss,
    recall_loss: recallLoss,
    verdict: structureLoss.length === 0 && recallLoss.length === 0 ? "no-loss" : "LOSS-DETECTED"
  }, null, 2));
  if (structureLoss.length > 0 || recallLoss.length > 0) process.exit(1);
}

// Standalone entry (build-vault.ts / migrate-v2.ts と同じ規律)
if (process.argv[1] && process.argv[1].endsWith("migration-fidelity.ts")) {
  await main();
}

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { canonicalType, validateGraph } from "./schema.ts";
import { importVaultFile } from "./import-vault.ts";
import { buildVaultFiles } from "./build-vault.ts";

type Rec = Record<string, unknown>;
export interface Graph {
  [key: string]: unknown;
  nodes?: Rec[];
  edges?: Rec[];
}

// id 規約 `<typeSlug>:<system>:<slug>` の先頭 typeSlug を canonical slug へ。
// NODE_TYPE_ALIASES (型名) に対応する小文字 slug。canonical は layer/concern/component。
const ID_SLUG_ALIASES: Record<string, string> = {
  stratum: "layer",
  vein: "concern",
  pocket: "component"
};

// id の先頭セグメント (最初の `:` まで) が軸2旧 slug なら新 slug に置換。
// 完全一致のみ (`concernX:...` は対象外)。`:` を含まない id は据え置き。
export function canonicalizeId(id: string): string {
  const idx = id.indexOf(":");
  if (idx < 0) return id;
  const seg = id.slice(0, idx);
  const canon = ID_SLUG_ALIASES[seg];
  return canon ? canon + id.slice(idx) : id;
}

export interface MigrateOverrides {
  // 呼び出し側 (確認済みの LLM 個別判断) が渡す意味変換。
  // migrate に盲目的一括ルールを焼かず、ここで明示する (例: Requirement→Goal)。
  nodeOverrides?: Record<string, { type?: string; id?: string; [k: string]: unknown }>;
  edgeOverrides?: Record<string, { type?: string; from?: string; to?: string; [k: string]: unknown }>;
}

// v2 graph → v3 graph。
// (1) 機械変換: 軸2 の type/id を canonical 化 (Stratum/Vein/Pocket →
//     Layer/Concern/Component、id 先頭 slug も)、edge の from/to を連動更新。
// (2) 意味変換: opts.nodeOverrides / edgeOverrides で呼び出し側が明示した変換を
//     適用 (Requirement→Goal 等の意味判断は盲目ルールにせず override で渡す)。
// 非軸2型・他フィールド・top-level メタ・edge id は verbatim。入力は破壊しない。
export function migrateV2Graph(graph: Graph, opts: MigrateOverrides = {}): Graph {
  const nodeOverrides = opts.nodeOverrides ?? {};
  const edgeOverrides = opts.edgeOverrides ?? {};

  // idMap: override の id 変更を優先し、無ければ機械的 canonicalizeId。
  const idMap = new Map<string, string>();
  for (const node of graph.nodes ?? []) {
    if (typeof node.id !== "string") continue;
    const ov = nodeOverrides[node.id];
    const newId = ov && typeof ov.id === "string" ? ov.id : canonicalizeId(node.id);
    if (newId !== node.id) idMap.set(node.id, newId);
  }
  const remap = (id: unknown) =>
    typeof id === "string" && idMap.has(id) ? idMap.get(id)! : id;

  const nodes = (graph.nodes ?? []).map((node) => {
    const next: Rec = { ...node };
    const ov = typeof node.id === "string" ? nodeOverrides[node.id] : undefined;
    if (ov) {
      Object.assign(next, ov); // 確認済みの型/id/他フィールド変換を適用
    } else if (typeof node.type === "string") {
      next.type = canonicalType(node.type); // 機械変換 (軸2)
    }
    if (typeof node.id === "string") next.id = remap(node.id);
    return next;
  });

  const edges = (graph.edges ?? []).map((edge) => {
    const next: Rec = { ...edge };
    const ov = typeof edge.id === "string" ? edgeOverrides[edge.id] : undefined;
    if (ov) {
      // 明示したフィールドのみ上書き。未指定の from/to は機械 remap。
      if ("type" in ov) next.type = ov.type;
      next.from = "from" in ov ? ov.from : remap(edge.from);
      next.to = "to" in ov ? ov.to : remap(edge.to);
    } else {
      if ("from" in edge) next.from = remap(edge.from);
      if ("to" in edge) next.to = remap(edge.to);
    }
    return next;
  });

  // (3) v3.3 整理構造の撤去 (vault=scope): root ノード (System/Product/Project/
  //     Business) と contains エッジは機械的に落とす。所属は vault 境界と id 規約が
  //     担うため情報損失はない。root 宛の他エッジ (constrains 等) は黙って落とさない
  //     — 残せば validateGraph が missing node で止まり、呼び出し側の edgeOverrides
  //     (個別判断の付け替え) を強制できる。意味変換を盲目ルールにしない方針と同じ。
  const ROOT_TYPES = new Set(["System", "Product", "Project", "Business"]);
  const keptNodes = nodes.filter((n) => !ROOT_TYPES.has(String(n.type)));
  const keptEdges = edges.filter((e) => e.type !== "contains");
  return { ...graph, nodes: keptNodes, edges: keptEdges };
}

function indexById(items: Rec[]): Map<string, Rec> {
  const m = new Map<string, Rec>();
  for (const it of items) m.set(String(it.id), it);
  return m;
}

// `generated_at` は build-vault が banner に焼く生成メタで、import-vault が banner から
// 復元する round-trip フィールド。移行元 node が per-node generated_at を持たなくても
// 再読込 node は banner 由来 (graph-level stamp) の generated_at を獲得する ── これは
// データ欠損ではなく生成物の付与。欠損ゲートは「元データが落ちたか」を見るものなので
// この付与を mismatch にしない (比較から generated_at を外して両者を突き合わせる)。
function stripGeneratedAt(node: Rec): Rec {
  if (!("generated_at" in node)) return node;
  const { generated_at, ...rest } = node;
  return rest;
}

// expected (canonical 化済み migrated graph) と actual (vault 再読込) を比較。
// 欠損 / count 不一致 / フィールド相違を返す。空配列 = round-trip 欠損ゼロ。
export function compareGraphs(expected: Graph, actual: Graph): string[] {
  const failures: string[] = [];
  const expNodes = indexById(expected.nodes ?? []);
  const actNodes = indexById(actual.nodes ?? []);
  if (expNodes.size !== actNodes.size) {
    failures.push(`node count: expected ${expNodes.size} got ${actNodes.size}`);
  }
  for (const [id, src] of expNodes) {
    const got = actNodes.get(id);
    if (!got) {
      failures.push(`missing node ${id}`);
      continue;
    }
    try {
      // generated_at は生成メタ (banner 由来) なので欠損比較から除外する。
      assert.deepEqual(stripGeneratedAt(got), stripGeneratedAt(src));
    } catch {
      failures.push(`node ${id} field mismatch`);
    }
  }
  const expEdges = indexById(expected.edges ?? []);
  const actEdges = indexById(actual.edges ?? []);
  if (expEdges.size !== actEdges.size) {
    failures.push(`edge count: expected ${expEdges.size} got ${actEdges.size}`);
  }
  for (const [id, src] of expEdges) {
    const got = actEdges.get(id);
    if (!got) {
      failures.push(`missing edge ${id}`);
      continue;
    }
    try {
      assert.deepEqual(got, src);
    } catch {
      failures.push(`edge ${id} field mismatch`);
    }
  }
  return failures;
}

// importVault のディスク走査を in-memory ファイル配列で行う版。
// relPath ソート + edge id dedup は importVault と同じ規律。
export function reimportVaultFiles(
  files: { relPath: string; content: string }[]
): { nodes: Rec[]; edges: Rec[] } {
  const sorted = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));
  const nodes: Rec[] = [];
  const edges: Rec[] = [];
  const seen = new Set<string>();
  for (const f of sorted) {
    const { node, edges: fileEdges } = importVaultFile(f.content);
    nodes.push(node);
    for (const e of fileEdges) {
      const id = typeof e.id === "string" ? e.id : JSON.stringify(e);
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push(e as Rec);
    }
  }
  return { nodes, edges };
}

export interface MigrationResult {
  migrated: Graph;
  files: { relPath: string; content: string }[];
  validationFailures: string[];
  lossReport: string[];
}

// v2 graph を migrate → validate → build vault → in-memory 再読込 → 欠損比較。
// lossReport が空配列 = spec §10.1 の移行完了ゲート (欠損ゼロ) を満たす。
export function runMigration(v2: Graph): MigrationResult {
  const migrated = migrateV2Graph(v2);
  const validationFailures = validateGraph(migrated);
  const files = buildVaultFiles(migrated);
  const reimported = reimportVaultFiles(files);
  const lossReport = compareGraphs(migrated, reimported);
  return { migrated, files, validationFailures, lossReport };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  // 入出力先: CLI 引数 > env > エラー停止 (build-vault.ts / import-vault.ts と同じ規律。
  // skill 配下 default は提供しない ── 利用先プロジェクトの知識を skill repo に混入させない)。
  const graphPath = argv[0] ?? process.env.GRAPHRAG_GRAPH_JSON_PATH;
  const outDir = argv[1] ?? process.env.GRAPHRAG_VAULT_DIR;
  if (!graphPath) {
    console.error("Refusing to migrate: v2 graph.json input path is not specified.");
    console.error("Pass it as the first CLI argument or set GRAPHRAG_GRAPH_JSON_PATH env.");
    process.exit(1);
  }
  if (!outDir) {
    console.error("Refusing to migrate: v3 vault output directory is not specified.");
    console.error("Pass it as the second CLI argument or set GRAPHRAG_VAULT_DIR env.");
    process.exit(1);
  }
  const v2 = JSON.parse(readFileSync(graphPath, "utf8"));
  const { migrated, files, validationFailures, lossReport } = runMigration(v2);
  if (validationFailures.length > 0) {
    console.error("Refusing to migrate: migrated graph is invalid (vault NOT written):");
    for (const f of validationFailures) console.error(`- ${f}`);
    process.exit(1);
  }
  if (lossReport.length > 0) {
    console.error("Refusing to migrate: round-trip would lose data (vault NOT written):");
    for (const f of lossReport) console.error(`- ${f}`);
    process.exit(1);
  }
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  for (const f of files) {
    const abs = path.join(outDir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  console.log(JSON.stringify({
    migrated_from: graphPath,
    vault: outDir,
    nodes: migrated.nodes?.length ?? 0,
    edges: migrated.edges?.length ?? 0,
    round_trip_loss: 0
  }, null, 2));
}

// Standalone entry (build-vault.ts / import-vault.ts と同じ規律)
if (process.argv[1] && process.argv[1].endsWith("migrate-v2.ts")) {
  main();
}

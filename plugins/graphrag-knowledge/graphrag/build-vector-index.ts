import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveVectorProvider, nodeVectorText, prefixPolicyForModel } from "./vector.ts";
import { graphDiff } from "./diff.ts";
import { importVault } from "./import-vault.ts";
import { defaultVectorIndexPath } from "./retrieval.ts";

// v3: vault が単一正本。索引は vault からのみ構築する (FalkorDB / graph.json
// fallback は撤廃 ── 両方から読めると完全移行が終わらないため一本化)。
async function resolveGraphForIndex(args) {
  if (!args.vault) {
    throw new Error(
      "vault directory required to build the index. Pass --vault or set GRAPHRAG_VAULT_DIR. " +
      "(v3: vault is the single source of truth.)"
    );
  }
  return importVault(args.vault);
}

export async function buildVectorIndex(args, deps: any = {}) {
  // vault からの差分 (base delta) ビルドは未対応 (v3.x)。vault current と
  // graph.json/FalkorDB base はノード表現が異なり graphDiff が誤検出するため、
  // 黙って壊れた delta を出さず明示エラーにする (no-silent-failure)。
  if (args.vault && args.base) {
    throw new Error(
      "vault + base 併用は未対応: vault からの差分 (base delta) ビルドは v3.x。--vault と --base を同時指定しないでください。"
    );
  }
  // deps.graphObject はテスト/DI がグラフを直渡しするためのフック (loadGraph を迂回)。
  // CLI 由来の args は汚さない (parseArgs は graphObject を生成しない)。
  const graph = deps.graphObject ?? await resolveGraphForIndex(args);
  // base delta (差分ビルド) は v3 では未対応。vault+base は上で明示エラー済み。
  const baseGraph = null;
  // provider 注入: deps.provider があれば外部 endpoint 解決を迂回 (semantic 非交渉は不変)。
  const provider = deps.provider ?? await resolveVectorProvider({
    provider: args.provider,
    endpoint: args.endpoint,
    model: args.model,
    dimensions: args.dimensions
  });
  // R1 接頭辞ポリシー: --prefix-policy auto|off (既定 auto)。provider のモデルが
  // 登録モデル (nomic-embed-text 等) なら document/query 接頭辞を確定し、index メタ
  // (prefix_policy) に記録する。off / 未登録モデルは接頭辞なし=従来挙動。
  const prefixMode: "auto" | "off" = args.prefixPolicy === "off" ? "off" : "auto";
  const prefixPolicy = prefixPolicyForModel(provider.metadata?.model, prefixMode);
  const documentPrefix = prefixPolicy?.document ?? "";
  // ポリシーが変わったら (接頭辞の有無/中身が変わる) 既存ベクトルは別空間なので
  // 再利用しない。reusablePreviousRows は provider 同一性しか見ないので、ここで
  // 前回索引のポリシーと突き合わせて不一致なら cold build に落とす。
  const previousRows = samePrefixPolicy(deps.previousIndex, prefixPolicy)
    ? reusablePreviousRows(deps.previousIndex, provider)
    : [];
  const nodes = selectNodesForVectorIndex(graph, baseGraph);
  // provisional 要約 (機械テンプレ = 構成要素サマリ) のノードは nodeVectorText が embedding
  // から除外するが、残っていること自体が「意味への書き換え未完」のサインなので警告する。
  const provisionalCount = nodes.filter((n: any) => n.summary_provisional === true).length;
  if (provisionalCount > 0) {
    console.error(
      `[warn] 要約がテンプレのまま (summary_provisional): ${provisionalCount}件 (File / Component / Layer 等)。` +
      `embedding からは除外したが、意味の要約に書き換えないと検索・vein-hint の品質が落ちる。`
    );
  }
  const rows = await embedNodesIncremental(nodes, provider, previousRows, documentPrefix);
  const dimensions = rows[0]?.dimensions ?? provider.dimensions ?? null;

  return {
    version: 1,
    provider: provider.id,
    provider_capability: provider.capability,
    semantic: provider.semantic,
    dimensions,
    provider_options: provider.semantic ? {
      endpoint: provider.metadata.endpoint,
      model: provider.metadata.model
    } : {},
    // R1: 接頭辞ポリシーを適用した時だけメタに記録する。クエリ側はこの有無を見て
    // query 接頭辞を付けるか決める (メタ無し=旧 index は付けない=互換)。
    ...(prefixPolicy ? { prefix_policy: { document: prefixPolicy.document, query: prefixPolicy.query } } : {}),
    graph_version: graph.version ?? null,
    generated_at: new Date().toISOString(),
    branch_delta: baseGraph ? describeBranchDelta(baseGraph, graph, args.base) : undefined,
    rows
  };
}

// embedding 入力テキストの内容ハッシュ。node.id は nodeVectorText が意図的に除外する
// (id canonical 化で埋め込みが動かないため) ので、id 改名は hash を変えない=ベクトル再利用可。
// documentPrefix (R1 接頭辞) を含めるので、ポリシー変更で実際の埋め込み入力が変われば
// hash も変わり、増分ビルドが古いベクトルを誤って使い回さない。
export function vectorTextHash(node, documentPrefix = ""): string {
  return createHash("sha256").update(`${documentPrefix}${nodeVectorText(node)}`).digest("hex");
}

// 前回索引と今回のポリシーが一致するか (接頭辞の有無/中身が同じか)。null 同士も一致。
// 不一致なら埋め込み空間が違うので前回ベクトルは再利用不可。
function samePrefixPolicy(previousIndex, policy): boolean {
  const prev = previousIndex?.prefix_policy ?? null;
  const prevDoc = prev && typeof prev.document === "string" ? prev.document : null;
  const curDoc = policy?.document ?? null;
  return prevDoc === curDoc;
}

// 前回索引のベクトルを再利用してよいかは provider の同一性で決める。provider id /
// semantic 種別 / モデル / 次元のどれかが違えば埋め込み空間が異なるので使い回さない。
function reusablePreviousRows(previousIndex, provider): any[] {
  if (!previousIndex || !Array.isArray(previousIndex.rows)) return [];
  if (previousIndex.provider !== provider.id) return [];
  if (previousIndex.semantic !== provider.semantic) return [];
  const prevModel = previousIndex.provider_options?.model ?? null;
  const curModel = provider.metadata?.model ?? null;
  if (prevModel !== curModel) return [];
  if (
    previousIndex.dimensions != null && provider.dimensions != null &&
    previousIndex.dimensions !== provider.dimensions
  ) return [];
  return previousIndex.rows;
}

// previousRows にある (同じ node_id かつ embedding 入力が不変 = text_hash 一致) ノードは
// 既存ベクトルを使い回し、新規/変更ノードだけ provider.embed する。索引は再生成可能な
// 二次生成物なので毎 mutation で全ノードを逐次再 embedding する必要はない (旧実装は全件・
// 逐次でロック窓を O(N×ネットワーク往復) に肥大化させ、endpoint ハング時は窓が∞になった)。
export async function embedNodesIncremental(nodes, provider, previousRows: any[] = [], documentPrefix = "") {
  const prevById = new Map<string, any>();
  for (const r of previousRows ?? []) {
    if (r && typeof r.node_id === "string") prevById.set(r.node_id, r);
  }
  const rows = [];
  for (const node of nodes) {
    const text_hash = vectorTextHash(node, documentPrefix);
    const prev = prevById.get(node.id);
    if (prev && prev.text_hash === text_hash && Array.isArray(prev.vector) && prev.vector.length > 0) {
      rows.push({ node_id: node.id, dimensions: prev.dimensions ?? prev.vector.length, vector: prev.vector, text_hash });
    } else {
      // R1: 登録モデルなら document 接頭辞付きで埋め込む (未登録/off は空接頭辞=従来)。
      const vector = await provider.embed(`${documentPrefix}${nodeVectorText(node)}`);
      rows.push({ node_id: node.id, dimensions: vector.length, vector, text_hash });
    }
  }
  return rows;
}

// 後方互換: 全件 cold embed (previousRows 無し)。既存呼び出し元と挙動同一。
export async function embedNodes(nodes, provider) {
  return embedNodesIncremental(nodes, provider, []);
}

export function selectNodesForVectorIndex(graph, baseGraph = null) {
  if (!baseGraph) return graph.nodes ?? [];
  const delta = graphDiff(baseGraph, graph);
  return [
    ...delta.nodes.added,
    ...delta.nodes.modified.map((item) => item.after)
  ];
}

function describeBranchDelta(baseGraph, graph, basePath) {
  const delta = graphDiff(baseGraph, graph);
  return {
    base: basePath,
    nodes_added: delta.nodes.added.length,
    nodes_modified: delta.nodes.modified.length,
    rows: delta.nodes.added.length + delta.nodes.modified.length
  };
}

// 書き込み途中の半端なファイルを残さない: 同一フォルダの一時ファイルに全部
// 書いてから rename で置き換える (同一ファイルシステム上の rename は原子的)。
// 複数エージェントが同じ索引を作り直しても壊れない (同時の場合は後勝ち=索引は
// 二次生成物なので許容、ロックは張らない)。
export async function writeFileAtomic(outPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, outPath);
}

// 索引を構築し、原子的に out へ書き出して書き込んだ絶対パスを返す。
// buildVectorIndex は payload を「計算して返すだけ」(ディスクには触れない) なので、
// 実際の書き出しはこの helper と main だけが行う。mutation 経路の既定 index ビルドも
// これを呼ぶ ── buildVectorIndex を直に呼ぶと計算した索引を捨てて vector.json が
// 更新されない事故になる (commit-mutation が index_status:ok でも索引据え置き、の原因)。
export async function buildAndWriteVectorIndex(args, deps: any = {}): Promise<string> {
  if (!args.out) {
    throw new Error(
      "Refusing to build vector index: output path is not specified. " +
      "Pass out (an index path) or vault (index goes next to the vault)."
    );
  }
  const outPath = path.resolve(args.out);
  // 既存索引を再利用ベースとして読み込む (増分 embedding)。deps.previousIndex が明示指定
  // されていればそちらを尊重する (テスト/DI 用)。壊れている/無い場合は cold build。
  let effectiveDeps = deps;
  if (deps.previousIndex === undefined) {
    const previousIndex = await readExistingIndex(outPath);
    if (previousIndex) effectiveDeps = { ...deps, previousIndex };
  }
  const payload = await buildVectorIndex(args, effectiveDeps);
  await writeFileAtomic(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  return outPath;
}

async function readExistingIndex(outPath: string): Promise<any> {
  try {
    return JSON.parse(await readFile(outPath, "utf8"));
  } catch {
    return null; // 無い/壊れている → 全件 cold build
  }
}

export async function main(argv, deps: any = {}) {
  const args = parseArgs(argv);
  if (!args.out) {
    console.error("Refusing to build vector index: output path is not specified.");
    console.error("Pass --vault <dir> (index goes next to the vault), or --out <path>, or set GRAPHRAG_VECTOR_INDEX_PATH env.");
    console.error("(No default under the skill directory is provided — the vector index belongs to the consuming project.)");
    process.exit(1);
  }
  const outPath = await buildAndWriteVectorIndex(args, deps);
  console.log(outPath);
}

export function parseArgs(argv) {
  const parsed: any = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      parsed[key] = value;
      index += 1;
    }
  }
  // 入出力 path の決定: CLI 引数 > env > undefined (main で reject)
  // skill 配下 default は提供しない (利用先プロジェクトの vector-index がスキルリポジトリに混入するのを避ける)
  // v3: 入力は vault のみ (FalkorDB / graph.json 引数は撤廃)。
  const vault = typeof parsed.vault === "string" ? parsed.vault : process.env.GRAPHRAG_VAULT_DIR;
  const vaultResolved = typeof vault === "string" && vault.length > 0 ? vault : undefined;
  let out = typeof parsed.out === "string" ? parsed.out : process.env.GRAPHRAG_VECTOR_INDEX_PATH;
  // --out 未指定で --vault があれば、vault の隣を既定の出力先にする。
  if ((typeof out !== "string" || out.length === 0) && vaultResolved) {
    out = defaultVectorIndexPath(vaultResolved);
  }
  const base = typeof parsed.base === "string" ? parsed.base : process.env.GRAPHRAG_VECTOR_INDEX_BASE;
  return {
    vault: vaultResolved,
    base: typeof base === "string" && base.length > 0 ? base : undefined,
    out: typeof out === "string" && out.length > 0 ? out : undefined,
    provider: typeof parsed.provider === "string" ? parsed.provider : undefined,
    endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : undefined,
    model: typeof parsed.model === "string" ? parsed.model : undefined,
    dimensions: typeof parsed.dimensions === "string" ? Number(parsed.dimensions) : undefined,
    // R1: --prefix-policy auto|off (既定 auto)。off で接頭辞ポリシーを無効化。
    prefixPolicy: parsed["prefix-policy"] === "off" ? "off" : "auto"
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

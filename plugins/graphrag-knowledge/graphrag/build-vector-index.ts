import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveVectorProvider, nodeVectorText, prefixPolicyForModel, embedTextsWithProvider } from "./vector.ts";
import { importVault } from "./import-vault.ts";
import { defaultVectorIndexPath } from "./retrieval.ts";
import { readVaultConsistentWithSeq } from "./vault-lock.ts";
import { cacheDirForVault } from "./cli-env.ts";

// v3: vault が単一正本。索引は vault からのみ構築する (FalkorDB / graph.json
// fallback は撤廃 ── 両方から読めると完全移行が終わらないため一本化)。
//
// issue #27: 読みは検索経路 (retrieval.loadGraph) と同じ seqlock 一貫読み
// (readVaultConsistentWithSeq)。writer 進行中 (seq 奇数) の torn snapshot
// (一部新・一部旧) から索引を作らない。vault_head も同じ安定窓の中で取る —
// seq が読みの前後で不変 = graph / head / seq の三点が同一 snapshot 由来。
// (embed 完了後に head を取ると、embed 中の commit で rows は snapshot A・
//  head は B という嘘の打刻になる。)
async function resolveGraphForIndex(args): Promise<{ graph: any; vaultHead: string | null; snapshotSeq: number }> {
  if (!args.vault) {
    throw new Error(
      "vault directory required to build the index. Pass --vault or set GRAPHRAG_VAULT_DIR. " +
      "(v3: vault is the single source of truth.)"
    );
  }
  const { data, seq } = await readVaultConsistentWithSeq(
    cacheDirForVault(args.vault),
    () => ({ graph: importVault(args.vault), vaultHead: tryVaultHead(args.vault) })
  );
  return { graph: data.graph, vaultHead: data.vaultHead, snapshotSeq: seq };
}

export async function buildVectorIndex(args, deps: any = {}) {
  // deps.graphObject はテスト/DI がグラフを直渡しするためのフック (loadGraph を迂回)。
  // CLI 由来の args は汚さない (parseArgs は graphObject を生成しない)。
  // base/delta (差分ビルド) は撤去済み: v3 は vault 単一正本の全量ビルドのみ
  // (issue #30 — 書けない delta の読み口だけが残る半端を許さない)。
  //
  // issue #27: snapshot 打刻 (vault_head / snapshot_seq) は build 開始時 = graph と
  // 同じ snapshot から取る。graphObject 直渡し (DI) 経路でも head は embed の前に取る
  // (embed 後だと embed 中の commit で rows と head が別 snapshot になる)。
  let graph: any;
  let snapshotSeq: number | null = typeof deps.snapshotSeq === "number" ? deps.snapshotSeq : null;
  let vaultHeadStamp: string | null;
  if (deps.graphObject !== undefined) {
    graph = deps.graphObject;
    vaultHeadStamp = args.vault ? tryVaultHead(args.vault) : null;
  } else {
    const snap = await resolveGraphForIndex(args);
    graph = snap.graph;
    snapshotSeq = snap.snapshotSeq;
    vaultHeadStamp = snap.vaultHead;
  }
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
  const nodes = selectNodesForVectorIndex(graph);
  // provisional 要約 (機械テンプレ = 構成要素サマリ) のノードは nodeVectorText が embedding
  // から除外するが、残っていること自体が「意味への書き換え未完」のサインなので警告する。
  const provisionalCount = nodes.filter((n: any) => n.summary_provisional === true).length;
  if (provisionalCount > 0) {
    console.error(
      `[warn] summaries still template-only (summary_provisional): ${provisionalCount} node(s) (File / Component / Layer, etc.). ` +
      `Excluded from embedding, but until rewritten into meaningful summaries, search / concern-hint quality drops.`
    );
  }
  const rows = await embedNodesIncremental(nodes, provider, previousRows, documentPrefix);
  const dimensions = rows[0]?.dimensions ?? provider.dimensions ?? null;

  // コーパスのノイズ床 (ランダムなノード対の cosine 分布) を打刻する。confidence 判定
  // (confidence.ts) が top1 cosine を絶対値でなくコーパス相対マージンで採点するための
  // 基準。決定論 (seeded PRNG + node_id ソート) なので同じ索引からは同じ値が出る。
  const noiseBaseline = computeNoiseBaseline(rows);

  // 打刻 (issue #27):
  // - vault_head: どの vault HEAD から構築されたか (best-effort、build 開始時 snapshot の値)。
  //   git 外/unborn は打刻無し。書き込み時重複ゲートの fallback 判定が使う。
  // - graph_fingerprint: 索引対象ノードの内容指紋。dirty vault / 非 git vault でも
  //   「rows がどの graph 内容から作られたか」について真を語る (head は working tree と
  //   ずれ得るが、fingerprint は build に使った graph そのもの)。
  // - snapshot_seq: seqlock の確定世代。同じ vault (同じ cache dir) の builder 同士の
  //   新旧比較 (踏み潰し防止) の高速パスに使う (同一 cache 世代内でのみ単調 — PR #41、
  //   世代を跨ぐ判定は fingerprint fallback が担う)。
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
    ...(noiseBaseline ? { noise_baseline: noiseBaseline } : {}),
    ...(vaultHeadStamp ? { vault_head: vaultHeadStamp } : {}),
    graph_fingerprint: computeGraphFingerprint(graph),
    ...(snapshotSeq != null ? { snapshot_seq: snapshotSeq } : {}),
    rows
  };
}

// issue #27: content fingerprint — 索引対象ノードの `node_id + vectorTextHash` を id 順
// ソートして sha256。git HEAD と違い dirty vault / 非 git vault でも「この索引がどの
// graph 内容から作られたか」を正確に指す。接頭辞ポリシーには依存させない (fingerprint は
// snapshot の同一性のための打刻で、埋め込み空間の同一性は provider/prefix メタが担う)。
export function computeGraphFingerprint(graph): string {
  const parts = selectNodesForVectorIndex(graph)
    .map((node: any) => `${node.id}\0${vectorTextHash(node)}`)
    .sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

// ── noise baseline: コーパス相対 confidence の基準値 ─────────────────────────
// ランダムなノード対 (最大 NOISE_BASELINE_PAIRS 対、seeded PRNG で決定論) の
// cosine の median / p90 を返す。ベクトルは正規化済み (createVectorProvider の
// normalizeVector) なので内積 = cosine。行が 2 未満なら null (基準を出せない)。
const NOISE_BASELINE_PAIRS = 400;
const NOISE_BASELINE_SEED = 42;

// mulberry32: 依存無しの決定論 PRNG。乱数品質は問わない (サンプリング用)。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeNoiseBaseline(rows: any[]): { median_cosine: number; p90_cosine: number; pairs: number } | null {
  const usable = (rows ?? [])
    .filter((row) => Array.isArray(row?.vector) && row.vector.length > 0)
    .sort((a, b) => String(a.node_id).localeCompare(String(b.node_id)));
  if (usable.length < 2) return null;
  const random = mulberry32(NOISE_BASELINE_SEED);
  const sims: number[] = [];
  const attempts = Math.min(NOISE_BASELINE_PAIRS, usable.length * (usable.length - 1));
  for (let i = 0; i < attempts; i += 1) {
    const a = Math.floor(random() * usable.length);
    const b = Math.floor(random() * usable.length);
    if (a === b) continue;
    const va = usable[a].vector;
    const vb = usable[b].vector;
    const length = Math.min(va.length, vb.length);
    let sum = 0;
    for (let k = 0; k < length; k += 1) sum += va[k] * vb[k];
    sims.push(sum);
  }
  if (sims.length === 0) return null;
  sims.sort((left, right) => left - right);
  const at = (q: number) => sims[Math.min(sims.length - 1, Math.floor(sims.length * q))];
  return {
    median_cosine: Number(at(0.5).toFixed(4)),
    p90_cosine: Number(at(0.9).toFixed(4)),
    pairs: sims.length
  };
}

// vault の現 HEAD sha (打刻用)。git 外 / unborn branch は null (打刻しない)。
export function tryVaultHead(vaultDir: string): string | null {
  try {
    return execFileSync("git", ["-C", vaultDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim() || null;
  } catch {
    return null;
  }
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
  // issue #31: miss (新規/変更ノード) は 1 件ずつ embed せず、node 順のままバッチで
  // まとめて送る (embedTextsWithProvider — embedMany 非対応 provider へは直列 fallback)。
  // rows の順序は従来どおり nodes の順 (決定論)。dedup は導入しない (順序維持を優先)。
  const rows = new Array(nodes.length);
  const missSlots: { at: number; node: any; text_hash: string }[] = [];
  const missTexts: string[] = [];
  nodes.forEach((node, at) => {
    const text_hash = vectorTextHash(node, documentPrefix);
    const prev = prevById.get(node.id);
    if (prev && prev.text_hash === text_hash && Array.isArray(prev.vector) && prev.vector.length > 0) {
      rows[at] = { node_id: node.id, dimensions: prev.dimensions ?? prev.vector.length, vector: prev.vector, text_hash };
    } else {
      // R1: 登録モデルなら document 接頭辞付きで埋め込む (未登録/off は空接頭辞=従来)。
      missSlots.push({ at, node, text_hash });
      missTexts.push(`${documentPrefix}${nodeVectorText(node)}`);
    }
  });
  const vectors = await embedTextsWithProvider(provider, missTexts);
  missSlots.forEach((slot, i) => {
    const vector = vectors[i];
    rows[slot.at] = { node_id: slot.node.id, dimensions: vector.length, vector, text_hash: slot.text_hash };
  });
  return rows;
}

// 後方互換: 全件 cold embed (previousRows 無し)。既存呼び出し元と挙動同一。
export async function embedNodes(nodes, provider) {
  return embedNodesIncremental(nodes, provider, []);
}

export function selectNodesForVectorIndex(graph) {
  return graph.nodes ?? [];
}

// issue #34: 索引の鮮度判定 = 読み込み済み graph と index の内容突合。
// selectNodesForVectorIndex(graph) の node_id 集合が rows と一致し、かつ各ノードの
// vectorTextHash (index に記録された prefix_policy の document 接頭辞で計算) が
// rows の text_hash と一致すれば fresh。追加/削除/変更のどれでも false になる —
// mtime 判定と違いファイル削除も検出できる。prefix は index 自身の記録値を使う
// (索引が自分の内容と整合しているかを問う。provider/model の互換は従来どおり
// 再 build 時の reusablePreviousRows / query 時の assertEmbeddingModelAvailable が見る)。
export function vectorIndexMatchesGraph(graph, index): boolean {
  if (!index || !Array.isArray(index.rows)) return false;
  const prefix = typeof index.prefix_policy?.document === "string" ? index.prefix_policy.document : "";
  const nodes = selectNodesForVectorIndex(graph);
  if (nodes.length !== index.rows.length) return false;
  const rowHashById = new Map<string, string>();
  for (const row of index.rows) {
    if (!row || typeof row.node_id !== "string" || typeof row.text_hash !== "string") return false;
    rowHashById.set(row.node_id, row.text_hash);
  }
  if (rowHashById.size !== nodes.length) return false; // 重複 node_id = 不整合
  for (const node of nodes) {
    if (rowHashById.get(node.id) !== vectorTextHash(node, prefix)) return false;
  }
  return true;
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

// issue #27: 「自分の書き込みが索引を古い世代へ退行させるか」の rename 直前判定。
// 1. fingerprint 一致 → 既存と同一 snapshot 内容 → 書いても退行しない (無害な早期判定)。
// 2. 主裁定 (PR #41 再指摘): vault の現 graph を読めるなら、seq に関係なく常に
//    「既存 index が現 graph と内容一致するか」で裁定する。一致するなら既存が真に
//    fresh なので自分は破棄 (skip)、一致しないなら seq がどうであれ現実と乖離した
//    index を守る意味はない (索引は二次生成物で、真実は graph 側) ので書く。
//    seq を先に見ない理由: seq は同じ vault の cache dir を共有する builder 同士で
//    しか単調でなく、cache 初期化 (seq は 0 に戻る — cli-env.ts が設計上許容と明文化)
//    や別 GRAPHRAG_STATE_DIR が同じ out を共有した場合は seq 空間が別物になる。
//    v1.39.4 は「既存が高 seq → 即 skip」の向きだけ塞いだが、逆向き —
//    「現 graph と一致する既存 (新 seq 空間で低 seq) を、旧 seq 空間の高 seq stale
//    builder が existing.seq <= payload.seq の高速パスで上書きできる」— が残っていた。
//    内容一致を常に主裁定にすることで両方向とも塞がる:
//    (a) stale builder (低 seq) → 既存 (新) が現 graph と一致 → skip。
//    (b) cache 初期化後、現 graph と乖離した旧世代 index (高 seq) → 不一致 → 書く。
//    (c) 旧世代の高 seq builder → 既存 (新、低 seq) が現 graph と一致 → skip。
// 3. seq 比較は「現 graph を読めない時の最終 fallback」に格下げ: vault が渡らない
//    経路や graph 読み失敗時のみ、既存 > 自分 なら退行とみなす。それも比較不能なら
//    従来どおり後勝ち。書き込み時の graph 読みコストは v1.39.4 の fallback 経路で
//    既に払っていたものと同等 (読みは cache 済み)。
export async function indexWriteWouldRegress(payload: any, existing: any, vaultDir?: string): Promise<boolean> {
  if (!existing || typeof existing !== "object") return false;
  if (
    typeof existing.graph_fingerprint === "string" &&
    existing.graph_fingerprint === payload.graph_fingerprint
  ) return false;
  const seqVerdict =
    typeof existing.snapshot_seq === "number" &&
    typeof payload.snapshot_seq === "number" &&
    existing.snapshot_seq > payload.snapshot_seq;
  if (!vaultDir) return seqVerdict; // graph が渡らない経路は現状維持 (seq 比較 or 後勝ち)
  try {
    const { data } = await readVaultConsistentWithSeq(
      cacheDirForVault(vaultDir),
      () => importVault(vaultDir)
    );
    return vectorIndexMatchesGraph(data, existing);
  } catch {
    return seqVerdict; // 現 graph を読めない → 判定不能 → 現状維持 (seq 比較 or 後勝ち)
  }
}

// 索引を構築し、原子的に out へ書き出して書き込んだ絶対パスを返す。
// buildVectorIndex は payload を「計算して返すだけ」(ディスクには触れない) なので、
// 実際の書き出しはこの helper と main だけが行う。mutation 経路の既定 index ビルドも
// これを呼ぶ ── buildVectorIndex を直に呼ぶと計算した索引を捨てて vector.json が
// 更新されない事故になる (commit-mutation が index_status:ok でも索引据え置き、の原因)。
//
// issue #27: rename 直前に既存 index の snapshot 打刻 (seq / fingerprint) を読み、自分の
// snapshot の方が古ければ書き込みを破棄する ({ skipped: true }、エラーにはしない)。
// ロックは導入しない — 索引は二次生成物・後勝ちの無ロック方針は維持する。read→rename の
// 小さな TOCTOU 窓 (この比較の直後に新しい index を踏み潰す) は許容: 負けても一世代古い
// 索引が残るだけで、#34 の内容突合 (vectorIndexMatchesGraph) が次の読みで stale を検出し
// 再 build する (自己修復)。
export async function buildAndWriteVectorIndex(
  args,
  deps: any = {}
): Promise<{ path: string; skipped: boolean }> {
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
  const existingNow = await readExistingIndex(outPath);
  if (await indexWriteWouldRegress(payload, existingNow, args.vault)) {
    return { path: outPath, skipped: true };
  }
  await writeFileAtomic(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  return { path: outPath, skipped: false };
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
  const result = await buildAndWriteVectorIndex(args, deps);
  if (result.skipped) {
    console.error(
      "[skip] an index built from a newer vault snapshot is already on disk — this build was discarded (issue #27)"
    );
  }
  console.log(result.path);
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
  return {
    vault: vaultResolved,
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

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  cosineSimilarity,
  embedQueryForVectorIndex,
} from "./vector.ts";
import { importVault } from "./import-vault.ts";
import { readVaultConsistent } from "./vault-lock.ts";
import {
  stateDirForVault,
  cacheDirForVault,
  consumerCacheDirForVault,
  detectVaultIsolation,
} from "./cli-env.ts";

// v3: vault が単一正本。検索系の読み込みは vault からのみ行う。
// 旧 FalkorDB / graph.json の読み込み経路は撤廃した (両方から読めると移行が
// 完了しないため、一本化して完全移行を強制する)。FalkorDB 連携コードは作業C で撤去済み。
//
// vault は複数ファイルの集合なので、writer がファイル群を書き換えている最中に
// 素朴に読むと torn snapshot (一部新・一部旧、未生成ノードを指す edge 等) を
// 観測しうる。writer は vault.seq (seqlock: 偶数=安定 / 奇数=書込中) を打刻するので、
// 読みは readVaultConsistent 経由にして安定スナップショットだけを返す。
// seqOpts はテストが短いタイムアウトで打刻尊重を検証するための注入口
// (本番は既定の 10s に任せる。読みを永久ハングさせない)。
export async function loadGraph(
  vaultDir = process.env.GRAPHRAG_VAULT_DIR,
  seqOpts: { pollMs?: number; timeoutMs?: number } = {}
) {
  if (!vaultDir || typeof vaultDir !== "string") {
    throw new Error(
      "vault directory not specified. Pass it explicitly or set GRAPHRAG_VAULT_DIR. " +
      "(v3: vault is the single source of truth; FalkorDB/graph.json read paths were removed.)"
    );
  }
  // writer が打刻する場所と同じ規約: vault を保持する単一の .graphrag の cache/。
  // (E1: vault.seq / vault.lock は機械ローカルなので .graphrag/cache/ に集約。)
  // 既定レイアウト <root>/.graphrag/vault でも <root>/.graphrag/.graphrag に
  // ずれないよう、冪等な cacheDirForVault に集約する。
  const seqDir = cacheDirForVault(vaultDir);
  return readVaultConsistent(seqDir, () => importVault(vaultDir), seqOpts);
}

export async function loadVectorIndex(vectorPath: string, deltaPath?: string) {
  try {
    const index = JSON.parse(await readFile(vectorPath, "utf8"));
    if (!deltaPath) return index;
    return mergeVectorIndexes(index, await loadVectorIndex(deltaPath));
  } catch {
    return deltaPath ? mergeVectorIndexes(null, await loadVectorIndex(deltaPath)) : null;
  }
}

// ベクトル索引の既定の置き場所: vault を保持する .graphrag の cache/vector.json
// (E1: 再生成可能な機械ローカル成果物は cache/ に集約)。同じ vault を参照する
// 全エージェントが同じ場所を見る。
export function defaultVectorIndexPath(vaultDir: string): string {
  return path.join(cacheDirForVault(vaultDir), "vector.json");
}

// E1 移行前の legacy 置き場所 (.graphrag 直下)。読み取り fallback 専用 —
// 書き込み (再構築) は常に新パス (cache/) へ行く。
export function legacyVectorIndexPath(vaultDir: string): string {
  return path.join(stateDirForVault(vaultDir), "vector.json");
}

// 読み取り時の実効パス: 新レイアウト (cache/vector.json) が在ればそれ、無ければ
// legacy (.graphrag 直下) が在ればそれ、どちらも無ければ新パス (これから作る場所)。
export function vaultVectorIndexReadPath(vaultDir: string): string {
  const next = defaultVectorIndexPath(vaultDir);
  if (existsSync(next)) return next;
  const legacy = legacyVectorIndexPath(vaultDir);
  if (existsSync(legacy)) return legacy;
  return next;
}

// vault 内のファイルが vector index より新しいかを mtime で判定する。
// git pull 直後は取得ファイルの mtime が更新されるため、これだけで「索引が古い」を検知できる。
// 全サブディレクトリを走査するが stat 呼び出しのみなので数 ms で終わる。
async function hasNewerVaultFiles(vaultDir: string, indexMtimeMs: number): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(vaultDir, { recursive: true }) as string[];
  } catch { return false; }
  for (const rel of entries) {
    if (!rel.endsWith(".md")) continue;
    try {
      const s = await stat(path.join(vaultDir, rel));
      if (s.mtimeMs > indexMtimeMs) return true;
    } catch { /* skip unreadable */ }
  }
  return false;
}

// 索引が存在しない or vault より古い場合に true を返す。ファイルシステム操作のみ。
export async function shouldRebuildVectorIndex(vaultDir: string, indexPath: string): Promise<boolean> {
  try {
    const indexStat = await stat(indexPath);
    return hasNewerVaultFiles(vaultDir, indexStat.mtimeMs);
  } catch {
    return true; // 索引ファイルが無い
  }
}

// 検索系は semantic 非交渉。索引が無ければ lexical で代替せず明示エラーで促す。
// 索引パスは明示指定 > vault 隣の既定 の順に解決する。
// vault が指定されていて索引が無い/古い場合は自動構築を試みる (embedding はローカルなので無料)。
export async function loadRequiredVectorIndex(
  vaultDir: string | undefined,
  explicitPath?: string,
  deltaPath?: string
) {
  // writePath = 自動再構築の書き出し先 / readPath = 実際に読む場所 (legacy fallback あり)。
  let writePath = explicitPath ?? (vaultDir ? defaultVectorIndexPath(vaultDir) : undefined);
  if (!writePath) {
    throw new Error(
      "cannot resolve vector index path: pass --vector <path> or --vault <dir> (index is read next to the vault)."
    );
  }
  let readPath = explicitPath ?? vaultVectorIndexReadPath(vaultDir!);

  // E3: GRAPHRAG_VAULT_MODE=readonly では外部 vault の隣に書かない。自動再構築の
  // 書き出し先は消費側 (ローカル .graphrag) の cache/external/<hash>/ へ。読みは
  // 消費側索引 > vault 側の既存索引 (読むだけなら許される) > 消費側 (これから構築)。
  // mode 設定が一切無ければ判定 (git 呼び出し) 自体を skip する。
  //
  // raw_mode (demote 前) を見る: readonly は制限的な設定なので、親 .graphrag/.env
  // からの inherited でも尊重してよい (#3)。demote 済み `mode` を見ると、親で
  // readonly と宣言していても worktree では「未決定」に見えてしまい、外部 vault の
  // cache/ へ自動再構築が書き込んでしまう。書き込みゲート (assertVaultWriteAllowed)
  // は inherited を安全側に倒す必要があるため demote 済み `mode` のまま — ここは
  // 消費側 cache のルーティングだけなので raw_mode で問題ない。
  if (!explicitPath && vaultDir) {
    const modeConfigured =
      (process.env.GRAPHRAG_VAULT_MODE ?? "") !== "" ||
      existsSync(path.join(process.cwd(), ".graphrag", ".env"));
    if (modeConfigured && detectVaultIsolation(process.cwd(), vaultDir).raw_mode === "readonly") {
      const consumerDir = consumerCacheDirForVault(vaultDir);
      if (consumerDir) {
        const consumerPath = path.join(consumerDir, "vector.json");
        writePath = consumerPath;
        readPath = existsSync(consumerPath)
          ? consumerPath
          : existsSync(readPath) ? readPath : consumerPath;
      }
    }
  }

  if (vaultDir && await shouldRebuildVectorIndex(vaultDir, readPath)) {
    try {
      const { buildAndWriteVectorIndex } = await import("./build-vector-index.ts");
      process.stderr.write(`[auto] vector index missing or stale → auto-building: ${writePath}\n`);
      await buildAndWriteVectorIndex({ out: writePath, vault: vaultDir });
      process.stderr.write(`[auto]   → build complete\n`);
      readPath = writePath;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[auto]   → auto-build failed (embedding endpoint unreachable, etc.): ${msg}\n`);
    }
  }

  const index = await loadVectorIndex(readPath, deltaPath);
  if (!index) {
    throw new Error(
      `vector index not found: ${readPath}. Build it first: build-vector-index --vault <dir>. ` +
      "(semantic retrieval is required; lexical-only fallback is not designed.)"
    );
  }
  return index;
}

export function mergeVectorIndexes(baseIndex, deltaIndex) {
  if (!baseIndex) return deltaIndex ?? null;
  if (!deltaIndex) return baseIndex;
  if (baseIndex.provider !== deltaIndex.provider) {
    throw new Error(`Vector index provider mismatch: ${baseIndex.provider} != ${deltaIndex.provider}`);
  }
  if (baseIndex.dimensions !== deltaIndex.dimensions) {
    throw new Error(`Vector index dimensions mismatch: ${baseIndex.dimensions} != ${deltaIndex.dimensions}`);
  }

  const rowsById = new Map((baseIndex.rows ?? []).map((row) => [row.node_id, row]));
  for (const row of deltaIndex.rows ?? []) rowsById.set(row.node_id, row);
  return {
    ...baseIndex,
    generated_at: deltaIndex.generated_at ?? baseIndex.generated_at,
    rows: [...rowsById.values()]
  };
}

export async function prepareVectorSearch(query, options: any = {}) {
  if (options.useVector === false) {
    return { vectorIndex: options.vectorIndex ?? null, queryVector: null };
  }
  const vectorIndex = options.vectorIndex ?? null;
  if (vectorIndex) {
    return { vectorIndex, queryVector: await embedQueryForVectorIndex(query, vectorIndex) };
  }
  return { vectorIndex: null, queryVector: null };
}

// Code-biased default: implementation artifacts rank above docs/tests/config
// that merely mention the same domain. General to any codebase; configurable.
export const DEFAULT_ROLE_WEIGHTS: Record<string, number> = {
  source: 1,
  api_route: 0.85,
  entrypoint: 0.9,
  ui_component: 0.85,
  config: 0.62,
  test: 0.55,
  documentation: 0.6
};

// 終端 state のノードは順位を下げるが除外しない (hard reject しない原則 —
// 「過去にこう判断して覆した」という系譜自体が答えになるクエリがあるため)。
// 注記は後継/現況へ読み手を誘導する。
// 蒸留済み知識ノードの補助ブースト (×1.05)。lexical/semantic の主軸を崩さず、
// ほぼ同点の時だけ出所系 (ConversationChunk / Investigation 等) より上に出す。
const TYPE_BOOST = 1.05;
const TYPE_BOOST_TYPES = new Set(["Decision", "Constraint", "OperationalKnowledge"]);

const TERMINAL_STATE_PENALTY = 0.6;
export const TERMINAL_STATE_NOTES: Record<string, string> = {
  superseded: "superseded — check refines reverse for successor",
  closed: "closed — settled Investigation. To reopen, set state back to active",
  abandoned: "abandoned — abandoned Goal. To re-adopt, wire a new Goal to it via refines",
  achieved: "achieved — achieved Goal. Trace refines from here to reach the live policy"
};

export function searchGraph(graph, query, options: any = {}) {
  const normalizedQuery = normalizeText(query);
  // coverage は内容語だけで測る (≤2 文字のひらがな単独トークン = 機能語を除外)。
  // 機能語 ("なぜ" 等) が内容語と同じ重みでカバー率を膨らませ、stopword だけ
  // 一致するノードが両チャネル最良のノードを追い抜く誤順位を実測したため。
  const queryTerms = splitTerms(normalizedQuery).filter(isContentTerm);
  // JA+EN 併記クエリ (SKILL.md §Query discipline が推奨) を単言語ノードが取り
  // こぼさないよう、スクリプト別 (latin / それ以外) の部分クエリも用意し、
  // coverage / ngram はスクリプト別の max も候補にする。ただし部分クエリが
  // 全体の 1/3 未満の文字数しか無い時は「クエリの言い換え」とみなさない
  // (短い英単語 1 個が coverage 1.0 を僭称するのを防ぐ)。
  const scriptTermSets = scriptPartitions(queryTerms);
  const queryTokens = splitTerms(normalizedQuery);
  const queryGramSets = [makeNgrams(normalizedQuery), ...scriptPartitions(queryTokens).map((tokens) => makeNgrams(tokens.join(" ")))]
    .filter((grams) => grams.size > 0);
  const vectorRowsById: Map<string, any> = new Map((options.vectorIndex?.rows ?? []).map((row) => [row.node_id, row]));
  // R6 multi-query: queryVectors (複数) を受け、semantic = 各 vector との cosine の max。
  // 後方互換: 従来の単一 queryVector も受ける (queryVector が在れば配列へ畳む)。
  const queryVectors = collectQueryVectors(options);
  const types = new Set(options.types ?? []);
  const limit = options.limit ?? 10;

  const scored = [];
  for (const node of graph.nodes ?? []) {
    if (types.size > 0 && !types.has(node.type)) continue;

    const fields = buildSearchFields(node);
    const normalizedFields = fields.map((field) => normalizeText(field));
    const haystack = normalizedFields.join("\n");
    const aliases = (node.aliases ?? []).map((alias) => normalizeText(alias));

    const reasons = [];

    // --- 文字一致系を 0〜1 に統合 (lexical) ---
    // 完全一致 (別名一致=1) / 単語カバー率 / ngram 比率 の最大値。
    // ngram 比率は confidence 判定 (judgeMatchConfidence) の reason も兼ねるため
    // 別名一致の有無に関わらず常に算出する。全体クエリとスクリプト別部分クエリの max。
    const fieldNgrams = makeNgrams(haystack);
    let ngramRatio = 0;
    for (const grams of queryGramSets) {
      let hits = 0;
      for (const ngram of grams) {
        if (fieldNgrams.has(ngram)) hits += 1;
      }
      ngramRatio = Math.max(ngramRatio, hits / grams.size);
    }
    if (ngramRatio > 0) reasons.push(`ngram:${ngramRatio.toFixed(2)}`);

    const hitTerms = queryTerms.filter((term) => term && haystack.includes(term));
    for (const term of hitTerms) reasons.push(`term:${term}`);
    // 文字数重み付きカバー率 (hit 文字数 / クエリ文字数)。件数比だと 1 文字の
    // 機能語ヒットが長い内容語ミスと同価値になるため。スクリプト別 max 込み。
    const hitSet = new Set(hitTerms);
    let termCoverage = coverageRatio(queryTerms, hitSet);
    for (const scriptTerms of scriptTermSets) {
      termCoverage = Math.max(termCoverage, coverageRatio(scriptTerms, hitSet));
    }
    if (termCoverage > 0) reasons.push(`coverage:${termCoverage.toFixed(2)}`);

    const aliasExact = aliases.includes(normalizedQuery);
    if (aliasExact) reasons.push("alias-exact");

    const lexical = Math.max(aliasExact ? 1 : 0, termCoverage, ngramRatio);

    // --- 意味の近さ (semantic, 0〜1) ---
    // R6: 複数の query vector がある時は各 vector との cosine の max を採る
    // (質問と gist など、別々に埋め込んだ問いのどれかに近ければ拾う)。
    let semantic = 0;
    const vectorRow = vectorRowsById.get(node.id);
    const nodeVector = vectorRow?.vector ?? null;
    if (queryVectors.length > 0 && nodeVector) {
      let vectorScore = -Infinity;
      for (const qv of queryVectors) {
        const s = cosineSimilarity(qv, nodeVector);
        if (s > vectorScore) vectorScore = s;
      }
      if (vectorScore > 0.05) {
        // cosineSimilarity は正規化ベクトルの内積前提 (vector.ts の normalizeVector)。
        // 索引生成経路が変わり単位長でなくなっても対等化が崩れないよう上限を 1 に
        // クランプする (lexical も最大 1 なので主軸の対等性を保つ)。reason は
        // 判定用に生値を出す。
        semantic = Math.min(1, vectorScore);
        reasons.push(`vector:${vectorScore.toFixed(2)}`);
      }
    }

    // --- 対等合算: lexical と semantic を同じ重み (各最大 100) で ---
    // 完全一致を最上位に固定せず、意味だけ近いノードと対等に競らせる
    // (spec §1.1#2 semantic 非交渉 / §0 キーワード取りこぼし回避)。
    const PARITY_WEIGHT = 100;
    let score = PARITY_WEIGHT * lexical + PARITY_WEIGHT * semantic;

    // --- 補助調整 (順位の主軸 lexical↔semantic は崩さない小さな下駄/重み) ---
    // 蒸留済み知識 (Decision/Constraint/OperationalKnowledge) をほぼ同点の時だけ
    // 出所系ノード (ConversationChunk 等) より優先する。旧実装の +2 加点は
    // ~200 点スケールで順位を一度も動かせない死荷重だったため、小さな乗算に変更。
    if (score > 0 && TYPE_BOOST_TYPES.has(node.type)) {
      score *= TYPE_BOOST;
      reasons.push(`type:${node.type}×${TYPE_BOOST}`);
    }

    // Role-aware weighting (general GraphRAG signal, not query-specific).
    // A File that implements something should outrank a doc/test/config that
    // merely mentions the same domain. Configurable: options.roleWeights as an
    // object overrides; === false disables. Only File nodes with a known role
    // are affected; knowledge nodes (Decision etc.) are untouched.
    if (score > 0 && node.type === "File" && options.roleWeights !== false) {
      const weights = (options.roleWeights && typeof options.roleWeights === "object")
        ? options.roleWeights
        : DEFAULT_ROLE_WEIGHTS;
      const w = weights[node.role];
      if (typeof w === "number") {
        score = Number((score * w).toFixed(3));
        reasons.push(`role:${node.role}×${w}`);
      }
    }

    // --- state 減点: 終端 state は 0.6 倍 (除外せず順位だけ落とす) ---
    const stateNote = typeof node.state === "string" ? TERMINAL_STATE_NOTES[node.state] : undefined;
    if (score > 0 && stateNote) {
      score *= TERMINAL_STATE_PENALTY;
      reasons.push(`state:${node.state}×${TERMINAL_STATE_PENALTY}`);
    }

    if (score > 0) {
      scored.push({
        node,
        score: Number(score.toFixed(3)),
        reasons: [...new Set(reasons)],
        ...(stateNote ? { state_note: stateNote } : {})
      });
    }
  }

  scored.sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id));

  // --- R5 graph rerank ---
  // 初期スコア後、上位 K=24 候補について、他の上位候補と graph エッジ (向き不問・
  // 全エッジ型) で隣接する数 votes を数え、score *= (1 + 0.06 * min(votes, 5))。
  // 既定 OFF (opt-in は options.graphRerank === true)。2026-06-12 の dev-vault 実測で、
  // votes が「関連の島」でなく「ノード次数 (hub 度)」を測ってしまい、Investigation /
  // ConversationChunk ハブが蒸留済み leaf (Decision/Constraint) を押し下げる net-negative
  // を確認 (top3 0.875→0.75)。島構造が均衡した graph では有効 (synthetic で全指標+) なので
  // 機能は残す。改善候補: votes の次数正規化 / 出所系ノードの投票除外 (要再 eval)。
  if (options.graphRerank === true) {
    applyGraphRerank(graph, scored);
    scored.sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id));
  }

  return scored.slice(0, limit);
}

const GRAPH_RERANK_K = 24;

// 上位 K 候補の中で、graph エッジ (向き不問・全型) により他候補と隣接する数を
// votes として数え、score を最大 +30% (vote 5 で頭打ち) 持ち上げる。reason に
// "graph:+N" を残す。scored は破壊的に更新する (呼び出し側で再 sort)。
function applyGraphRerank(graph, scored): void {
  const topK = scored.slice(0, GRAPH_RERANK_K);
  if (topK.length <= 1) return;
  const idToIndex = new Map<string, number>();
  topK.forEach((entry, i) => idToIndex.set(entry.node.id, i));
  const votes = new Array(topK.length).fill(0);
  for (const edge of graph.edges ?? []) {
    const fromIdx = idToIndex.get(edge.from);
    const toIdx = idToIndex.get(edge.to);
    // 両端が上位候補 (かつ自己ループでない) の時だけ、双方に 1 票ずつ。
    if (fromIdx === undefined || toIdx === undefined || fromIdx === toIdx) continue;
    votes[fromIdx] += 1;
    votes[toIdx] += 1;
  }
  for (let i = 0; i < topK.length; i += 1) {
    const v = votes[i];
    if (v <= 0) continue;
    const capped = Math.min(v, 5);
    const entry = topK[i];
    entry.score = Number((entry.score * (1 + 0.06 * capped)).toFixed(3));
    entry.reasons = [...entry.reasons, `graph:+${capped}`];
  }
}

// R6: options.queryVectors (number[][]) 優先。無ければ従来の単一 options.queryVector を
// 配列へ畳む。useVector === false なら semantic 無効 (空配列)。
function collectQueryVectors(options): number[][] {
  if (options.useVector === false) return [];
  const multi = options.queryVectors;
  if (Array.isArray(multi)) {
    return multi.filter((v) => Array.isArray(v) && v.length > 0);
  }
  const single = options.queryVector;
  return Array.isArray(single) && single.length > 0 ? [single] : [];
}

// 近傍展開の edge 型優先度: 知識構造の背骨 (置き換え/具体化/前提/方針/制約) を先に、
// 出所系 (discussed_in/documented_by) を最後に採る。cap で切る時に「supersedes の
// 後継が落ちて discussed_in が残る」を防ぐ。未登録型は中間 (50)。日本語ラベルは
// edge-labels.ts (EDGE_LABELS_JA) 参照。brief.ts の relations cap も同じ優先度を使う。
export const EDGE_TYPE_PRIORITY: Record<string, number> = {
  supersedes: 0,
  refines: 1,
  has_premise: 2,
  sets_policy_for: 3,
  constrains: 4,
  discussed_in: 90,
  documented_by: 91
};

export function edgePriority(edgeType: string): number {
  return EDGE_TYPE_PRIORITY[edgeType] ?? 50;
}

function edgeKey(edge): string {
  return typeof edge.id === "string" && edge.id.length > 0
    ? edge.id
    : `${edge.from}|${edge.type}|${edge.to}`;
}

// 近傍展開。深さ≥2 で同じ edge を重複して出さない (seenEdges)。ハブ (次数の高い
// File 等) が graph_context を洪水させないよう、ノードあたり perNodeCap 本を
// edge 型優先度順に選び、全体 globalCap 本で打ち切る。
export function expandNeighbors(graph, nodeIds, depth = 1, options: any = {}) {
  const perNodeCap = options.perNodeCap ?? 10;
  const globalCap = options.globalCap ?? 40;
  const nodesById = new Map((graph.nodes ?? []).map((node) => [node.id, node]));
  const incident = new Map<string, any[]>();
  for (const edge of graph.edges ?? []) {
    for (const endpoint of edge.from === edge.to ? [edge.from] : [edge.from, edge.to]) {
      const list = incident.get(endpoint);
      if (list) list.push(edge);
      else incident.set(endpoint, [edge]);
    }
  }

  let frontier = new Set(nodeIds);
  const seen = new Set(nodeIds);
  const seenEdges = new Set<string>();
  const expansions = [];

  for (let currentDepth = 0; currentDepth < depth; currentDepth += 1) {
    const next = new Set();
    for (const id of frontier) {
      const candidates = (incident.get(id) ?? [])
        .filter((edge) => !seenEdges.has(edgeKey(edge)))
        .sort((a, b) => edgePriority(a.type) - edgePriority(b.type) || edgeKey(a).localeCompare(edgeKey(b)));
      let taken = 0;
      for (const edge of candidates) {
        if (taken >= perNodeCap || expansions.length >= globalCap) break;
        seenEdges.add(edgeKey(edge));
        taken += 1;

        const otherId = edge.from === id ? edge.to : edge.from;
        if (!seen.has(otherId)) next.add(otherId);
        seen.add(otherId);

        expansions.push({
          depth: currentDepth + 1,
          edge,
          from: nodesById.get(edge.from),
          to: nodesById.get(edge.to)
        });
      }
      if (expansions.length >= globalCap) break;
    }
    if (expansions.length >= globalCap) break;
    frontier = next;
  }

  return expansions;
}

// LLM 向け出力のノード全文表現。null/欠損フィールドは出力しない (以前は
// provenance: null / display: null 等を全ノードに撒いていた — 純粋な無駄)。
export function nodeForOutput(node) {
  const fields = [
    "title", "summary", "path", "state",
    "provenance", "short_label", "display", "aliases"
  ];
  const out: any = { id: node.id, type: node.type };
  for (const field of fields) {
    if (node[field] != null) out[field] = node[field];
  }
  return out;
}

function buildSearchFields(node) {
  // node.id (識別子) と node.type (分類) は意味ではない。文字一致の対象に含めると
  // canonical 化 / 改名 (vein:→concern:, Vein→Concern) で検索が移行に反応する
  // ため、除外する。type での絞り込みは searchGraph の types フィルタで行う。
  return [
    node.title,
    node.summary,
    node.path,
    ...(node.aliases ?? []),
    ...(node.tags ?? []),
    ...displayTextFields(node.display)
  ].filter((value) => typeof value === "string" && value.length > 0);
}

function displayTextFields(display) {
  const fields = [];
  visitDisplayValue(display, fields);
  return fields;
}

function visitDisplayValue(value, fields) {
  if (typeof value === "string" && value.length > 0) {
    fields.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitDisplayValue(item, fields);
    return;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) visitDisplayValue(child, fields);
  }
}

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTerms(value) {
  return value.split(" ").filter((term) => term.length > 0);
}

// coverage の対象にする内容語か。≤2 文字のひらがな単独トークン ("なぜ" "した" 等の
// 機能語) を落とす。漢字/カタカナ/latin の短語は内容語でありうるので残す。
function isContentTerm(term: string): boolean {
  return !(term.length <= 2 && /^[ぁ-ゖ]+$/.test(term));
}

// ASCII のみのトークンか (normalizeText 済み前提: 記号は除去済み)。
function isLatinToken(term: string): boolean {
  return /^[\x21-\x7e]+$/.test(term);
}

// coverage 用の重み付き文字数。CJK 等の非 ASCII 文字は 1 字あたりの情報量が
// latin の音節相当 (~2 字) なので 2 と数える。素の文字数だと "重複チェック" (6字)
// と "duplicate check" (14字) の併記でスクリプト間の比重が歪む。
function charCount(terms: string[]): number {
  let total = 0;
  for (const term of terms) {
    for (const char of term) total += char.charCodeAt(0) <= 0x7e ? 1 : 2;
  }
  return total;
}

// スクリプト別 (latin / それ以外) の部分クエリ。全体の 1/3 未満の文字数しか無い
// 部分は「クエリの言い換え」とみなさず返さない (JA クエリ中の英単語 1 個が
// 単独でカバー率 1.0 を僭称するのを防ぐ)。片方が空 = 単一スクリプトなら空を返す
// (全体と同じ集合を重複計算しない)。
function scriptPartitions(terms: string[]): string[][] {
  const latin = terms.filter(isLatinToken);
  const other = terms.filter((term) => !isLatinToken(term));
  if (latin.length === 0 || other.length === 0) return [];
  const total = charCount(terms);
  return [latin, other].filter((subset) => charCount(subset) * 3 >= total);
}

// 文字数重み付きカバー率: hit した term の文字数 / 対象 term 群の総文字数。
function coverageRatio(terms: string[], hitSet: Set<string>): number {
  const total = charCount(terms);
  if (total === 0) return 0;
  return charCount(terms.filter((term) => hitSet.has(term))) / total;
}

// トークン単位の ngram (単語/フィールド境界を跨ぐ gram を作らない — 連結後の
// 跨ぎ gram は無関係な語同士の偶然一致を量産していた)。latin トークンは 3-gram
// のみ (2-gram は英字 26^2 の衝突率が高く "chocolate cake" が日本語 vault に
// ngram 0.58 を出す実測誤爆の原因)。3 文字未満の latin トークンは語そのものを
// gram にする。CJK トークンは情報密度が高いので従来どおり 2+3-gram。
function makeNgrams(value) {
  const grams = new Set();
  for (const token of value.split(/\s+/)) {
    if (token.length === 0) continue;
    if (isLatinToken(token)) {
      if (token.length < 3) {
        grams.add(token);
        continue;
      }
      for (let index = 0; index <= token.length - 3; index += 1) {
        grams.add(token.slice(index, index + 3));
      }
      continue;
    }
    for (const size of [2, 3]) {
      for (let index = 0; index <= token.length - size; index += 1) {
        grams.add(token.slice(index, index + size));
      }
    }
  }
  return grams;
}

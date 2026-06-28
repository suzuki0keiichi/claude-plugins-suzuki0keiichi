import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  cosineSimilarity,
  embedQueryForVectorIndex,
} from "./vector.ts";
import { importVault } from "./import-vault.ts";
import { readVaultConsistent } from "./vault-lock.ts";
import { stateDirForVault } from "./cli-env.ts";

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
  // writer が打刻する場所と同じ規約: vault を保持する単一の .graphrag。
  // 既定レイアウト <root>/.graphrag/vault でも <root>/.graphrag/.graphrag に
  // ずれないよう、冪等な stateDirForVault に集約する。
  const stateDir = stateDirForVault(vaultDir);
  return readVaultConsistent(stateDir, () => importVault(vaultDir), seqOpts);
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

// ベクトル索引の既定の置き場所: vault のすぐ隣 (vault 親フォルダ) の
// .graphrag/vector.json。同じ vault を参照する全エージェントが同じ場所を見る。
export function defaultVectorIndexPath(vaultDir: string): string {
  return path.join(stateDirForVault(vaultDir), "vector.json");
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
  const resolved = explicitPath ?? (vaultDir ? defaultVectorIndexPath(vaultDir) : undefined);
  if (!resolved) {
    throw new Error(
      "cannot resolve vector index path: pass --vector <path> or --vault <dir> (index is read next to the vault)."
    );
  }

  if (vaultDir && await shouldRebuildVectorIndex(vaultDir, resolved)) {
    try {
      const { buildAndWriteVectorIndex } = await import("./build-vector-index.ts");
      process.stderr.write(`[auto] vector index が無いか古い → 自動構築: ${resolved}\n`);
      await buildAndWriteVectorIndex({ out: resolved, vault: vaultDir });
      process.stderr.write(`[auto]   → 構築完了\n`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[auto]   → 自動構築失敗 (embedding endpoint 不達等): ${msg}\n`);
    }
  }

  const index = await loadVectorIndex(resolved, deltaPath);
  if (!index) {
    throw new Error(
      `vector index not found: ${resolved}. Build it first: build-vector-index --vault <dir>. ` +
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
const TERMINAL_STATE_PENALTY = 0.6;
export const TERMINAL_STATE_NOTES: Record<string, string> = {
  superseded: "superseded — refines 逆引きで後継を確認",
  closed: "closed — 終結済み Investigation。再開するなら state を active に戻す",
  abandoned: "abandoned — 放棄済み Goal。再採用なら新 Goal を refines で繋ぐ",
  achieved: "achieved — 達成済み Goal。現役の方針はここから refines を辿る"
};

export function searchGraph(graph, query, options: any = {}) {
  const normalizedQuery = normalizeText(query);
  const queryTerms = splitTerms(normalizedQuery);
  const queryNgrams = makeNgrams(normalizedQuery);
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
    // 別名一致の有無に関わらず常に算出する。
    const fieldNgrams = makeNgrams(haystack);
    let ngramHits = 0;
    for (const ngram of queryNgrams) {
      if (fieldNgrams.has(ngram)) ngramHits += 1;
    }
    const ngramRatio = queryNgrams.size > 0 ? ngramHits / queryNgrams.size : 0;
    if (ngramRatio > 0) reasons.push(`ngram:${ngramRatio.toFixed(2)}`);

    const hitTerms = queryTerms.filter((term) => term && haystack.includes(term));
    for (const term of hitTerms) reasons.push(`term:${term}`);
    const termCoverage = queryTerms.length > 0 ? hitTerms.length / queryTerms.length : 0;

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
    if (node.type === "Decision" || node.type === "OperationalKnowledge") {
      score += 2;
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

export function expandNeighbors(graph, nodeIds, depth = 1) {
  const nodesById = new Map((graph.nodes ?? []).map((node) => [node.id, node]));
  const frontier = new Set(nodeIds);
  const seen = new Set(nodeIds);
  const expansions = [];

  for (let currentDepth = 0; currentDepth < depth; currentDepth += 1) {
    const next = new Set();
    for (const edge of graph.edges ?? []) {
      const touchesFrom = frontier.has(edge.from);
      const touchesTo = frontier.has(edge.to);
      if (!touchesFrom && !touchesTo) continue;

      const otherId = touchesFrom ? edge.to : edge.from;
      if (!seen.has(otherId)) next.add(otherId);
      seen.add(otherId);

      expansions.push({
        depth: currentDepth + 1,
        edge,
        from: nodesById.get(edge.from),
        to: nodesById.get(edge.to)
      });
    }
    frontier.clear();
    for (const id of next) frontier.add(id);
  }

  return expansions;
}

export function nodeForOutput(node) {
  return {
    id: node.id,
    type: node.type,
    title: node.title ?? null,
    summary: node.summary ?? null,
    path: node.path ?? null,
    state: node.state ?? null,
    provenance: node.provenance ?? null,
    short_label: node.short_label ?? null,
    display: node.display ?? null,
    aliases: node.aliases ?? null
  };
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

function makeNgrams(value) {
  const compact = value.replace(/\s+/g, "");
  const grams = new Set();
  for (const size of [2, 3]) {
    for (let index = 0; index <= compact.length - size; index += 1) {
      grams.add(compact.slice(index, index + size));
    }
  }
  return grams;
}

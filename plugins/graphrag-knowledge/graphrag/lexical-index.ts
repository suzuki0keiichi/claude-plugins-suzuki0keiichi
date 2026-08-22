import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { computeNodeLexical } from "./retrieval.ts";
import { writeFileAtomic } from "./build-vector-index.ts";
import {
  cacheDirForVault,
  consumerCacheDirForVault,
  detectVaultIsolation
} from "./cli-env.ts";

// issue #33: searchGraph の永続転置 index (lexical posting list)。
//
// searchGraph は 1 プロセスに 1 回しか呼ばれないため、インメモリキャッシュは
// 無意味で永続化だけが効く。ここでは per-node の正規化 haystack / 正規化 alias と、
// gram → node index の posting list を .graphrag/cache/lexical.json に永続化する。
// スコアは従来計算と完全同値: ngram ヒット数を posting list で先に集計するだけで、
// term カバー率 (haystack.includes) と alias 完全一致は保存済みの同じ文字列に
// 従来ロジックをそのまま適用する。
//
// 鮮度判定は vector index (issue #34) と同型の「graph 内容との指紋突合」。ただし
// vectorTextHash 由来の computeGraphFingerprint は流用しない — embedding 対象と
// 検索フィールド (title/summary/path/aliases/tags/display) は範囲が違うため、
// 検索フィールドの生値から専用の指紋を取る (正規化は決定的なので生値一致 ⇒
// 派生物一致)。type/state/role は検索フィールドではなく searchGraph が graph から
// live に読むので指紋に含めない。
//
// 破損・不在・指紋不一致は全て「従来どおりインメモリで計算」に fallback し、その
// 結果を writeFileAtomic で書き出して次回に備える (自己修復)。書き込み失敗は検索を
// 失敗させない。vector index と違い再生成は安価 (embedding なし) なので、書き込みの
// 退行ゲート (indexWriteWouldRegress 相当) は張らない — 古い内容を踏み潰しても
// 次の読みの指紋不一致が即座に再生成する。
export const LEXICAL_INDEX_VERSION = 1;

export type LexicalNodeEntry = { idx: number; haystack: string; aliases: string[] };
export type LexicalIndex = {
  size: number;
  byId: Map<string, LexicalNodeEntry>;
  postings: Map<string, number[]>;
};

// 置き場所は vector.json と同じ機械ローカル cache (E1)。
export function defaultLexicalIndexPath(vaultDir: string): string {
  return path.join(cacheDirForVault(vaultDir), "lexical.json");
}

// 検索フィールドの生値による per-node ハッシュ。buildSearchFields / computeNodeLexical
// が読む生フィールドを全て含める (title/summary/path は文字列のみ採用 — 非文字列は
// フィールド不在と同じ扱いなので "" に落とす。aliases/tags/display は構造ごと JSON)。
function lexicalNodeHash(node: any): string {
  const hash = createHash("sha256");
  for (const value of [node.title, node.summary, node.path]) {
    hash.update(typeof value === "string" ? value : "");
    hash.update("\u001f"); // フィールド境界の単位分離子
  }
  hash.update(JSON.stringify([node.aliases ?? null, node.tags ?? null, node.display ?? null]));
  return hash.digest("hex");
}

// graph 全体の検索フィールド指紋。node の追加/削除/検索フィールド変更のどれでも変わる。
// id 順ソートで graph.nodes の並びに依存しない (computeGraphFingerprint と同型)。
export function computeLexicalFingerprint(graph: any): string {
  const parts = (graph?.nodes ?? [])
    .map((node: any) => `${node.id} ${lexicalNodeHash(node)}`)
    .sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

// graph から転置 index を構築する (従来経路と同じ computeNodeLexical が単一の正)。
// node id が重複する graph は byId が多義になり同値性を保証できないので null
// (呼び出し側は従来経路のまま検索する)。
export function buildLexicalIndex(graph: any): LexicalIndex | null {
  const byId = new Map<string, LexicalNodeEntry>();
  const postings = new Map<string, number[]>();
  const nodes = graph?.nodes ?? [];
  for (let idx = 0; idx < nodes.length; idx += 1) {
    const node = nodes[idx];
    if (typeof node?.id !== "string" || byId.has(node.id)) return null;
    const { haystack, aliases, grams } = computeNodeLexical(node);
    byId.set(node.id, { idx, haystack, aliases });
    for (const gram of grams) {
      const posting = postings.get(gram);
      if (posting) posting.push(idx);
      else postings.set(gram, [idx]);
    }
  }
  return { size: nodes.length, byId, postings };
}

export function lexicalIndexToPayload(index: LexicalIndex, graphFingerprint: string) {
  const ids: string[] = new Array(index.size);
  const nodes: Array<{ h: string; a: string[] }> = new Array(index.size);
  for (const [id, entry] of index.byId) {
    ids[entry.idx] = id;
    nodes[entry.idx] = { h: entry.haystack, a: entry.aliases };
  }
  return {
    version: LEXICAL_INDEX_VERSION,
    generated_at: new Date().toISOString(),
    graph_fingerprint: graphFingerprint,
    ids,
    nodes,
    postings: Object.fromEntries(index.postings)
  };
}

// payload → runtime。構造が壊れていれば throw (呼び出し元が catch して再構築)。
export function lexicalIndexFromPayload(payload: any): LexicalIndex {
  if (payload?.version !== LEXICAL_INDEX_VERSION) {
    throw new Error(`lexical index version mismatch: ${payload?.version}`);
  }
  const ids = payload.ids;
  const nodes = payload.nodes;
  const rawPostings = payload.postings;
  if (!Array.isArray(ids) || !Array.isArray(nodes) || ids.length !== nodes.length) {
    throw new Error("lexical index malformed: ids/nodes");
  }
  if (rawPostings == null || typeof rawPostings !== "object" || Array.isArray(rawPostings)) {
    throw new Error("lexical index malformed: postings");
  }
  const byId = new Map<string, LexicalNodeEntry>();
  for (let idx = 0; idx < ids.length; idx += 1) {
    const id = ids[idx];
    const entry = nodes[idx];
    if (
      typeof id !== "string" || !entry || typeof entry !== "object" ||
      typeof entry.h !== "string" || !Array.isArray(entry.a) ||
      entry.a.some((alias: any) => typeof alias !== "string")
    ) {
      throw new Error(`lexical index malformed: node entry at ${idx}`);
    }
    byId.set(id, { idx, haystack: entry.h, aliases: entry.a });
  }
  if (byId.size !== ids.length) throw new Error("lexical index malformed: duplicate ids");
  const postings = new Map<string, number[]>();
  for (const [gram, list] of Object.entries(rawPostings)) {
    if (!Array.isArray(list) || list.some((idx: any) => !Number.isInteger(idx) || idx < 0 || idx >= ids.length)) {
      throw new Error(`lexical index malformed: posting for ${gram}`);
    }
    postings.set(gram, list as number[]);
  }
  return { size: ids.length, byId, postings };
}

// E3 readonly: 外部 vault の隣に書かない。loadRequiredVectorIndex と同じ判定・
// 同じ消費側 cache ルーティング (raw_mode を見る理由もあちらのコメント参照)。
function resolveLexicalIndexPaths(vaultDir: string): { readPath: string; writePath: string } {
  const base = defaultLexicalIndexPath(vaultDir);
  let readPath = base;
  let writePath = base;
  const modeConfigured =
    (process.env.GRAPHRAG_VAULT_MODE ?? "") !== "" ||
    existsSync(path.join(process.cwd(), ".graphrag", ".env"));
  if (modeConfigured && detectVaultIsolation(process.cwd(), vaultDir).raw_mode === "readonly") {
    const consumerDir = consumerCacheDirForVault(vaultDir);
    if (consumerDir) {
      const consumerPath = path.join(consumerDir, "lexical.json");
      writePath = consumerPath;
      readPath = existsSync(consumerPath) ? consumerPath : base;
    }
  }
  return { readPath, writePath };
}

// 転置 index のロード口。指紋一致なら永続 index、それ以外 (不在/破損/不一致) は
// インメモリ再計算 + best-effort 永続化。null は「index なしで従来経路のまま検索せよ」
// (vault 不明 / 重複 id graph)。検索を失敗させる例外はここからは出さない。
export async function loadLexicalIndex(vaultDir: string | undefined, graph: any): Promise<LexicalIndex | null> {
  if (!vaultDir || typeof vaultDir !== "string") return null;
  let paths: { readPath: string; writePath: string };
  try {
    paths = resolveLexicalIndexPaths(vaultDir);
  } catch {
    return buildLexicalIndex(graph); // path 解決に失敗しても検索は続行 (永続化なし)
  }
  const fingerprint = computeLexicalFingerprint(graph);
  try {
    const payload = JSON.parse(await readFile(paths.readPath, "utf8"));
    if (payload?.graph_fingerprint === fingerprint) {
      return lexicalIndexFromPayload(payload);
    }
  } catch {
    // 不在 (ENOENT) / JSON 破損 / 構造破損 → 下の再計算へ。lexical index は
    // 安価な二次生成物なので vector index (issue #30) と違い無音再生成でよい。
  }
  const index = buildLexicalIndex(graph);
  if (index) {
    try {
      await writeFileAtomic(paths.writePath, `${JSON.stringify(lexicalIndexToPayload(index, fingerprint))}\n`);
    } catch {
      // 書けなくても検索は失敗させない (次回また再計算するだけ)。
    }
  }
  return index;
}

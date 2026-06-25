import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { searchGraph } from "./retrieval.ts";
import { createVectorProvider, resolveVectorProvider } from "./vector.ts";
import { writeFileAtomic } from "./build-vector-index.ts";
import { judgeMatchConfidence, type MatchConfidence } from "./confidence.ts";

// cross-vault retrieval の三層 (investigation:graphrag-skill-dev:cross-vault-retrieval-design):
//   1. vault 自己紹介 (正本): vault の隣の VAULT.md。名前・種別・何の知識があるか。
//      vault と同じ git repo で管理されるので正本が一つで腐りにくい。
//      ※ vault フォルダの中には置けない (importVault が全 .md をノード化し、
//        writeVaultDelta が生成集合に無い .md を孤児として削除するため)。
//        「vault の隣」は vector.json (.graphrag sibling) と同じ配置規約。
//   2. world (住所録): world.json。vault へのポインタの列 *だけ*。説明を持たないので
//      腐らない。参照は world→vault の一方向、同じ vault が複数 world に載れる。
//   3. world-cache (写し): world.json の隣の world-cache.json。各 vault の自己紹介の
//      写し + embedding + 内容ハッシュ + 取得時刻。機械生成・手編集禁止。
//      ask 毎の全 vault フルスキャンを回避する。
//
// ask はヒントまで: 手元 vault で答えつつ問いと写しを突き合わせ「vault X にも知識が
// ありそう」と返す。実際に掛ける (ask --vault <path>) かどうかは呼び手の判断。

export const WORLD_FILE = "world.json";
export const WORLD_CACHE_FILE = "world-cache.json";
export const VAULT_PROFILE_FILE = "VAULT.md";

export interface WorldVaultRef {
  path: string; // ローカル vault dir (絶対/相対) または git リモート URL (将来)
  slug?: string; // vault_slug (VAULT.md の正本と一致すべき)
}

export interface WorldConfig {
  vaults: WorldVaultRef[];
}

export interface VaultProfile {
  name: string;
  kind: string | null; // system / project / product / business を推奨 (旧 ANY_ROOT_NODE 4型の転生)
  description: string;
  // 構造的な「親 vault」の vault_slug。ノード間リンクではなく vault 同士の包含関係を表す。
  // 単一の親のみ (スカラ)。ノードに表れない containment を vault 自身が知るための欄。null = 親なし (root)。
  parent: string | null;
}

export type WorldCacheEntryStatus = "ok" | "no-profile" | "remote-unsupported";

export interface WorldCacheEntry {
  vault_path: string; // ローカルは resolve 済み絶対パス、リモートは URL そのまま
  status: WorldCacheEntryStatus;
  profile: VaultProfile | null;
  content_hash: string | null;
  fetched_at: string | null;
  vector: number[] | null;
  profile_mtime: string | null; // VAULT.md の mtime (ISO)。自己紹介の鮮度判定の材料
  node_count: number | null; // vault 内ノード数 (.md 1 ファイル = 1 ノード)。蓄積量の材料
}

export interface WorldCache {
  version: 1;
  provider: string | null;
  dimensions: number | null;
  provider_options: { endpoint?: string; model?: string } | null;
  generated_at: string;
  entries: WorldCacheEntry[];
}

export interface WorldHint {
  vault: { name: string; kind: string | null; path: string; description: string };
  score: number;
  gap_above_next: number | null; // top1 のみ: 2 位との合算スコア差 (相対判定の根拠)
  reasons: string[];
  confidence: MatchConfidence;
  freshness: { state: "fresh" | "refreshed" | "stale"; fetched_at: string | null; detail?: string };
  ask_command: string;
}

export type WorldStandout = "single" | "clear" | "crowd";

export interface WorldHintsResult {
  generated_by: "graphrag/world.ts";
  world_dir: string;
  cache: { generated_at: string; provider: string | null; model: string | null };
  considered: number;
  unavailable: { vault_path: string; status: WorldCacheEntryStatus }[];
  semantic: boolean;
  semantic_note: string | null;
  standout: WorldStandout;
  standout_note: string;
  hints: WorldHint[];
  note: string;
}

// 相対判定 (standout) の閾値。実測 (2026-06-11, 4 vault × 7 クエリ) より:
// 正解 vault の合算スコア差はほぼ lexical 由来で平均 ~21 点、ノイズ (意味的に
// 隣接するだけの vault との差) は ~3-5 点。絶対値の confidence (judgeMatchConfidence)
// は自己紹介テキスト同士の類似度レンジが狭く正解が low に落ちることがあるため、
// 「候補の中で突出しているか」を別軸で判定し、突出した top1 は low→high に格上げする。
const STANDOUT_GAP = 15; // top1 と top2 の合算スコア差 (lexical+semantic 各最大 100)
const STANDOUT_FLOOR = 40; // これ未満の弱小 top1 は突出していても格上げしない

// --- world.json (住所録) ----------------------------------------------------

export function resolveWorldDir(flagValue?: string): string | undefined {
  if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;
  const v = process.env.GRAPHRAG_WORLD_DIR;
  return v && v.length > 0 ? v : undefined;
}

export function isRemoteRef(p: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^git@/.test(p);
}

/**
 * world.json を読む。エントリは "path 文字列" か { "path": "..." } のみ。
 * 説明・名前など path 以外のキーは明示エラー: 説明を world に持たせると
 * 「腐る電話帳」(手書きの写しが正本面して陳腐化する) に戻るため、自己紹介は
 * vault 側の VAULT.md (正本) にだけ書く。
 */
export function loadWorldConfig(worldDir: string): WorldConfig {
  const worldPath = path.join(worldDir, WORLD_FILE);
  if (!existsSync(worldPath)) {
    throw new Error(`world.json not found: ${worldPath}`);
  }
  const raw = JSON.parse(readFileSync(worldPath, "utf8"));
  if (!raw || !Array.isArray(raw.vaults)) {
    throw new Error(`world.json: "vaults" must be an array (${worldPath})`);
  }
  const ALLOWED_KEYS = new Set(["path", "slug"]);
  const vaults: WorldVaultRef[] = raw.vaults.map((entry: unknown, i: number) => {
    if (typeof entry === "string" && entry.length > 0) return { path: entry };
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      const p = obj.path;
      if (typeof p !== "string" || p.length === 0) {
        throw new Error(`world.json: vaults[${i}] needs a non-empty "path"`);
      }
      const extra = Object.keys(obj).filter((k) => !ALLOWED_KEYS.has(k));
      if (extra.length > 0) {
        throw new Error(
          `world.json: vaults[${i}] has extra keys [${extra.join(", ")}]. ` +
          `world carries only path and slug; put name/kind/description in the vault's ${VAULT_PROFILE_FILE} (the canonical self-introduction).`
        );
      }
      const slug = typeof obj.slug === "string" && obj.slug.length > 0 ? obj.slug : undefined;
      return { path: p, ...(slug ? { slug } : {}) };
    }
    throw new Error(`world.json: vaults[${i}] must be a path string or { "path": "...", "slug": "..." }`);
  });
  return { vaults };
}

// --- VAULT.md (自己紹介の正本) ----------------------------------------------

export function vaultProfilePath(vaultDir: string): string {
  return path.join(path.dirname(path.resolve(vaultDir)), VAULT_PROFILE_FILE);
}

/**
 * 人手で書く VAULT.md をパースする。寛容な frontmatter (key: value 行のみ) + 本文。
 * frontmatter: name (無ければ vault 親フォルダ名で補完される), kind。本文 = 何の知識があるか。
 */
export function parseVaultProfile(content: string): { name: string | null; kind: string | null; description: string; parent: string | null } {
  let name: string | null = null;
  let kind: string | null = null;
  let parent: string | null = null;
  let body = content;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (fm) {
    body = content.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      if (m[1] === "name" && value) name = value;
      if (m[1] === "kind" && value) kind = value;
      // parent はスカラのみ受け付ける。YAML シーケンス (parent: 改行 - a - b) は value 空で無視され、
      // 結果的に「親は単一」という規約が構造的に強制される。
      if (m[1] === "parent" && value) parent = value;
    }
  }
  return { name, kind, description: body.trim(), parent };
}

export function readVaultProfile(
  vaultDir: string
): { profile: VaultProfile; contentHash: string } | null {
  const profilePath = vaultProfilePath(vaultDir);
  if (!existsSync(profilePath)) return null;
  const content = readFileSync(profilePath, "utf8");
  const parsed = parseVaultProfile(content);
  const fallbackName = path.basename(path.dirname(path.resolve(vaultDir)));
  return {
    profile: {
      name: parsed.name ?? fallbackName,
      kind: parsed.kind,
      description: parsed.description,
      parent: parsed.parent
    },
    contentHash: hashText(content)
  };
}

export function profileVectorText(profile: VaultProfile): string {
  return [profile.name, profile.kind, profile.description]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join("\n");
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** vault 内ノード数 (.md 1 ファイル = 1 ノードの vault 規約に依拠)。dir 不在は null */
export function countVaultNodes(vaultDir: string): number | null {
  if (!existsSync(vaultDir)) return null;
  let count = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(d, entry.name));
      else if (entry.name.endsWith(".md")) count += 1;
    }
  };
  walk(vaultDir);
  return count;
}

/** VAULT.md の mtime (ISO) と vault ノード数。自己紹介の鮮度を蓄積量と並べる材料 */
export function localVaultStat(vaultDir: string): { profile_mtime: string | null; node_count: number | null } {
  const profilePath = vaultProfilePath(vaultDir);
  const profileMtime = existsSync(profilePath) ? statSync(profilePath).mtime.toISOString() : null;
  return { profile_mtime: profileMtime, node_count: countVaultNodes(path.resolve(vaultDir)) };
}

// 自己紹介が蓄積に対して古い可能性を示す閾値。45 日触られていない VAULT.md は
// 「書いた時の vault」を説明している疑いがある (確定判断ではなくヒント)。
const INTRO_STALE_DAYS = 45;

export function introHint(profileMtime: string | null, now: string): string | null {
  if (!profileMtime) return null;
  const mtimeMs = Date.parse(profileMtime);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(nowMs)) return null;
  const elapsedMs = nowMs - mtimeMs;
  if (elapsedMs <= INTRO_STALE_DAYS * 24 * 60 * 60 * 1000) return null;
  const days = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
  return `VAULT.md が ${days}日前から未更新。蓄積に対して自己紹介が古い可能性`;
}

// ヒント出力に載せる自己紹介本文の上限。VAULT.md は数行が想定だが、長文でも
// ask の JSON を膨らませない安全弁 (照合には全文を使う。切るのは表示だけ)。
const HINT_DESCRIPTION_CHARS = 400;

function truncateDescription(text: string): string {
  if (text.length <= HINT_DESCRIPTION_CHARS) return text;
  return `${text.slice(0, HINT_DESCRIPTION_CHARS - 1)}…`;
}

// --- world-cache.json (機械生成の写し) ---------------------------------------

export function worldCachePath(worldDir: string): string {
  return path.join(worldDir, WORLD_CACHE_FILE);
}

export function loadWorldCache(worldDir: string): WorldCache | null {
  const p = worldCachePath(worldDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // 壊れた cache は無いものとして作り直す (機械生成物なので失っても良い)
  }
}

// 並行エージェントが同じ world を見るため、vector.json と同じく tmp+rename の原子書き。
async function writeWorldCache(worldDir: string, cache: WorldCache): Promise<void> {
  await writeFileAtomic(worldCachePath(worldDir), `${JSON.stringify(cache, null, 2)}\n`);
}

interface Embedder {
  id: string;
  metadata?: { endpoint?: string; model?: string };
  embed(text: string): Promise<number[]>;
}

async function buildCacheEntry(refPath: string, embedder: Embedder, now: () => string): Promise<WorldCacheEntry> {
  if (isRemoteRef(refPath)) {
    // リモート vault (git URL) は TTL + 明示 refresh の設計だが fetch は未実装。
    // 黙って欠落させず unavailable として正直に返す。
    return { vault_path: refPath, status: "remote-unsupported", profile: null, content_hash: null, fetched_at: null, vector: null, profile_mtime: null, node_count: null };
  }
  const vaultDir = path.resolve(refPath);
  const stat = localVaultStat(vaultDir);
  const read = readVaultProfile(vaultDir);
  if (!read) {
    return { vault_path: vaultDir, status: "no-profile", profile: null, content_hash: null, fetched_at: null, vector: null, ...stat };
  }
  const vector = await embedder.embed(profileVectorText(read.profile));
  return {
    vault_path: vaultDir,
    status: "ok",
    profile: read.profile,
    content_hash: read.contentHash,
    fetched_at: now(),
    vector,
    ...stat
  };
}

/**
 * world.json の全 vault の自己紹介を読み直し、embedding し、world-cache.json を書く。
 * options.embedder はテスト/呼び出し側注入用 (既定は自動検出 provider)。
 */
export async function refreshWorldCache(
  worldDir: string,
  options: { embedder?: Embedder; now?: () => string } = {}
): Promise<WorldCache> {
  const config = loadWorldConfig(worldDir);
  const embedder = options.embedder ?? (await resolveVectorProvider());
  const now = options.now ?? (() => new Date().toISOString());
  const entries: WorldCacheEntry[] = [];
  for (const ref of config.vaults) {
    entries.push(await buildCacheEntry(ref.path, embedder, now));
  }
  const cache: WorldCache = {
    version: 1,
    provider: embedder.id ?? null,
    dimensions: entries.find((e) => e.vector)?.vector?.length ?? null,
    provider_options: embedder.metadata
      ? { endpoint: embedder.metadata.endpoint, model: embedder.metadata.model }
      : null,
    generated_at: now(),
    entries
  };
  await writeWorldCache(worldDir, cache);
  return cache;
}

// --- ask 時のヒント -----------------------------------------------------------

function cacheEmbedder(cache: WorldCache): Embedder {
  return createVectorProvider({
    provider: cache.provider,
    endpoint: cache.provider_options?.endpoint,
    model: cache.provider_options?.model
  });
}

/**
 * 鮮度の運用 (ローカル vault): ask 時に自己紹介ファイルの内容ハッシュだけ確認し、
 * 変わっていた時だけ読み直して再 embedding する。world.json と cache のズレ
 * (追加/削除) もここで吸収する。再 embedding 失敗は stale として正直に返す
 * (ヒント機構は ask を落とさない)。
 */
async function syncCacheWithWorld(
  worldDir: string,
  cache: WorldCache | null,
  options: { embedder?: Embedder; now?: () => string }
): Promise<{ cache: WorldCache; freshness: Map<string, WorldHint["freshness"]> }> {
  const config = loadWorldConfig(worldDir);
  const now = options.now ?? (() => new Date().toISOString());
  const freshness = new Map<string, WorldHint["freshness"]>();
  let embedder = options.embedder ?? null;
  const getEmbedder = () => (embedder ??= cache ? cacheEmbedder(cache) : null);

  const oldByPath = new Map((cache?.entries ?? []).map((e) => [e.vault_path, e]));
  const entries: WorldCacheEntry[] = [];
  let changed = cache === null;

  for (const ref of config.vaults) {
    const key = isRemoteRef(ref.path) ? ref.path : path.resolve(ref.path);
    const old = oldByPath.get(key);

    if (isRemoteRef(ref.path)) {
      entries.push(old ?? { vault_path: key, status: "remote-unsupported", profile: null, content_hash: null, fetched_at: null, vector: null, profile_mtime: null, node_count: null });
      if (!old) changed = true;
      continue;
    }

    const read = readVaultProfile(key);
    if (!read) {
      entries.push({ vault_path: key, status: "no-profile", profile: null, content_hash: null, fetched_at: null, vector: null, ...localVaultStat(key) });
      if (!old || old.status !== "no-profile") changed = true;
      continue;
    }

    if (old && old.status === "ok" && old.content_hash === read.contentHash && old.vector) {
      entries.push(old);
      freshness.set(key, { state: "fresh", fetched_at: old.fetched_at });
      continue;
    }

    // 自己紹介が変わった / cache に無い → その vault だけ再 embedding
    const stat = localVaultStat(key);
    try {
      const e = getEmbedder();
      if (!e) throw new Error("world-cache has no embedding provider recorded; run world-refresh first");
      const vector = await e.embed(profileVectorText(read.profile));
      entries.push({ vault_path: key, status: "ok", profile: read.profile, content_hash: read.contentHash, fetched_at: now(), vector, ...stat });
      freshness.set(key, { state: "refreshed", fetched_at: now() });
      changed = true;
    } catch (error) {
      // 再 embedding できない時は古い写しのまま使い、stale と明示する
      const detail = `re-embed failed: ${error instanceof Error ? error.message : String(error)}`;
      if (old && old.vector) {
        entries.push({ ...old, profile: read.profile, ...stat });
        freshness.set(key, { state: "stale", fetched_at: old.fetched_at, detail });
        changed = true;
      } else {
        entries.push({ vault_path: key, status: "ok", profile: read.profile, content_hash: read.contentHash, fetched_at: null, vector: null, ...stat });
        freshness.set(key, { state: "stale", fetched_at: null, detail });
        changed = true;
      }
    }
  }

  if ((cache?.entries.length ?? 0) !== entries.length) changed = true;

  const nextCache: WorldCache = {
    version: 1,
    provider: cache?.provider ?? (options.embedder?.id ?? null),
    dimensions: entries.find((e) => e.vector)?.vector?.length ?? cache?.dimensions ?? null,
    provider_options: cache?.provider_options
      ?? (options.embedder?.metadata
        ? { endpoint: options.embedder.metadata.endpoint, model: options.embedder.metadata.model }
        : null),
    generated_at: changed ? now() : (cache?.generated_at ?? now()),
    entries
  };
  if (changed) await writeWorldCache(worldDir, nextCache);
  return { cache: nextCache, freshness };
}

/**
 * 問いと各 vault の自己紹介 (写し) を突き合わせ「vault X にも知識がありそう」という
 * ヒントを返す。突き合わせは手元検索と同じ lexical+semantic 対等合算 (searchGraph 流用)。
 * クエリ embedding は手元検索のものを共用できる (model/次元一致時)。
 * 自動で他 vault に ask しに行くことはしない — 掛けるかどうかは呼び手の判断。
 */
export async function buildWorldHints(
  query: string,
  options: {
    worldDir: string;
    currentVaultDir?: string;
    queryVector?: number[] | null;
    queryModel?: string | null;
    limit?: number;
    embedder?: Embedder; // テスト/初回 cache 構築用の注入口
    now?: () => string;
  }
): Promise<WorldHintsResult> {
  const { worldDir } = options;
  let cache = loadWorldCache(worldDir);
  if (!cache) {
    // 初回は写しが無いのでその場で構築する (world.json の vault 数ぶんの embedding 1 回きり)
    cache = await refreshWorldCache(worldDir, { embedder: options.embedder, now: options.now });
  }
  const synced = await syncCacheWithWorld(worldDir, cache, options);
  cache = synced.cache;

  const currentVaultPath = options.currentVaultDir ? path.resolve(options.currentVaultDir) : null;
  const candidates = cache.entries.filter(
    (e) => e.status === "ok" && e.vault_path !== currentVaultPath
  );
  const unavailable = cache.entries
    .filter((e) => e.status !== "ok")
    .map((e) => ({ vault_path: e.vault_path, status: e.status }));

  // クエリ embedding の共用可否: 手元 index と cache が同じ model・同じ次元の時だけ。
  // 違う model/次元の cosine は黙って誤る (cosineSimilarity は min 長で比較する) ので、
  // 共用できない時は cache の provider で 1 回だけ embed し直し、それも無理なら
  // lexical だけで突き合わせて semantic 無しを明示する。
  const cacheDims = cache.dimensions;
  let queryVector: number[] | null = null;
  let semanticNote: string | null = null;
  const modelMatches =
    options.queryVector &&
    options.queryModel != null &&
    cache.provider_options?.model === options.queryModel &&
    (cacheDims == null || options.queryVector.length === cacheDims);
  if (modelMatches) {
    queryVector = options.queryVector!;
  } else {
    try {
      const e = options.embedder ?? cacheEmbedder(cache);
      queryVector = await e.embed(query);
    } catch (error) {
      semanticNote = `semantic comparison unavailable (${error instanceof Error ? error.message : String(error)}); lexical only`;
    }
  }

  // 自己紹介の写しを擬似ノード化し、手元検索と同じ対等合算でランク付けする
  const pseudoGraph = {
    nodes: candidates.map((e) => ({
      id: e.vault_path,
      type: "Vault",
      title: e.profile!.name,
      summary: e.profile!.description,
      tags: e.profile!.kind ? [e.profile!.kind] : []
    })),
    edges: []
  };
  const vectorIndex = {
    rows: candidates
      .filter((e) => e.vector)
      .map((e) => ({ node_id: e.vault_path, vector: e.vector }))
  };
  // 相対判定のため、表示上限でなく候補全件をランク付けする (score 0 は searchGraph が落とす)
  const ranked = searchGraph(pseudoGraph, query, {
    vectorIndex,
    queryVector,
    roleWeights: false,
    limit: Math.max(candidates.length, 1)
  });

  // 相対判定: 候補の中で top1 が突出しているか。絶対値 (confidence) と独立の軸。
  // 全候補が横並び (crowd) なら「どの vault も同程度 = ヒントとして弱い」が正直な読み。
  const top1Score = ranked[0]?.score ?? 0;
  const top2Score = ranked[1]?.score ?? 0;
  const gap = top1Score - top2Score;
  const standout: WorldStandout =
    candidates.length <= 1
      ? "single"
      : gap >= STANDOUT_GAP && top1Score >= STANDOUT_FLOOR
        ? "clear"
        : "crowd";

  const hints: WorldHint[] = ranked
    .slice(0, options.limit ?? 3)
    .map((m: any, i: number) => {
      const entry = candidates.find((e) => e.vault_path === m.node.id)!;
      let confidence = judgeMatchConfidence(m);
      // 突出した top1 は low→high に格上げ (自己紹介同士の類似度レンジが狭く、
      // 絶対値だけだと正解ヒントが low に落ちる実測結果への対処)
      if (i === 0 && standout === "clear" && confidence === "low") confidence = "high";
      return {
        // description (自己紹介の本文) も添える: 上位 2-3 件に絞った後なので量は小さく、
        // 呼び手の LLM が「実際に掛けるか」を判断する材料になる (名前と種別だけでは薄い)
        vault: {
          name: entry.profile!.name,
          kind: entry.profile!.kind,
          path: entry.vault_path,
          description: truncateDescription(entry.profile!.description)
        },
        score: m.score,
        gap_above_next: i === 0 && candidates.length > 1 ? Number(gap.toFixed(3)) : null,
        reasons: m.reasons,
        confidence,
        freshness: synced.freshness.get(entry.vault_path) ?? { state: "fresh" as const, fetched_at: entry.fetched_at },
        ask_command: `node --experimental-strip-types graphrag/cli.ts ask "${query.replace(/"/g, '\\"')}" --vault ${entry.vault_path}`
      };
    })
    .filter((h) => h.confidence !== "none");

  const standoutNotes: Record<WorldStandout, string> = {
    single: "候補 vault が 1 つだけのため相対判定なし (confidence は絶対値のみ)。",
    clear: "top1 が他の候補から突出している。問いがこの vault の領域に固有である可能性が高い。",
    crowd: "候補が横並びで突出なし。どの vault も同程度にしか近くない (本当に複数に関係するか、どこにも無いかのどちらか)。"
  };

  return {
    generated_by: "graphrag/world.ts",
    world_dir: worldDir,
    cache: {
      generated_at: cache.generated_at,
      provider: cache.provider,
      model: cache.provider_options?.model ?? null
    },
    considered: candidates.length,
    unavailable,
    semantic: queryVector != null,
    semantic_note: semanticNote,
    standout,
    standout_note: standoutNotes[standout],
    hints,
    note: "ヒントのみ。別 vault に実際に掛ける (ask_command を実行する) かどうかは呼び手の判断。"
  };
}

// --- CLI (primitive verb: world-refresh) --------------------------------------

export interface WorldRefreshVaultReport {
  vault_path: string;
  status: WorldCacheEntryStatus;
  name: string | null;
  kind: string | null;
  fetched_at: string | null;
  profile_mtime: string | null;
  node_count: number | null;
  intro_hint?: string; // 45 日より古い VAULT.md にだけ添える (確定判断ではなくヒント)
}

/** world-refresh の出力を組み立てる (main から分離して now 注入でテスト可能に) */
export function buildWorldRefreshReport(
  worldDir: string,
  cache: WorldCache,
  options: { now?: () => string } = {}
) {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    world_dir: worldDir,
    cache_path: worldCachePath(worldDir),
    provider: cache.provider,
    model: cache.provider_options?.model ?? null,
    dimensions: cache.dimensions,
    generated_at: cache.generated_at,
    vaults: cache.entries.map((e): WorldRefreshVaultReport => {
      const hint = introHint(e.profile_mtime ?? null, now());
      return {
        vault_path: e.vault_path,
        status: e.status,
        name: e.profile?.name ?? null,
        kind: e.profile?.kind ?? null,
        fetched_at: e.fetched_at,
        profile_mtime: e.profile_mtime ?? null,
        node_count: e.node_count ?? null,
        ...(hint ? { intro_hint: hint } : {})
      };
    })
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const flagIdx = argv.indexOf("--world");
  const flagValue = flagIdx >= 0 ? argv[flagIdx + 1] : argv.find((a) => !a.startsWith("--"));
  const worldDir = resolveWorldDir(flagValue);
  if (!worldDir) {
    throw new Error(
      "world directory not specified. Pass --world <dir> (or positional <dir>) or set GRAPHRAG_WORLD_DIR. " +
      `The directory must contain ${WORLD_FILE} (a pointer list of vaults).`
    );
  }
  const cache = await refreshWorldCache(worldDir);
  process.stdout.write(JSON.stringify(buildWorldRefreshReport(worldDir, cache), null, 2) + "\n");
}

function isMainModule(url: string): boolean {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
if (isMainModule(import.meta.url)) {
  await main();
}

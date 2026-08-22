/**
 * Cross-vault reference resolver (Stage 3).
 *
 * Edge `to` fields may contain `vault:<slug>/...` prefixed IDs when the target
 * node lives in a different vault. validateGraph() already skips existence and
 * type-pair checks for these refs (Stage 2). This module adds Stage 3: actually
 * fetching the referenced node from the sibling vault so callers can display its
 * title/summary without having to run a full `ask` against that vault.
 *
 * Design constraints:
 * - Lazy: only resolves when explicitly called — no eager load on vault open.
 * - Graceful: GRAPHRAG_WORLD_DIR not set, vault not found, node not found all
 *   return null (or appropriate status) rather than throwing.
 * - Read-only: never mutates any vault.
 * - Minimal: this is a first implementation, not a full cross-vault query engine.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { importVault } from "./import-vault.ts";
import { loadWorldConfig, WORLD_FILE, type WorldVaultRef } from "./world.ts";
import { resolveSchema } from "./schema-registry.ts";
import { latestTombstones, resolveSuccessor, type TombstoneEntry } from "./tombstones.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrossVaultRefParts {
  /** vault_slug of the target vault (e.g. "billing") */
  vaultSlug: string;
  /** local node id within the target vault (e.g. "deliverable:billing:v2-release") */
  nodeId: string;
}

export interface ResolvedNode {
  /** The cross-vault ref string that was resolved (e.g. "vault:billing/deliverable:billing:v2-release") */
  ref: string;
  /** vault_path: absolute path to the vault directory where this node was found */
  vault_path: string;
  /** node id within that vault */
  node_id: string;
  type: string | null;
  title: string | null;
  summary: string | null;
}

export type XRefStatus = "resolved" | "broken" | "tombstoned" | "orphan" | "unresolvable";

export interface XRefCheckResult {
  /** Original cross-vault ref string */
  ref: string;
  /** Edge id that carries this ref */
  edge_id: string | undefined;
  status: XRefStatus;
  /** Populated when status === "resolved" */
  resolved?: ResolvedNode;
  /** Human-readable explanation for non-resolved statuses */
  detail?: string;
  /** Populated when the ref matched via a vault_slug_alias instead of the current vault_slug */
  alias_warning?: string;
  /**
   * Populated when status === "tombstoned": the target vault's deletion ledger knows this
   * node id. `final_successor` is the collapsed successor chain (301); null means the
   * knowledge is gone with no successor (410 — the ref cannot be repaired, only removed).
   * `successor_alive` reports whether the final successor currently exists in the target
   * vault (the repair-target check; null when there is no successor).
   */
  tombstone?: {
    deleted_at: string;
    reason: string;
    final_successor: string | null;
    chain: string[];
    successor_alive: boolean | null;
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a cross-vault ref of the form `vault:<slug>/<nodeId>`.
 * Returns null if the string is not a cross-vault ref.
 *
 * Examples:
 *   "vault:billing/deliverable:billing:v2-release"
 *     → { vaultSlug: "billing", nodeId: "deliverable:billing:v2-release" }
 *   "decision:some:local-node"
 *     → null
 */
export function parseCrossVaultRef(ref: string): CrossVaultRefParts | null {
  if (!ref.startsWith("vault:")) return null;
  const rest = ref.slice("vault:".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx < 0) return null;
  const vaultSlug = rest.slice(0, slashIdx);
  const nodeId = rest.slice(slashIdx + 1);
  if (!vaultSlug || !nodeId) return null;
  return { vaultSlug, nodeId };
}

// ---------------------------------------------------------------------------
// Vault slug lookup
// ---------------------------------------------------------------------------

/**
 * Parse the `vault_slug` field from VAULT.md frontmatter.
 * Uses the same lenient frontmatter format as parseVaultProfile / parseSchemaField.
 * Returns null if not present.
 */
export function parseVaultSlug(vaultMdContent: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(vaultMdContent);
  if (!fm) return null;
  for (const line of fm[1].split(/\r?\n/)) {
    const m = /^vault_slug\s*:\s*(.*)$/.exec(line.trim());
    if (m) {
      const value = m[1].trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  }
  return null;
}

/**
 * Parse the `vault_slug_aliases` list from VAULT.md frontmatter.
 * Supports YAML sequence syntax:
 *   vault_slug_aliases:
 *     - old-slug
 *     - another-old-slug
 * Returns an empty array if not present or empty.
 */
export function parseVaultSlugAliases(vaultMdContent: string): string[] {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(vaultMdContent);
  if (!fm) return [];
  const fmLines = fm[1].split(/\r?\n/);
  const aliases: string[] = [];
  let inAliasBlock = false;
  for (const line of fmLines) {
    if (/^vault_slug_aliases\s*:/.test(line.trim())) {
      inAliasBlock = true;
      continue;
    }
    if (inAliasBlock) {
      const itemMatch = /^\s*-\s+(.+)$/.exec(line);
      if (itemMatch) {
        const value = itemMatch[1].trim().replace(/^["']|["']$/g, "");
        if (value) aliases.push(value);
      } else if (line.trim() && !/^\s/.test(line)) {
        // A non-indented, non-empty line that is not a list item ends the block
        break;
      }
    }
  }
  return aliases;
}

/**
 * Parse the `parent` field from VAULT.md frontmatter.
 *
 * `parent` is the vault_slug of the structural parent vault — a *containment*
 * relation between vaults, NOT a node-to-node link. Single parent only: the
 * value is a scalar, so a YAML sequence (`parent:` then `- a` / `- b`) parses
 * to an empty value and is ignored, which structurally enforces "one parent".
 * Returns null if absent.
 */
export function parseVaultParent(vaultMdContent: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(vaultMdContent);
  if (!fm) return null;
  for (const line of fm[1].split(/\r?\n/)) {
    const m = /^parent\s*:\s*(.*)$/.exec(line.trim());
    if (m) {
      const value = m[1].trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  }
  return null;
}

/** Parsed vault identity from VAULT.md: primary slug + optional aliases */
interface VaultSlugInfo {
  slug: string;
  aliases: string[];
}

/**
 * Read vault_slug and vault_slug_aliases from the VAULT.md that is a sibling of `vaultDir`.
 * VAULT.md lives at `path.dirname(vaultDir)/VAULT.md` per the vault convention.
 * Returns null if VAULT.md is absent or has no vault_slug field.
 */
function readVaultSlugInfoForDir(vaultDir: string): VaultSlugInfo | null {
  const profilePath = path.join(path.dirname(path.resolve(vaultDir)), "VAULT.md");
  if (!existsSync(profilePath)) return null;
  try {
    const content = readFileSync(profilePath, "utf8");
    const slug = parseVaultSlug(content);
    if (!slug) return null;
    const aliases = parseVaultSlugAliases(content);
    return { slug, aliases };
  } catch {
    return null;
  }
}

/** Result of findVaultBySlugWithInfo: the resolved vault dir plus alias metadata. */
export interface FindVaultResult {
  /** Absolute path to the vault directory */
  vaultDir: string;
  /** Current vault_slug declared in VAULT.md */
  currentSlug: string;
  /** True when the lookup matched via vault_slug_aliases, not the primary slug */
  matchedViaAlias: boolean;
}

// ---------------------------------------------------------------------------
// Resolution context (issue #32)
// ---------------------------------------------------------------------------

/**
 * DI hooks for the IO primitives the resolver consumes. Tests use these to
 * count filesystem-heavy calls; production callers never need to set them.
 */
export interface XRefResolutionContextOptions {
  importVaultFn?: (vaultDir: string) => { nodes?: any[]; edges?: any[] };
  loadWorldConfigFn?: (worldDir: string) => { vaults: WorldVaultRef[] };
  latestTombstonesFn?: (vaultDir: string) => Map<string, TombstoneEntry>;
}

/** Prebuilt slug → vault lookup for one worldDir (see buildSlugLookup). */
interface SlugLookup {
  find(slug: string): FindVaultResult | null;
}

/**
 * Command スコープの参照解決 context (issue #32)。
 *
 * cross-vault 参照の解決は edge / relation ごとに world slug lookup・target vault の
 * importVault フル walk・node 線形探索・tombstone シャード再読を繰り返していた。この
 * context は 1 コマンド実行の間だけ生きるキャッシュで、同じ world / vault / ref への
 * 再読込を 1 回に畳む。
 *
 * 寿命設計: プロセスは短命・vault は読み取り専用という前提で、**寿命は 1 command に
 * 限定する** — 長期 stale cache は作らない。resolveCrossVaultRef /
 * checkCrossVaultRefs / augmentMatchesWithXRefResolutions の context 引数は省略可能で、
 * 省略時は内部で都度作る (= 従来どおりの単発挙動)。
 */
export interface XRefResolutionContext {
  readonly importVaultFn: (vaultDir: string) => { nodes?: any[]; edges?: any[] };
  readonly loadWorldConfigFn: (worldDir: string) => { vaults: WorldVaultRef[] };
  readonly latestTombstonesFn: (vaultDir: string) => Map<string, TombstoneEntry>;
  /** worldDir → prebuilt slug lookup (world.json + VAULT.md scan を 1 回に) */
  readonly slugLookups: Map<string, SlugLookup>;
  /** vaultDir → imported graph、または import 失敗 (エラーも 1 回で確定させる) */
  readonly graphs: Map<string, { graph: { nodes?: any[]; edges?: any[] } } | { error: unknown }>;
  /** vaultDir → node id → 最初に現れた node (`.find` / `.some` の置換) */
  readonly nodesById: Map<string, Map<string, any>>;
  /** vaultDir → 台帳の last-wins Map */
  readonly tombstones: Map<string, Map<string, TombstoneEntry>>;
  /** `${worldDir}\n${ref}` → resolveCrossVaultRef の結果 (ref 文字列で dedup) */
  readonly resolvedRefs: Map<string, ResolvedNode | null>;
}

export function createXRefResolutionContext(
  opts: XRefResolutionContextOptions = {}
): XRefResolutionContext {
  return {
    importVaultFn: opts.importVaultFn ?? importVault,
    loadWorldConfigFn: opts.loadWorldConfigFn ?? loadWorldConfig,
    latestTombstonesFn: opts.latestTombstonesFn ?? latestTombstones,
    slugLookups: new Map(),
    graphs: new Map(),
    nodesById: new Map(),
    tombstones: new Map(),
    resolvedRefs: new Map()
  };
}

/** first-wins insert — 元実装の「走査順で最初の一致が勝つ」を map 化しても保存する。 */
function setFirst<V>(map: Map<string, V>, key: string, value: V): void {
  if (!map.has(key)) map.set(key, value);
}

/**
 * worldDir を 1 回だけ走査して slug → FindVaultResult の lookup 構造を作る。
 *
 * 元の per-query 実装 (world.json slug loop → slug 無し entry の VAULT.md probe →
 * alias fallback、無 world.json 時はディレクトリ走査) の優先順位をそのまま map の
 * 検索順で再現する:
 *   1. world.json slug の exact (entry 順で最初)
 *   2. slug 無し entry の VAULT.md exact (entry 順で最初)
 *   3. alias (slug あり entry → slug 無し entry の元走査順で最初)
 * ディレクトリ走査 fallback では exact (走査順) > alias (走査順)。
 */
function buildSlugLookup(worldDir: string, ctx: XRefResolutionContext): SlugLookup {
  if (!existsSync(worldDir)) return { find: () => null };

  // --- Strategy 1: world.json slug lookup ---
  let worldConfig: { vaults: WorldVaultRef[] } | null = null;
  try {
    worldConfig = ctx.loadWorldConfigFn(worldDir);
  } catch {
    // world.json absent or malformed — fall through to directory scan
  }

  if (worldConfig) {
    const worldExact = new Map<string, FindVaultResult>();
    const vaultMdExact = new Map<string, FindVaultResult>();
    const aliasMatches = new Map<string, FindVaultResult>();
    const noSlugEntries: WorldVaultRef[] = [];

    for (const ref of worldConfig.vaults) {
      if (ref.slug) {
        const vaultDir = path.resolve(ref.path);
        setFirst(worldExact, ref.slug, { vaultDir, currentSlug: ref.slug, matchedViaAlias: false });
        // world.json slug doesn't carry aliases — check VAULT.md for alias matches
        const info = readVaultSlugInfoForDir(vaultDir);
        if (info) {
          for (const alias of info.aliases) {
            setFirst(aliasMatches, alias, { vaultDir, currentSlug: info.slug, matchedViaAlias: true });
          }
        }
      } else {
        noSlugEntries.push(ref);
      }
    }

    // Probe VAULT.md for entries that lack a slug in world.json
    for (const ref of noSlugEntries) {
      const vaultDir = path.resolve(ref.path);
      const info = readVaultSlugInfoForDir(vaultDir);
      if (info) {
        setFirst(vaultMdExact, info.slug, { vaultDir, currentSlug: info.slug, matchedViaAlias: false });
        for (const alias of info.aliases) {
          setFirst(aliasMatches, alias, { vaultDir, currentSlug: info.slug, matchedViaAlias: true });
        }
      }
    }

    return {
      find: (slug) => worldExact.get(slug) ?? vaultMdExact.get(slug) ?? aliasMatches.get(slug) ?? null
    };
  }

  // --- Strategy 2: fallback directory scan (no world.json) ---
  let entries: string[];
  try {
    entries = readdirSync(worldDir);
  } catch {
    return { find: () => null };
  }
  const exactMatches = new Map<string, FindVaultResult>();
  const aliasMatches = new Map<string, FindVaultResult>();
  for (const entry of entries) {
    const entryAbs = path.join(worldDir, entry);

    let dir: string | null = null;
    const canonicalVault = path.join(entryAbs, "vault");
    if (existsSync(canonicalVault)) {
      dir = canonicalVault;
    } else {
      try {
        if (statSync(entryAbs).isDirectory()) dir = entryAbs;
      } catch {
        // ignore non-accessible entries
      }
    }
    if (!dir) continue;

    const info = readVaultSlugInfoForDir(dir);
    if (info) {
      const vaultDir = path.resolve(dir);
      setFirst(exactMatches, info.slug, { vaultDir, currentSlug: info.slug, matchedViaAlias: false });
      for (const alias of info.aliases) {
        setFirst(aliasMatches, alias, { vaultDir, currentSlug: info.slug, matchedViaAlias: true });
      }
    }
  }
  return { find: (slug) => exactMatches.get(slug) ?? aliasMatches.get(slug) ?? null };
}

/** context 経由で worldDir の slug lookup を取得する (worldDir ごとに 1 回だけ構築)。 */
function slugLookupFor(ctx: XRefResolutionContext, worldDir: string): SlugLookup {
  let lookup = ctx.slugLookups.get(worldDir);
  if (!lookup) {
    lookup = buildSlugLookup(worldDir, ctx);
    ctx.slugLookups.set(worldDir, lookup);
  }
  return lookup;
}

/** context 経由で vault を import する (成功も失敗も vaultDir ごとに 1 回で確定)。 */
function importVaultCached(
  ctx: XRefResolutionContext,
  vaultDir: string
): { graph: { nodes?: any[]; edges?: any[] } } | { error: unknown } {
  let entry = ctx.graphs.get(vaultDir);
  if (!entry) {
    try {
      entry = { graph: ctx.importVaultFn(vaultDir) };
    } catch (error) {
      entry = { error };
    }
    ctx.graphs.set(vaultDir, entry);
  }
  return entry;
}

/**
 * node id → node の Map (`.find` の置換)。重複 id は最初の node が勝つ
 * (`Array.prototype.find` と同じ意味論)。
 */
function nodeMapFor(
  ctx: XRefResolutionContext,
  vaultDir: string,
  graph: { nodes?: any[] }
): Map<string, any> {
  let map = ctx.nodesById.get(vaultDir);
  if (!map) {
    map = new Map();
    for (const node of graph.nodes ?? []) {
      if (!map.has(node.id)) map.set(node.id, node);
    }
    ctx.nodesById.set(vaultDir, map);
  }
  return map;
}

/** context 経由で台帳を読む (vaultDir ごとに 1 回だけシャード読込+ソート)。 */
function tombstonesFor(ctx: XRefResolutionContext, vaultDir: string): Map<string, TombstoneEntry> {
  let map = ctx.tombstones.get(vaultDir);
  if (!map) {
    map = ctx.latestTombstonesFn(vaultDir);
    ctx.tombstones.set(vaultDir, map);
  }
  return map;
}

/**
 * Look up a vault by slug. Resolution strategy:
 *
 *   1. **world.json fast path** — if `<worldDir>/world.json` exists, scan its
 *      entries for a matching `slug` field. Entries without a `slug` field are
 *      probed via VAULT.md (step 2's mechanism) after all slugged entries.
 *   2. **VAULT.md probe** — for entries in world.json that lack a slug, and
 *      as a full fallback when world.json is absent, read each vault's
 *      VAULT.md and check `vault_slug` / `vault_slug_aliases`.
 *
 * Resolution order within each strategy:
 *   a. Exact match on vault_slug (or world.json slug) — matchedViaAlias: false
 *   b. Match in vault_slug_aliases (VAULT.md only) — matchedViaAlias: true
 *
 * `ctx` (optional) caches the whole worldDir scan for the lifetime of one
 * command; omitted, a throwaway context is built per call (従来どおり).
 */
export function findVaultBySlugWithInfo(
  slug: string,
  worldDir: string,
  ctx?: XRefResolutionContext
): FindVaultResult | null {
  return slugLookupFor(ctx ?? createXRefResolutionContext(), worldDir).find(slug);
}

/**
 * Convenience wrapper: returns only the vault dir path (backwards-compatible).
 * For alias detection use findVaultBySlugWithInfo.
 */
export function findVaultBySlug(slug: string, worldDir: string): string | null {
  const result = findVaultBySlugWithInfo(slug, worldDir);
  return result ? result.vaultDir : null;
}

// ---------------------------------------------------------------------------
// Node resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a cross-vault ref by reading the target node from the target vault.
 *
 * @param ref       Full cross-vault ref string, e.g. "vault:billing/deliverable:billing:v2"
 * @param worldDir  Directory to scan for sibling vaults. Falls back to
 *                  process.env.GRAPHRAG_WORLD_DIR when not provided.
 * @param ctx       Optional command-scoped resolution context (issue #32) —
 *                  shares world scan / vault import / ref dedup across calls.
 * @returns ResolvedNode when found, null otherwise.
 */
export function resolveCrossVaultRef(
  ref: string,
  worldDir?: string,
  ctx?: XRefResolutionContext
): ResolvedNode | null {
  const parts = parseCrossVaultRef(ref);
  if (!parts) return null;

  const resolvedWorldDir = worldDir ?? process.env.GRAPHRAG_WORLD_DIR;
  if (!resolvedWorldDir) return null;

  const context = ctx ?? createXRefResolutionContext();
  // parseCrossVaultRef は純関数なので (worldDir, ref) で結果を dedup できる
  const cacheKey = `${resolvedWorldDir}\n${ref}`;
  if (context.resolvedRefs.has(cacheKey)) return context.resolvedRefs.get(cacheKey)!;

  const result = resolveCrossVaultRefUncached(ref, parts, resolvedWorldDir, context);
  context.resolvedRefs.set(cacheKey, result);
  return result;
}

function resolveCrossVaultRefUncached(
  ref: string,
  parts: CrossVaultRefParts,
  resolvedWorldDir: string,
  context: XRefResolutionContext
): ResolvedNode | null {
  const findResult = findVaultBySlugWithInfo(parts.vaultSlug, resolvedWorldDir, context);
  if (!findResult) return null;

  // Read the vault (once per command via context) and find the node by id
  const imported = importVaultCached(context, findResult.vaultDir);
  if (!("graph" in imported)) return null;

  const node = nodeMapFor(context, findResult.vaultDir, imported.graph).get(parts.nodeId);
  if (!node) return null;

  return {
    ref,
    vault_path: findResult.vaultDir,
    node_id: parts.nodeId,
    type: typeof node.type === "string" ? node.type : null,
    title: typeof node.title === "string" ? node.title : null,
    summary: typeof node.summary === "string" ? node.summary : null
  };
}

// ---------------------------------------------------------------------------
// Batch xref-check over an entire vault
// ---------------------------------------------------------------------------

/**
 * Scan all edges in a graph for cross-vault refs and attempt to resolve each one.
 * Returns an array of XRefCheckResult, one per unique (edge_id, ref) pair.
 *
 * Status semantics:
 *   resolved    — vault found, node found
 *   broken      — vault found (slug matches), but the node id is missing in that vault
 *   orphan      — no vault with the given slug found in worldDir
 *   unresolvable — GRAPHRAG_WORLD_DIR not configured; can't attempt resolution
 */
export function checkCrossVaultRefs(
  graph: { nodes?: any[]; edges?: any[] },
  worldDir?: string,
  ctx?: XRefResolutionContext
): XRefCheckResult[] {
  const resolvedWorldDir = worldDir ?? process.env.GRAPHRAG_WORLD_DIR;
  // command スコープ context (issue #32): 同一 target vault への複数 edge が
  // world scan / importVault / 台帳読込を共有する。省略時は単発 (従来どおり)。
  const context = ctx ?? createXRefResolutionContext();

  const results: XRefCheckResult[] = [];

  for (const edge of graph.edges ?? []) {
    const to = edge.to;
    if (typeof to !== "string" || !to.startsWith("vault:")) continue;

    const ref = to;
    const edgeId = typeof edge.id === "string" ? edge.id : undefined;

    if (!resolvedWorldDir) {
      results.push({
        ref,
        edge_id: edgeId,
        status: "unresolvable",
        detail: "GRAPHRAG_WORLD_DIR not set; cannot attempt cross-vault resolution"
      });
      continue;
    }

    const parts = parseCrossVaultRef(ref);
    if (!parts) {
      results.push({
        ref,
        edge_id: edgeId,
        status: "unresolvable",
        detail: `malformed cross-vault ref: "${ref}"`
      });
      continue;
    }

    const findResult = findVaultBySlugWithInfo(parts.vaultSlug, resolvedWorldDir, context);
    if (!findResult) {
      results.push({
        ref,
        edge_id: edgeId,
        status: "orphan",
        detail: `no vault with vault_slug "${parts.vaultSlug}" found in ${resolvedWorldDir}`
      });
      continue;
    }

    const { vaultDir, currentSlug, matchedViaAlias } = findResult;

    // Vault exists — check if the node is there (import once per command)
    const imported = importVaultCached(context, vaultDir);
    if (!("graph" in imported)) {
      const err = imported.error;
      results.push({
        ref,
        edge_id: edgeId,
        status: "orphan",
        detail: `vault at ${vaultDir} could not be read: ${err instanceof Error ? err.message : String(err)}`
      });
      continue;
    }

    const nodeMap = nodeMapFor(context, vaultDir, imported.graph);
    const node = nodeMap.get(parts.nodeId);
    if (!node) {
      // 台帳 (issue #18): 消えた ID が tombstone にあれば「単に壊れた」ではなく
      // 「削除済み・後継はこれ (301)」として報告する。後継チェーンは畳み、後継の
      // 生存も確認する (修復先が実在しない tombstone は 410 相当として扱える)。
      const tombs = tombstonesFor(context, vaultDir);
      const entry = tombs.get(parts.nodeId);
      if (entry) {
        const resolution = resolveSuccessor(tombs, parts.nodeId);
        const successorAlive =
          resolution.final_successor === null
            ? null
            : nodeMap.has(resolution.final_successor);
        results.push({
          ref,
          edge_id: edgeId,
          status: "tombstoned",
          detail:
            resolution.final_successor === null
              ? `node "${parts.nodeId}" was deleted (${entry.deleted_at}) with no successor — gone (410)`
              : `node "${parts.nodeId}" was deleted (${entry.deleted_at}); successor: ${resolution.final_successor} (301)`,
          tombstone: {
            deleted_at: entry.deleted_at,
            reason: entry.reason,
            final_successor: resolution.final_successor,
            chain: resolution.chain,
            successor_alive: successorAlive
          }
        });
        continue;
      }
      results.push({
        ref,
        edge_id: edgeId,
        status: "broken",
        detail: `vault "${parts.vaultSlug}" found at ${vaultDir} but node "${parts.nodeId}" is missing`
      });
      continue;
    }

    const result: XRefCheckResult = {
      ref,
      edge_id: edgeId,
      status: "resolved",
      resolved: {
        ref,
        vault_path: vaultDir,
        node_id: parts.nodeId,
        type: typeof node.type === "string" ? node.type : null,
        title: typeof node.title === "string" ? node.title : null,
        summary: typeof node.summary === "string" ? node.summary : null
      }
    };
    if (matchedViaAlias) {
      result.alias_warning = `ref uses alias '${parts.vaultSlug}', current slug is '${currentSlug}' — update ref to use current slug`;
    }
    results.push(result);
  }

  return results;
}

/**
 * Augment `ask` output matches: for each match that has relations containing
 * cross-vault refs, attempt to resolve them and attach the target node's
 * title/summary inline. Returns a copy of the matches array with
 * `cross_vault_resolved` added where applicable.
 *
 * This is non-throwing — resolution failures are noted but never surface as errors.
 */
export function augmentMatchesWithXRefResolutions(
  matches: any[],
  worldDir?: string,
  ctx?: XRefResolutionContext
): any[] {
  if (!matches || matches.length === 0) return matches;
  const resolvedWorldDir = worldDir ?? process.env.GRAPHRAG_WORLD_DIR;
  if (!resolvedWorldDir) return matches;
  // command スコープ context (issue #32): match × relation の同一 ref 解決を dedup し、
  // 呼び出し間 (brief / evidence) でも共有できる。省略時は単発 (従来どおり)。
  const context = ctx ?? createXRefResolutionContext();

  return matches.map((match: any) => {
    if (!match) return match;
    // Collect cross-vault edges from the match's node id relations
    // The match structure from brief/evidence includes node and optionally relations
    const relations: any[] = match.relations ?? match.node?.relations ?? [];
    const xrefs: any[] = [];
    for (const rel of relations) {
      const to = rel?.to ?? rel?.target;
      if (typeof to === "string" && to.startsWith("vault:")) {
        const node = resolveCrossVaultRef(to, resolvedWorldDir, context);
        // brief の relations は edge 型を `relation` に載せる (stub 形:
        // {relation, direction, to})。素の edge 形 ({type, to}) も受ける。
        xrefs.push({ ref: to, edge_type: rel?.relation ?? rel?.type ?? null, resolved: node ?? null });
      }
    }
    if (xrefs.length === 0) return match;
    return { ...match, cross_vault_resolved: xrefs };
  });
}

// ---------------------------------------------------------------------------
// Vault parentage (structural containment between vaults)
// ---------------------------------------------------------------------------

/**
 * Status of a vault's `parent` declaration.
 *   none           — vault declares no parent (it is a root)
 *   resolved       — parent found, same schema, no cycle: a valid containment edge
 *   orphan         — parent slug declared but no vault with that slug found in world
 *   unresolvable   — GRAPHRAG_WORLD_DIR not configured; can't resolve the parent
 *   self           — parent points to the declaring vault itself
 *   schema-mismatch — parent schema differs from child schema (parent must be same schema)
 *   cycle          — the parent chain loops (A → B → A …)
 */
export type VaultParentStatus =
  | "none"
  | "resolved"
  | "orphan"
  | "unresolvable"
  | "self"
  | "schema-mismatch"
  | "cycle";

export interface VaultParentCheckResult {
  /** Absolute path to the vault directory being checked */
  vault_dir: string;
  /** The `parent` vault_slug declared in this vault's VAULT.md (null if none) */
  parent_slug: string | null;
  status: VaultParentStatus;
  /** Human-readable explanation for non-resolved statuses */
  detail?: string;
  /** Populated when status === "resolved" / "schema-mismatch" / "cycle" (parent vault was located) */
  resolved?: { vault_path: string; slug: string; schema: string | null };
  /** Populated when the parent slug matched via a vault_slug_alias instead of the current slug */
  alias_warning?: string;
}

/** Read the `parent` slug declared in the VAULT.md beside a resolved vault dir. */
function readParentSlugForDir(vaultDir: string): string | null {
  const profilePath = path.join(path.dirname(path.resolve(vaultDir)), "VAULT.md");
  if (!existsSync(profilePath)) return null;
  try {
    return parseVaultParent(readFileSync(profilePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read the effective schema id for a vault dir (from its VAULT.md `schema`
 * field, defaulting to the system preset). This is the vault's real "kind":
 * a system vault resolves to "system", a project vault to "project".
 */
function readSchemaIdForDir(vaultDir: string): string | null {
  try {
    return resolveSchema(vaultDir).id;
  } catch {
    return null;
  }
}

/**
 * Walk up the parent chain starting from `firstParentDir`, treating `childDir`
 * as already visited. Returns a detail string if a loop is detected, else null.
 * A missing VAULT.md, a root (no parent), or an unresolvable upstream parent all
 * terminate the walk cleanly (those are reported by checkVaultParent on their own
 * vault, not folded into this vault's cycle status).
 */
function detectParentCycle(childDir: string, firstParentDir: string, worldDir: string): string | null {
  const MAX_DEPTH = 64;
  const visited = new Set<string>([path.resolve(childDir)]);
  let currentDir = path.resolve(firstParentDir);
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (visited.has(currentDir)) {
      return `parent chain loops back to ${currentDir}`;
    }
    visited.add(currentDir);
    const nextSlug = readParentSlugForDir(currentDir);
    if (!nextSlug) return null; // reached a root
    const found = findVaultBySlugWithInfo(nextSlug, worldDir);
    if (!found) return null; // upstream orphan — not this vault's cycle to report
    currentDir = path.resolve(found.vaultDir);
  }
  return `parent chain exceeds ${MAX_DEPTH} levels (possible cycle)`;
}

/**
 * Validate the `parent` declaration of a single vault.
 *
 * Enforces the strict containment rules:
 *   - single parent (scalar `parent` field; lists are ignored by the parser)
 *   - same schema (a project's parent is a project; a system's parent is a system)
 *   - resolvable (parent slug must name a real vault in the world)
 *   - no self-reference, no cycles
 *
 * Read-only. `parent` is an organizational pointer with NO lifecycle cascade —
 * this check never archives or mutates anything.
 */
export function checkVaultParent(vaultDir: string, worldDir?: string): VaultParentCheckResult {
  const resolvedVaultDir = path.resolve(vaultDir);
  const profilePath = path.join(path.dirname(resolvedVaultDir), "VAULT.md");
  if (!existsSync(profilePath)) {
    return { vault_dir: resolvedVaultDir, parent_slug: null, status: "none", detail: "VAULT.md not found beside vault dir" };
  }

  let content: string;
  try {
    content = readFileSync(profilePath, "utf8");
  } catch (err) {
    return { vault_dir: resolvedVaultDir, parent_slug: null, status: "none", detail: `VAULT.md unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parentSlug = parseVaultParent(content);
  if (!parentSlug) {
    return { vault_dir: resolvedVaultDir, parent_slug: null, status: "none" };
  }

  const childSchema = readSchemaIdForDir(resolvedVaultDir);
  const ownSlug = parseVaultSlug(content);
  const ownAliases = parseVaultSlugAliases(content);

  // Self-reference by slug — catchable before touching the world.
  if (parentSlug === ownSlug || ownAliases.includes(parentSlug)) {
    return {
      vault_dir: resolvedVaultDir,
      parent_slug: parentSlug,
      status: "self",
      detail: `parent '${parentSlug}' refers to this vault itself`
    };
  }

  const resolvedWorldDir = worldDir ?? process.env.GRAPHRAG_WORLD_DIR;
  if (!resolvedWorldDir) {
    return {
      vault_dir: resolvedVaultDir,
      parent_slug: parentSlug,
      status: "unresolvable",
      detail: "GRAPHRAG_WORLD_DIR not set; cannot resolve parent vault"
    };
  }

  const found = findVaultBySlugWithInfo(parentSlug, resolvedWorldDir);
  if (!found) {
    return {
      vault_dir: resolvedVaultDir,
      parent_slug: parentSlug,
      status: "orphan",
      detail: `no vault with vault_slug '${parentSlug}' found in ${resolvedWorldDir}`
    };
  }

  // Self-reference by resolved directory (slug differs but points back here).
  if (path.resolve(found.vaultDir) === resolvedVaultDir) {
    return {
      vault_dir: resolvedVaultDir,
      parent_slug: parentSlug,
      status: "self",
      detail: `parent '${parentSlug}' resolves to this vault itself`
    };
  }

  const parentSchema = readSchemaIdForDir(found.vaultDir);
  const aliasWarning = found.matchedViaAlias
    ? `parent ref uses alias '${parentSlug}', current slug is '${found.currentSlug}' — update parent to use current slug`
    : undefined;
  const resolved = { vault_path: found.vaultDir, slug: found.currentSlug, schema: parentSchema };

  if (childSchema && parentSchema && childSchema !== parentSchema) {
    return {
      vault_dir: resolvedVaultDir,
      parent_slug: parentSlug,
      status: "schema-mismatch",
      detail: `child schema '${childSchema}' != parent schema '${parentSchema}'; parent must use the same schema`,
      resolved,
      ...(aliasWarning ? { alias_warning: aliasWarning } : {})
    };
  }

  const cycle = detectParentCycle(resolvedVaultDir, found.vaultDir, resolvedWorldDir);
  if (cycle) {
    return {
      vault_dir: resolvedVaultDir,
      parent_slug: parentSlug,
      status: "cycle",
      detail: cycle,
      resolved,
      ...(aliasWarning ? { alias_warning: aliasWarning } : {})
    };
  }

  return {
    vault_dir: resolvedVaultDir,
    parent_slug: parentSlug,
    status: "resolved",
    resolved,
    ...(aliasWarning ? { alias_warning: aliasWarning } : {})
  };
}

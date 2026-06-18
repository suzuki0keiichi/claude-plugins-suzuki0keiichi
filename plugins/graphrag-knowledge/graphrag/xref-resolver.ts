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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrossVaultRefParts {
  /** vault_slug of the target vault (e.g. "fms") */
  vaultSlug: string;
  /** local node id within the target vault (e.g. "deliverable:fms:v2-release") */
  nodeId: string;
}

export interface ResolvedNode {
  /** The cross-vault ref string that was resolved (e.g. "vault:fms/deliverable:fms:v2-release") */
  ref: string;
  /** vault_path: absolute path to the vault directory where this node was found */
  vault_path: string;
  /** node id within that vault */
  node_id: string;
  type: string | null;
  title: string | null;
  summary: string | null;
}

export type XRefStatus = "resolved" | "broken" | "orphan" | "unresolvable";

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
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a cross-vault ref of the form `vault:<slug>/<nodeId>`.
 * Returns null if the string is not a cross-vault ref.
 *
 * Examples:
 *   "vault:fms/deliverable:fms:v2-release"
 *     → { vaultSlug: "fms", nodeId: "deliverable:fms:v2-release" }
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

/**
 * Walk GRAPHRAG_WORLD_DIR looking for a vault whose VAULT.md declares
 * `vault_slug: <slug>` (or lists `<slug>` in `vault_slug_aliases`).
 * Returns a FindVaultResult or null.
 *
 * Resolution order:
 *   1. Exact match on vault_slug — matchedViaAlias: false
 *   2. Match in vault_slug_aliases — matchedViaAlias: true
 *
 * The world dir layout expected: each entry in world.json points to a vault
 * directory. We walk the world dir tree shallowly — specifically, for each
 * sub-directory of worldDir we look for a `vault/` child and check the sibling
 * VAULT.md. This matches the canonical layout:
 *
 *   <worldDir>/
 *     <repoName>/
 *       VAULT.md          ← vault_slug is here
 *       vault/            ← this is vaultDir
 *
 * We also accept a flat layout where vaultDir *is* a direct child of worldDir.
 * In practice, GRAPHRAG_WORLD_DIR could be:
 *   (a) the directory containing world.json — scan its sub-dirs for vault/ children
 *   (b) a parent of multiple repo dirs
 *
 * Rather than parsing world.json (which could point to absolute paths anywhere),
 * we scan all direct child directories of worldDir. For each child we check:
 *   1. child/vault/ exists → vaultDir = child/vault
 *   2. child/ is itself a vault dir (has .md files) → vaultDir = child
 * Then we look up vault_slug for that vaultDir.
 *
 * This heuristic covers the common case. If a vault is not in worldDir's
 * direct children, it won't be found (return null).
 */
export function findVaultBySlugWithInfo(slug: string, worldDir: string): FindVaultResult | null {
  if (!existsSync(worldDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(worldDir);
  } catch {
    return null;
  }
  // Two-pass: first pass collects alias candidates to prefer primary slug matches.
  const aliasMatches: FindVaultResult[] = [];
  for (const entry of entries) {
    const entryAbs = path.join(worldDir, entry);

    // Try canonical layout: child/vault/ is the vault dir
    const canonicalVault = path.join(entryAbs, "vault");
    if (existsSync(canonicalVault)) {
      const info = readVaultSlugInfoForDir(canonicalVault);
      if (info) {
        if (info.slug === slug) {
          return { vaultDir: path.resolve(canonicalVault), currentSlug: info.slug, matchedViaAlias: false };
        }
        if (info.aliases.includes(slug)) {
          aliasMatches.push({ vaultDir: path.resolve(canonicalVault), currentSlug: info.slug, matchedViaAlias: true });
        }
      }
      continue;
    }

    // Try flat layout: child/ is itself the vault dir
    try {
      if (statSync(entryAbs).isDirectory()) {
        const info = readVaultSlugInfoForDir(entryAbs);
        if (info) {
          if (info.slug === slug) {
            return { vaultDir: path.resolve(entryAbs), currentSlug: info.slug, matchedViaAlias: false };
          }
          if (info.aliases.includes(slug)) {
            aliasMatches.push({ vaultDir: path.resolve(entryAbs), currentSlug: info.slug, matchedViaAlias: true });
          }
        }
      }
    } catch {
      // ignore non-accessible entries
    }
  }
  return aliasMatches.length > 0 ? aliasMatches[0] : null;
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
 * @param ref       Full cross-vault ref string, e.g. "vault:fms/deliverable:fms:v2"
 * @param worldDir  Directory to scan for sibling vaults. Falls back to
 *                  process.env.GRAPHRAG_WORLD_DIR when not provided.
 * @returns ResolvedNode when found, null otherwise.
 */
export function resolveCrossVaultRef(ref: string, worldDir?: string): ResolvedNode | null {
  const parts = parseCrossVaultRef(ref);
  if (!parts) return null;

  const resolvedWorldDir = worldDir ?? process.env.GRAPHRAG_WORLD_DIR;
  if (!resolvedWorldDir) return null;

  const findResult = findVaultBySlugWithInfo(parts.vaultSlug, resolvedWorldDir);
  if (!findResult) return null;

  // Read the vault and find the node with matching id
  let graph: { nodes?: any[]; edges?: any[] };
  try {
    graph = importVault(findResult.vaultDir);
  } catch {
    return null;
  }

  const node = (graph.nodes ?? []).find((n: any) => n.id === parts.nodeId);
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
  worldDir?: string
): XRefCheckResult[] {
  const resolvedWorldDir = worldDir ?? process.env.GRAPHRAG_WORLD_DIR;

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

    const findResult = findVaultBySlugWithInfo(parts.vaultSlug, resolvedWorldDir);
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

    // Vault exists — check if the node is there
    let graph2: { nodes?: any[]; edges?: any[] };
    try {
      graph2 = importVault(vaultDir);
    } catch (err) {
      results.push({
        ref,
        edge_id: edgeId,
        status: "orphan",
        detail: `vault at ${vaultDir} could not be read: ${err instanceof Error ? err.message : String(err)}`
      });
      continue;
    }

    const node = (graph2.nodes ?? []).find((n: any) => n.id === parts.nodeId);
    if (!node) {
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
  worldDir?: string
): any[] {
  if (!matches || matches.length === 0) return matches;
  const resolvedWorldDir = worldDir ?? process.env.GRAPHRAG_WORLD_DIR;
  if (!resolvedWorldDir) return matches;

  return matches.map((match: any) => {
    if (!match) return match;
    // Collect cross-vault edges from the match's node id relations
    // The match structure from brief/evidence includes node and optionally relations
    const relations: any[] = match.relations ?? match.node?.relations ?? [];
    const xrefs: any[] = [];
    for (const rel of relations) {
      const to = rel?.to ?? rel?.target;
      if (typeof to === "string" && to.startsWith("vault:")) {
        const node = resolveCrossVaultRef(to, resolvedWorldDir);
        xrefs.push({ ref: to, edge_type: rel?.type ?? null, resolved: node ?? null });
      }
    }
    if (xrefs.length === 0) return match;
    return { ...match, cross_vault_resolved: xrefs };
  });
}

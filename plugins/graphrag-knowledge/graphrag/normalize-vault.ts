/**
 * normalize-vault: vault 全体を現行 canonical 型名・ID prefix に一括正規化する。
 *
 * NODE_TYPE_ALIASES にエイリアスがある限り、旧 canonical のノード型・ID prefix・
 * vault フォルダ名を新 canonical に書き換える汎用ツール。
 *
 * 動作:
 *   1. vault を import (importVault) して全ノード・エッジを読む
 *   2. 各ノードの type を canonicalType() で正規化
 *   3. 各ノード・エッジの id/from/to を canonical prefix に正規化
 *   4. buildVaultFiles → writeVaultDelta で vault を上書き
 *   5. (git 有効時) git commit
 *
 * 冪等: 既に全て canonical なら diff ゼロ・コミットなし。
 *
 * 使い方:
 *   node --experimental-strip-types graphrag/normalize-vault.ts --vault <dir>
 *   node --experimental-strip-types graphrag/normalize-vault.ts --vault <dir> --dry-run
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { importVault } from "./import-vault.ts";
import { writeVaultDelta, gitCommitVault } from "./mutate-vault.ts";
import { canonicalType, NODE_TYPE_ALIASES, type SchemaDefinition } from "./schema.ts";

// NODE_TYPE_ALIASES から ID prefix の正規化マップを導出。
// alias の小文字 → canonical の小文字。
function buildIdPrefixMap(aliases: Record<string, string>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [alias, canonical] of Object.entries(aliases)) {
    map[alias.toLowerCase()] = canonical.toLowerCase();
  }
  return map;
}

function canonicalizeId(id: string, prefixMap: Record<string, string>): string {
  const idx = id.indexOf(":");
  if (idx < 0) return id;
  const seg = id.slice(0, idx);
  const canon = prefixMap[seg];
  return canon ? canon + id.slice(idx) : id;
}

export interface NormalizeResult {
  nodesRetyped: number;
  idsRewritten: number;
  filesWritten: number;
  filesRemoved: number;
  head: string | null;
}

export function normalizeVault(
  vaultDir: string,
  opts: { dryRun?: boolean; git?: boolean; schema?: SchemaDefinition } = {}
): NormalizeResult {
  const vaultAbs = path.resolve(vaultDir);
  if (!existsSync(vaultAbs)) throw new Error(`vault not found: ${vaultAbs}`);

  const aliases = opts.schema?.aliases ?? NODE_TYPE_ALIASES;
  const prefixMap = buildIdPrefixMap(aliases);

  const graph = importVault(vaultAbs);
  let nodesRetyped = 0;
  let idsRewritten = 0;

  // 1. ノード型の正規化
  for (const node of graph.nodes ?? []) {
    const canon = canonicalType(node.type, opts.schema);
    if (canon && canon !== node.type) {
      node.type = canon;
      nodesRetyped++;
    }
    // 2. ノード ID の正規化
    const canonId = canonicalizeId(node.id, prefixMap);
    if (canonId !== node.id) {
      const oldId = node.id;
      node.id = canonId;
      idsRewritten++;
      // エッジの from/to も連動
      for (const edge of graph.edges ?? []) {
        if (edge.from === oldId) edge.from = canonId;
        if (edge.to === oldId) edge.to = canonId;
      }
    }
  }

  // 3. エッジ ID 中の旧 prefix も正規化 (edge id は from/to を含む命名規約)
  for (const edge of graph.edges ?? []) {
    // edge.from/to が既に正規化済みなので、edge.id を再構築
    const canonEdgeId = canonicalizeId(edge.id, prefixMap);
    if (canonEdgeId !== edge.id) {
      edge.id = canonEdgeId;
    }
    // edge id に含まれる from/to のスナップショットも正規化
    // edge id 形式: `<norm(from)>__<type>__<norm(to)>` (cli-typed-add.ts の edgeId)
    // prefix が含まれうるので全セグメントを走査
    const newId = edge.id.replace(/(?<=^|__)([a-z]+)(?=_)/g, (seg: string) => {
      return prefixMap[seg] ?? seg;
    });
    if (newId !== edge.id) edge.id = newId;
  }

  if (opts.dryRun) {
    return { nodesRetyped, idsRewritten, filesWritten: 0, filesRemoved: 0, head: null };
  }

  // 4. vault に書き出し
  const delta = writeVaultDelta(vaultAbs, graph);

  // 5. git commit (変更があれば)。commit ロジックは mutate-vault.gitCommitVault に
  // 一本化 (vault-only staged なら mid-merge でも通る pathspec 無し commit、foreign
  // staged が混じる時だけ pathspec 付き commit → mid-merge なら actionable error)。
  // normalize-vault は git 不在環境でも動く best-effort ツールなので、ここでの失敗
  // (actionable error 含む) は従来どおり黙って握り潰し、ファイル書き出しの成功だけ返す。
  let head: string | null = null;
  if (opts.git !== false && (delta.written.length > 0 || delta.removed.length > 0)) {
    try {
      head = gitCommitVault(vaultAbs, "graphrag: normalize vault types/ids to canonical");
    } catch {
      // git が使えない環境・mid-merge 等でもファイル書き出しは成功している
    }
  }

  return {
    nodesRetyped,
    idsRewritten,
    filesWritten: delta.written.length,
    filesRemoved: delta.removed.length,
    head
  };
}

function parseArgs(argv: string[]) {
  const p: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) { p[k] = v; i++; } else p[k] = true;
  }
  return {
    vault: typeof p.vault === "string" ? p.vault : process.env.GRAPHRAG_VAULT_DIR,
    dryRun: Boolean(p["dry-run"]),
    noGit: Boolean(p["no-git"]),
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  if (!args.vault) {
    console.error("Usage: normalize-vault --vault <dir> [--dry-run] [--no-git]");
    console.error("Normalizes all node types and id prefixes in the vault to canonical form.");
    process.exit(1);
  }
  const result = normalizeVault(args.vault, {
    dryRun: args.dryRun,
    git: !args.noGit,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.nodesRetyped === 0 && result.idsRewritten === 0) {
    console.log("Already normalized — nothing to do.");
  }
}

if (process.argv[1] && process.argv[1].endsWith("normalize-vault.ts")) {
  main();
}

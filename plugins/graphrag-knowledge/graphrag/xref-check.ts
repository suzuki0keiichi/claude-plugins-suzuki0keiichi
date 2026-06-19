/**
 * xref-check: diagnostic CLI verb for cross-vault references.
 *
 * Scans all edges in the current vault for `vault:` prefixed `to` fields,
 * attempts to resolve each one via xref-resolver, and reports:
 *   resolved   — vault found, node found
 *   broken     — vault found but node missing
 *   orphan     — no vault with the given slug found
 *   unresolvable — GRAPHRAG_WORLD_DIR not configured
 *
 * Read-only. Never mutates any vault.
 *
 * Usage:
 *   node --experimental-strip-types graphrag/cli.ts xref-check [--vault <dir>] [--world <dir>]
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { importVault } from "./import-vault.ts";
import { checkCrossVaultRefs } from "./xref-resolver.ts";
import { resolveWorldDir } from "./world.ts";

export async function runXRefCheck(argv: string[]): Promise<void> {
  // Simple flag parsing (no dependency on cli-headlines parseFlagsArgv to keep this minimal)
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    if (eq >= 0) {
      flags[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[tok.slice(2)] = next;
        i++;
      } else {
        flags[tok.slice(2)] = true;
      }
    }
  }

  const vaultDir =
    (typeof flags.vault === "string" ? flags.vault : undefined) ??
    process.env.GRAPHRAG_VAULT_DIR;

  if (!vaultDir) {
    throw new Error(
      "xref-check requires a vault: pass --vault <dir> or set GRAPHRAG_VAULT_DIR"
    );
  }

  const worldDir = resolveWorldDir(
    typeof flags.world === "string" ? flags.world : undefined
  );

  const resolvedVaultDir = path.resolve(vaultDir);

  let graph: { nodes?: any[]; edges?: any[] };
  try {
    graph = importVault(resolvedVaultDir);
  } catch (err) {
    throw new Error(
      `xref-check: failed to read vault at ${resolvedVaultDir}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const results = checkCrossVaultRefs(graph, worldDir);

  const resolved = results.filter((r) => r.status === "resolved");
  const broken = results.filter((r) => r.status === "broken");
  const orphan = results.filter((r) => r.status === "orphan");
  const unresolvable = results.filter((r) => r.status === "unresolvable");

  const output = {
    vault: resolvedVaultDir,
    world_dir: worldDir ?? null,
    summary: {
      total_cross_vault_edges: results.length,
      resolved: resolved.length,
      broken: broken.length,
      orphan: orphan.length,
      unresolvable: unresolvable.length
    },
    results
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function isMainModule(url: string): boolean {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
if (isMainModule(import.meta.url)) {
  await runXRefCheck(process.argv.slice(2));
}

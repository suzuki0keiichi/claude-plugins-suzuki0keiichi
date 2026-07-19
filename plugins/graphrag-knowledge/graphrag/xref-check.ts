/**
 * xref-check: diagnostic CLI verb for reference integrity.
 *
 * Scans all edges in the current vault for `vault:` prefixed `to` fields,
 * attempts to resolve each one via xref-resolver, and reports:
 *   resolved   — vault found, node found
 *   tombstoned — node missing but the target vault's deletion ledger knows it
 *                (301 when a successor exists, 410 when gone; see result.tombstone)
 *   broken     — vault found but node missing (and no tombstone)
 *   orphan     — no vault with the given slug found
 *   unresolvable — GRAPHRAG_WORLD_DIR not configured
 *
 * With `--root <repo>`, additionally sweeps the repo's `graphrag:see` /
 * `graphrag:enforces` comment markers (code → graph references) and verifies
 * each target is alive (broken / tombstoned 301 / superseded — markers.ts).
 * Same reference-rot check, opposite direction: vault-side refs above,
 * code-side refs here. The diff-scoped variant of the same sweep lives in
 * delta-check (the write-moment path); this is the periodic full sweep.
 *
 * Read-only. Never mutates any vault.
 *
 * Usage:
 *   node --experimental-strip-types graphrag/cli.ts xref-check [--vault <dir>] [--world <dir>] [--root <repo>]
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { importVault } from "./import-vault.ts";
import { checkCrossVaultRefs, checkVaultParent } from "./xref-resolver.ts";
import { resolveWorldDir } from "./world.ts";
import { grepMarkersInRepo, verifyMarkerRefs, type MarkerRefFinding } from "./markers.ts";

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
  const tombstoned = results.filter((r) => r.status === "tombstoned");
  const orphan = results.filter((r) => r.status === "orphan");
  const unresolvable = results.filter((r) => r.status === "unresolvable");

  // Structural parent (containment) check — independent of node edges.
  const parent = checkVaultParent(resolvedVaultDir, worldDir);
  const parentOk = parent.status === "none" || parent.status === "resolved";

  // Optional code-side sweep: repo-wide graphrag:see / graphrag:enforces markers.
  // Failure of the sweep (no git, not a repo) is reported, never fatal — the
  // vault-side check above still stands on its own.
  const rootFlag = typeof flags.root === "string" ? path.resolve(flags.root) : null;
  let codeMarkers:
    | { root: string; markers_scanned: number; findings: MarkerRefFinding[]; error?: string }
    | undefined;
  if (rootFlag) {
    try {
      const hits = grepMarkersInRepo(rootFlag);
      codeMarkers = {
        root: rootFlag,
        markers_scanned: hits.length,
        findings: verifyMarkerRefs(hits, graph, resolvedVaultDir)
      };
    } catch (err) {
      codeMarkers = {
        root: rootFlag,
        markers_scanned: 0,
        findings: [],
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  const output = {
    vault: resolvedVaultDir,
    world_dir: worldDir ?? null,
    summary: {
      total_cross_vault_edges: results.length,
      resolved: resolved.length,
      broken: broken.length,
      // 台帳に載っている削除済み参照 (issue #18)。final_successor があれば 301 (後継へ
      // 張り替え可能)、無ければ 410 (参照ごと削除するしかない)。各 result の
      // tombstone フィールドに修復材料 (chain / successor_alive) が入る。
      tombstoned: tombstoned.length,
      tombstoned_with_successor: tombstoned.filter((r) => r.tombstone?.final_successor).length,
      orphan: orphan.length,
      unresolvable: unresolvable.length,
      parent_status: parent.status,
      parent_ok: parentOk,
      ...(codeMarkers ? { code_marker_findings: codeMarkers.findings.length } : {})
    },
    parent,
    ...(codeMarkers ? { code_markers: codeMarkers } : {}),
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

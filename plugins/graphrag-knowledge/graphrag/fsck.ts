/**
 * fsck: vault の read-only 整合性検査 (silent knowledge corruption の検知計器)。
 *
 * vault (Obsidian Markdown, frontmatter 正本) を read path (importVault) と同じ歩き方で
 * 読み、破損 (torn write / 手編集事故 / パーサ非互換) と漂流 (非 canonical 直列化) を
 * 区別して単一 JSON で報告する。一切書かない。
 *
 * checks (stable id):
 *   - import-parse          : 全 .md が frontmatter からパースできる (失敗件数 + ファイル一覧)
 *   - duplicate-node-ids    : 同一 node id を複数ファイルが保持していない
 *   - id-path-consistency   : node id/type ↔ 型ディレクトリ/ファイル名の一致
 *                             (型 dir 不一致 = error / basename のみ不一致 = warn)
 *   - edge-endpoints        : 全エッジ端点が実在ノードに解決する (`vault:` 参照は形のみ検査)
 *   - schema-validate       : validateGraph (schema レベル) が通る
 *   - round-trip            : import → 再構築 → ディスクと byte 比較。差分 = 非 canonical
 *                             直列化 (WARN — 破損ではなく、次の書き込みが書き直す漂流)
 *   - tombstones            : 削除台帳 (.tombstones/*.jsonl) がパースできる (不能行 = ERROR)。
 *                             台帳掲載 id の生存 (蘇生) は advisory WARN
 *   - git-uncommitted       : vault 配下の未 commit 変更 (torn write の兆候) = ERROR + 復旧ヒント
 *
 * exit code: ok/warn → 0, error → 1。
 *
 * Usage:
 *   node --experimental-strip-types graphrag/cli.ts fsck [--vault <dir>]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { importVaultFile, normalizeEol } from "./import-vault.ts";
import { buildVaultFiles } from "./build-vault.ts";
import { validateGraph, type SchemaDefinition } from "./schema.ts";
import { resolveSchema } from "./schema-registry.ts";
import { readTombstones } from "./tombstones.ts";
import { parseCrossVaultRef } from "./xref-resolver.ts";

export type FsckStatus = "ok" | "warn" | "error";

export interface FsckCheck {
  id: string;
  status: FsckStatus;
  detail?: unknown;
  hint?: string;
}

export interface FsckReport {
  generated_by: "graphrag/fsck.ts";
  vault: string;
  status: FsckStatus;
  checks: FsckCheck[];
  counts: {
    files: number;
    nodes: number;
    edges: number;
    errors: number;
    warnings: number;
  };
}

export interface FsckDeps {
  /** vault 配下限定の `git status --porcelain` (git 不在/非 repo なら throw)。テスト DI 用。 */
  gitStatusPorcelain?: (vaultDir: string) => string;
}

function defaultGitStatusPorcelain(vaultDir: string): string {
  return execFileSync("git", ["status", "--porcelain", "--", "."], {
    cwd: vaultDir,
    encoding: "utf8",
  });
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

/**
 * importVault と同一の歩き方 (dot ディレクトリも含む全再帰 + ソート)。実際の read path が
 * 読むものを正確に検査対象にする — writeVaultDelta の管理対象 (dot dir 除外) より広いのは
 * 意図的で、「import は読むのに write が管理しない」ファイル (例: .obsidian 下に置かれた
 * frontmatter 付き .md) も round-trip 検査で表面化させるため。
 */
function listVaultMdFiles(vaultDir: string): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const abs = path.join(d, entry);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (entry.endsWith(".md")) files.push(abs);
    }
  };
  walk(vaultDir);
  files.sort();
  return files;
}

export function fsckVault(options: {
  vaultDir: string;
  schema?: SchemaDefinition;
  deps?: FsckDeps;
}): FsckReport {
  const vaultDir = path.resolve(options.vaultDir);
  const deps = options.deps ?? {};
  const checks: FsckCheck[] = [];

  // ── 1. import-parse: 全 .md がパースできる (read path 忠実) ────────────────
  const files = listVaultMdFiles(vaultDir);
  const parseFailures: { file: string; error: string }[] = [];
  const nodes: any[] = [];
  const nodeFiles: string[] = []; // nodes[i] を保持するファイル (relPath, POSIX)
  const contentsByRel = new Map<string, string>();
  const edges: any[] = [];
  const seenEdgeIds = new Set<string>();
  const filesByNodeId = new Map<string, string[]>();
  for (const abs of files) {
    const rel = toPosix(path.relative(vaultDir, abs));
    try {
      const content = readFileSync(abs, "utf8");
      contentsByRel.set(rel, content);
      const { node, edges: fileEdges } = importVaultFile(content);
      nodes.push(node);
      nodeFiles.push(rel);
      if (typeof node.id === "string") {
        if (!filesByNodeId.has(node.id)) filesByNodeId.set(node.id, []);
        filesByNodeId.get(node.id)!.push(rel);
      }
      // importVault と同じエッジ重複排除 (同一エッジ id は初出のみ)。
      for (const e of fileEdges) {
        const id = typeof e.id === "string" ? e.id : JSON.stringify(e);
        if (seenEdgeIds.has(id)) continue;
        seenEdgeIds.add(id);
        edges.push(e);
      }
    } catch (e: any) {
      parseFailures.push({ file: rel, error: String(e?.message ?? e) });
    }
  }
  checks.push({
    id: "import-parse",
    status: parseFailures.length > 0 ? "error" : "ok",
    detail: { md_files: files.length, failed: parseFailures.length, failures: parseFailures },
    ...(parseFailures.length > 0
      ? {
          hint:
            "importVault cannot read these files, so every read and every mutation of this vault will " +
            "fail until they are repaired or removed (restore them from git history: " +
            "`git -C <vault> checkout HEAD -- <file>`).",
        }
      : {}),
  });

  // ── 2. duplicate-node-ids ────────────────────────────────────────────────
  const duplicateIds = [...filesByNodeId.entries()]
    .filter(([, fs]) => fs.length > 1)
    .map(([id, fs]) => ({ id, files: fs }));
  checks.push({
    id: "duplicate-node-ids",
    status: duplicateIds.length > 0 ? "error" : "ok",
    detail: { duplicates: duplicateIds },
    ...(duplicateIds.length > 0
      ? {
          hint:
            "two or more files claim the same node id; imports produce duplicate nodes and mutations are " +
            "refused. Keep the canonical file (Type dir + title slug) and delete the stray copy.",
        }
      : {}),
  });

  // ── 3. id-path-consistency + 6. round-trip ───────────────────────────────
  // buildVaultFiles は graph.nodes を順に 1 ノード 1 ファイルで出力するので、
  // nodes[i] ↔ generated[i] が index 整合する (canonical パス/内容の期待値)。
  const generated = buildVaultFiles({ nodes, edges });
  const pathMismatches: { node_id: unknown; actual: string; expected: string; severity: "error" | "warn" }[] = [];
  const nonCanonical: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const actualRel = nodeFiles[i];
    const expected = generated[i];
    if (actualRel !== expected.relPath) {
      const actualDir = actualRel.split("/")[0];
      const expectedDir = expected.relPath.split("/")[0];
      pathMismatches.push({
        node_id: nodes[i].id,
        actual: actualRel,
        expected: expected.relPath,
        // 型 dir 不一致はノード type とファイル位置の矛盾 (手移動 or frontmatter type の
        // 書き換え事故) = error。basename だけの不一致は次の書き込みが rename で直す漂流 = warn。
        severity: actualDir !== expectedDir ? "error" : "warn",
      });
      continue;
    }
    // canonical パスにあるファイルだけ内容比較 (EOL 差は write path 同様に無視)。
    const onDisk = contentsByRel.get(actualRel);
    if (onDisk !== undefined && normalizeEol(onDisk) !== normalizeEol(expected.content)) {
      nonCanonical.push(actualRel);
    }
  }
  checks.push({
    id: "id-path-consistency",
    status: pathMismatches.some((m) => m.severity === "error")
      ? "error"
      : pathMismatches.length > 0
        ? "warn"
        : "ok",
    detail: { mismatches: pathMismatches },
    ...(pathMismatches.length > 0
      ? {
          hint:
            "file locations disagree with the canonical node type/title mapping. A type-dir mismatch (error) " +
            "means the file's folder contradicts its frontmatter type; a basename mismatch (warn) is drift the " +
            "next write of the node will rename away.",
        }
      : {}),
  });

  // ── 4. edge-endpoints (`vault:` 参照は形のみ — 実在解決は xref-check の仕事) ──
  const nodeIds = new Set(nodes.map((n) => n.id).filter((id) => typeof id === "string"));
  const endpointProblems: { edge_id: unknown; endpoint: "from" | "to"; ref: unknown; problem: string }[] = [];
  for (const e of edges) {
    if (typeof e.from !== "string" || !nodeIds.has(e.from)) {
      endpointProblems.push({ edge_id: e.id, endpoint: "from", ref: e.from, problem: "missing node" });
    }
    if (typeof e.to === "string" && e.to.startsWith("vault:")) {
      if (!parseCrossVaultRef(e.to)) {
        endpointProblems.push({
          edge_id: e.id,
          endpoint: "to",
          ref: e.to,
          problem: "malformed cross-vault ref (expected vault:<slug>/<nodeId>)",
        });
      }
    } else if (typeof e.to !== "string" || !nodeIds.has(e.to)) {
      endpointProblems.push({ edge_id: e.id, endpoint: "to", ref: e.to, problem: "missing node" });
    }
  }
  checks.push({
    id: "edge-endpoints",
    status: endpointProblems.length > 0 ? "error" : "ok",
    detail: { problems: endpointProblems },
    ...(endpointProblems.length > 0
      ? {
          hint:
            "dangling edges point at nodes that no longer exist (or malformed vault: refs). Delete the edge " +
            "or restore the missing node via commit-mutation. Cross-vault ref resolution: `xref-check`.",
        }
      : {}),
  });

  // ── 5. schema-validate ───────────────────────────────────────────────────
  const schemaFailures = validateGraph({ nodes, edges }, options.schema);
  checks.push({
    id: "schema-validate",
    status: schemaFailures.length > 0 ? "error" : "ok",
    detail: { failures: schemaFailures },
  });

  // ── 6. round-trip (非 canonical 直列化 = WARN — 漂流であって破損ではない) ────
  checks.push({
    id: "round-trip",
    status: nonCanonical.length > 0 ? "warn" : "ok",
    detail: { non_canonical: nonCanonical },
    ...(nonCanonical.length > 0
      ? {
          hint:
            "these files parse fine but differ from the canonical serialization (hand edits or a legacy " +
            "format). Not corruption: the next write of each node rewrites it canonically.",
        }
      : {}),
  });

  // ── 7. tombstones (削除台帳の整合 — issue #18) ────────────────────────────
  // parse 不能行・必須フィールド欠落は error (台帳が読めないと 301 解決が黙って
  // 素通りする)。台帳に載っている id の生存は error にしない — 同一内容の復活
  // (content-hash 採番では正しい蘇生) がありうるため、advisory の warn に留める。
  {
    const tombs = readTombstones(vaultDir);
    const liveIds = new Set(nodes.map((n: any) => n.id));
    const resurrected = [...new Set(tombs.entries.filter((e) => liveIds.has(e.id)).map((e) => e.id))];
    checks.push({
      id: "tombstones",
      status: tombs.errors.length > 0 ? "error" : resurrected.length > 0 ? "warn" : "ok",
      detail: { entries: tombs.entries.length, parse_errors: tombs.errors, resurrected },
      ...(tombs.errors.length > 0
        ? {
            hint:
              "tombstone ledger lines that cannot be parsed make deleted-node lookups (xref-check 301 " +
              "resolution) silently incomplete. If the offending lines are git conflict markers " +
              "(<<<<<<< etc.), resolve by KEEPING BOTH SIDES' JSONL lines and deleting only the marker " +
              "lines — every entry is an independent fact and line order does not matter (resolution is " +
              "by deleted_at). Normally this never happens: .tombstones/.gitattributes (merge=union) " +
              "makes git keep both sides automatically. Otherwise fix or remove the offending lines.",
          }
        : resurrected.length > 0
          ? {
              hint:
                "these node ids appear in the deletion ledger but are alive again. Legitimate when the same " +
                "content was re-ingested (resurrection); if unexpected, check whether an old id was reused " +
                "for a different concept.",
            }
          : {}),
    });
  }

  // ── 8. git-uncommitted (torn write の兆候) ───────────────────────────────
  let gitCheck: FsckCheck;
  try {
    const porcelain = (deps.gitStatusPorcelain ?? defaultGitStatusPorcelain)(vaultDir).trim();
    if (porcelain) {
      gitCheck = {
        id: "git-uncommitted",
        status: "error",
        detail: { changes: porcelain.split("\n") },
        hint:
          "uncommitted changes under the vault are the signature of a torn write (a mutation wrote files " +
          "but died before its git commit). Inspect with `git -C <vault> status -- .`; if the delta is " +
          "unwanted, roll back with `git -C <vault> restore --source=HEAD --staged --worktree -- .`; if it " +
          "is wanted, commit it deliberately. The next successful mutation would otherwise absorb it into " +
          "its own commit.",
      };
    } else {
      gitCheck = { id: "git-uncommitted", status: "ok", detail: { changes: [] } };
    }
  } catch (e: any) {
    gitCheck = {
      id: "git-uncommitted",
      status: "warn",
      detail: { error: String(e?.message ?? e) },
      hint:
        "vault is not a git repository (or git is unavailable): the atomic commit boundary and torn-write " +
        "detection do not apply here.",
    };
  }
  checks.push(gitCheck);

  const errors = checks.filter((c) => c.status === "error").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  return {
    generated_by: "graphrag/fsck.ts",
    vault: vaultDir,
    status: errors > 0 ? "error" : warnings > 0 ? "warn" : "ok",
    checks,
    counts: { files: files.length, nodes: nodes.length, edges: edges.length, errors, warnings },
  };
}

function parseArgs(argv: string[]) {
  const p: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) { p[k] = v; i += 1; } else p[k] = true;
  }
  return {
    vault: typeof p.vault === "string" ? p.vault : process.env.GRAPHRAG_VAULT_DIR,
  };
}

export function runFsck(
  argv: string[] = process.argv.slice(2),
  deps: FsckDeps = {}
): FsckReport {
  const args = parseArgs(argv);
  if (!args.vault) {
    throw new Error("fsck requires a vault: pass --vault <dir> or set GRAPHRAG_VAULT_DIR");
  }
  const schema = resolveSchema(args.vault);
  const report = fsckVault({ vaultDir: args.vault, schema, deps });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  // exit code 契約: ok/warn → 0, error → 1 (process.exit は使わずランタイムに任せる)。
  process.exitCode = report.status === "error" ? 1 : 0;
  return report;
}

function isMainModule(url: string): boolean {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
if (isMainModule(import.meta.url)) {
  runFsck();
}

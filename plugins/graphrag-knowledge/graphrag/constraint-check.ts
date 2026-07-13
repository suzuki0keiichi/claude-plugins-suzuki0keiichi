/**
 * constraint-check: Constraint の強制配線 (enforcement wiring) の read-only 検査 — 登記層の walker。
 *
 * 背景: 散文の Constraint はコードが違反しても何も落ちない (機械的消費者ゼロ) ため、
 * 「注意力による強制」に縮退し、episodic な日記層と同じく不活性化する。この verb は
 * 全 Constraint を歩き、enforced_by (Constraint → File = 破ったら落ちる検査) の配線を
 * 双方向で突き合わせる:
 *
 *   グラフ → コード: enforced_by の宛先検査ファイルが実在するか / skip されていないか /
 *                    マーカー (`graphrag:enforces constraint:<system>:<slug>` コメント) を持つか。
 *                    トークンを graphrag: で名前空間化するのは、規約を知らない読者 (人間 /
 *                    プラグイン未導入の AI) が grep 一発で出所 (.graphrag/ → vault) に辿り着ける
 *                    ようにするため。`git grep graphrag:enforces` = repo の登記済み enforcer 一覧。
 *   コード → グラフ: repo 中のマーカーが実在する Constraint を指すか (孤児化検出、
 *                    tombstone 台帳で 301 追跡) / そのファイルへの enforced_by が
 *                    グラフに登記済みか (未登記 enforcer は plan_fragment 付きで返す)。
 *
 * 「検査自体を走らせる」のは CI / pre-commit / graphrag-pr-review の機械 pass の仕事。
 * この verb は配線の腐敗だけを決定論的に検出する (違反検出は enforcer に委譲)。
 *
 * finding kinds (stable id):
 *   - enforcer-missing        : enforced_by の宛先 path がディスクに無い (= 強制の約束が実行不能) = ERROR
 *   - enforcer-skipped        : enforcer ファイルに skip マーカー (it.skip / @Disabled / #[ignore] 等、
 *                               言語別ベストエフォート) = WARN
 *   - marker-missing          : enforcer ファイルに `graphrag:enforces <id>` コメントが無い
 *                               (検査を消す/骨抜きにする人への現場警告が無い) = WARN
 *   - unguarded               : enforced_by も enforcement:"none" 宣言も無い Constraint = WARN
 *   - unenforceable-no-reason : enforcement:"none" なのに enforcement_reason が無い = WARN
 *   - contradictory-enforcement: enforcement:"none" なのに enforced_by がある = WARN
 *   - orphan-marker           : マーカーが指す Constraint が vault に無い (tombstone 台帳を引いて
 *                               successor があれば案内) = WARN
 *   - unregistered-enforcer   : マーカーは在るがグラフに enforced_by が未登記
 *                               (そのまま適用できる plan_fragment を同梱) = WARN
 *
 * すべての finding は next_step (何が駄目で、どうすれば直るか) を必ず持つ。
 * exit code: ok/warn → 0, error → 1。--strict で warn も 1 に昇格 (CI 用)。
 * project vault は対象外 (File ノードが無く、Constraint は本来的に外部条件) — note で明示して ok を返す。
 *
 * Usage:
 *   node --experimental-strip-types graphrag/cli.ts constraint-check [--vault <dir>] [--root <repo>] [--strict]
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { importVault } from "./import-vault.ts";
import { canonicalType } from "./schema.ts";
import { resolveSchema } from "./schema-registry.ts";
import { latestTombstones, resolveSuccessor } from "./tombstones.ts";
import { edgeId } from "./cli-typed-add.ts";

export type ConstraintCheckSeverity = "error" | "warn";

export interface ConstraintCheckFinding {
  kind: string;
  severity: ConstraintCheckSeverity;
  constraint_id?: string;
  file_path?: string;
  line?: number;
  detail: string;
  /** 何をすれば直るか (利用エージェント向けの具体的な処方) — 全 finding 必須。 */
  next_step: string;
  /** そのまま commit-mutation に貼れる plan (unguarded / unregistered-enforcer)。 */
  plan_fragment?: unknown;
}

export interface ConstraintCheckResult {
  generated_by: "graphrag/constraint-check.ts";
  vault_dir: string;
  root: string;
  schema: string;
  status: "ok" | "warn" | "error";
  constraints: { total: number; enforced: number; unenforceable: number; unguarded: number };
  findings: ConstraintCheckFinding[];
  counts: { errors: number; warnings: number; markers_scanned: number };
  note: string;
}

export interface MarkerHit {
  path: string; // repo root 相対 (POSIX)
  line: number;
  constraintId: string;
}

export interface ConstraintCheckDeps {
  /** enforcer path の実在確認 (root 相対)。テスト DI 用。 */
  fileExists?: (root: string, relPath: string) => boolean;
  /** enforcer ファイル内容の読み込み (root 相対)。テスト DI 用。 */
  readFile?: (root: string, relPath: string) => string;
  /** repo 全体の `graphrag:enforces ...` マーカー走査 (git grep)。テスト DI 用。 */
  grepMarkers?: (root: string) => MarkerHit[];
}

/** マーカー文法: `graphrag:enforces <constraint-id>`。コメント記法非依存 (`//` `#` `--` どれでも)、1 行に複数可。 */
export const ENFORCES_MARKER_RE = /graphrag:enforces\s+(constraint:[a-z0-9._-]+:[a-z0-9._-]+)/g;

// skip 検出は言語別ベストエフォート (同居する無関係テストの skip も拾い得る — だから warn 止まり)。
// 「検査が本当にその不変条件を見ているか」の意味ドリフトは機械では捕まらない: それは
// marker-missing / レビューの守備範囲。
const SKIP_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b(?:it|test|describe)\.skip\s*\(/, label: "it/test/describe.skip" },
  { re: /\bx(?:it|describe|test)\s*\(/, label: "xit/xdescribe/xtest" },
  { re: /\btest\.todo\s*\(/, label: "test.todo" },
  { re: /@Disabled\b/, label: "@Disabled (JUnit5)" },
  { re: /@Ignore\b/, label: "@Ignore (JUnit4)" },
  { re: /#\[ignore/, label: "#[ignore] (Rust)" },
  { re: /@pytest\.mark\.skip/, label: "@pytest.mark.skip" },
  { re: /@unittest\.skip/, label: "@unittest.skip" },
  { re: /\bt\.Skip\(/, label: "t.Skip (Go)" }
];

function defaultFileExists(root: string, relPath: string): boolean {
  return existsSync(path.join(root, relPath));
}

function defaultReadFile(root: string, relPath: string): string {
  return readFileSync(path.join(root, relPath), "utf8");
}

/**
 * git grep でマーカーを機械走査する。-I でバイナリ除外。マッチ 0 は exit 1 なので空配列。
 * .md は除外 (enforcer は実行可能な検査であって文書ではない — 文書中のコード例を
 * 誤検出しないため)。vault 配下 (.graphrag/) も除外 (知識ノード本文が規約を引用し得る)。
 */
function defaultGrepMarkers(root: string): MarkerHit[] {
  let out = "";
  try {
    out = execFileSync(
      "git",
      ["-C", root, "grep", "-n", "-I", "-F", "graphrag:enforces", "--", "."],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (e: any) {
    if (e?.status === 1) return []; // no matches
    throw e;
  }
  const hits: MarkerHit[] = [];
  for (const lineText of out.split("\n")) {
    if (lineText.length === 0) continue;
    const first = lineText.indexOf(":");
    const second = lineText.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    const relPath = lineText.slice(0, first);
    const lineNo = Number(lineText.slice(first + 1, second));
    if (relPath.endsWith(".md") || relPath.split("/").includes(".graphrag")) continue;
    const content = lineText.slice(second + 1);
    for (const m of content.matchAll(ENFORCES_MARKER_RE)) {
      hits.push({ path: relPath, line: Number.isFinite(lineNo) ? lineNo : 0, constraintId: m[1] });
    }
  }
  return hits;
}

function scanSkipMarkers(content: string): { line: number; label: string; text: string }[] {
  const found: { line: number; label: string; text: string }[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const p of SKIP_PATTERNS) {
      if (p.re.test(lines[i])) {
        found.push({ line: i + 1, label: p.label, text: lines[i].trim() });
      }
    }
  }
  return found;
}

/** constraint id `constraint:<system>:<slug>` の system セグメント (無ければ null)。 */
function systemSegment(constraintId: string): string | null {
  const parts = constraintId.split(":");
  return parts.length >= 3 ? parts[1] : null;
}

export function constraintCheck(
  options: { vaultDir: string; root: string; schemaId?: string },
  deps: ConstraintCheckDeps = {}
): ConstraintCheckResult {
  const fileExists = deps.fileExists ?? defaultFileExists;
  const readFile = deps.readFile ?? defaultReadFile;
  const grepMarkers = deps.grepMarkers ?? defaultGrepMarkers;
  const schemaId = options.schemaId ?? "system";

  const base = {
    generated_by: "graphrag/constraint-check.ts" as const,
    vault_dir: options.vaultDir,
    root: options.root,
    schema: schemaId
  };

  if (schemaId !== "system") {
    return {
      ...base,
      status: "ok",
      constraints: { total: 0, enforced: 0, unenforceable: 0, unguarded: 0 },
      findings: [],
      counts: { errors: 0, warnings: 0, markers_scanned: 0 },
      note:
        "project vault — enforcement wiring is a system-vault concept (no File nodes; constraints here are " +
        "external conditions by nature). Nothing to check."
    };
  }

  const graph = importVault(options.vaultDir);
  const nodesById = new Map<string, Record<string, unknown>>();
  for (const n of graph.nodes) {
    if (typeof n.id === "string") nodesById.set(n.id, n);
  }
  const constraints = graph.nodes.filter((n: any) => canonicalType(n.type) === "Constraint");

  // enforced_by エッジを constraint id → 宛先 File 群で索引する。
  const enforcersByConstraint = new Map<string, { fileId: string; filePath: string | null }[]>();
  const enforcedFileIdsByConstraint = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.type !== "enforced_by" || typeof e.from !== "string" || typeof e.to !== "string") continue;
    const toNode = nodesById.get(e.to);
    // 宛先 File の path: ノードがあれば node.path、無ければ id 規約 `file:<system>:<path>` から復元
    // (dangling は fsck の edge-endpoints が別途 error にする — ここでは実在検査を続行する)。
    const derived = e.to.startsWith("file:") ? e.to.split(":").slice(2).join(":") : null;
    const filePath =
      toNode && typeof toNode.path === "string" ? (toNode.path as string) : derived && derived.length > 0 ? derived : null;
    if (!enforcersByConstraint.has(e.from)) enforcersByConstraint.set(e.from, []);
    enforcersByConstraint.get(e.from)!.push({ fileId: e.to, filePath });
    if (!enforcedFileIdsByConstraint.has(e.from)) enforcedFileIdsByConstraint.set(e.from, new Set());
    enforcedFileIdsByConstraint.get(e.from)!.add(e.to);
  }

  const findings: ConstraintCheckFinding[] = [];

  // ── グラフ → コード: 各 Constraint の配線を検査 ─────────────────────────────
  let enforcedCount = 0;
  let unenforceableCount = 0;
  let unguardedCount = 0;
  for (const c of constraints) {
    const cid = String(c.id);
    const enforcers = enforcersByConstraint.get(cid) ?? [];
    const declaredNone = c.enforcement === "none";

    if (declaredNone && enforcers.length > 0) {
      findings.push({
        kind: "contradictory-enforcement",
        severity: "warn",
        constraint_id: cid,
        detail: `"${c.title ?? cid}" declares enforcement:"none" but also has ${enforcers.length} enforced_by edge(s).`,
        next_step:
          "Decide which is true. If the checks really enforce it: commit-mutation with " +
          `{nodes:[{op:"update", id:"${cid}", updates:{enforcement:null, enforcement_reason:null}}]}. ` +
          "If they do not: delete the enforced_by edge(s) instead."
      });
    }

    if (enforcers.length === 0) {
      if (declaredNone) {
        unenforceableCount++;
        const reason = typeof c.enforcement_reason === "string" ? c.enforcement_reason.trim() : "";
        if (reason === "") {
          findings.push({
            kind: "unenforceable-no-reason",
            severity: "warn",
            constraint_id: cid,
            detail: `"${c.title ?? cid}" is declared mechanically unenforceable, but no enforcement_reason is recorded.`,
            next_step:
              "Record why no mechanical check can express this constraint: commit-mutation with " +
              `{nodes:[{op:"update", id:"${cid}", updates:{enforcement_reason:"<why>"}}]}. ` +
              "Without the reason, the next reader cannot tell a genuine external condition from a skipped wiring job."
          });
        }
      } else {
        unguardedCount++;
        const sys = systemSegment(cid) ?? "<system>";
        findings.push({
          kind: "unguarded",
          severity: "warn",
          constraint_id: cid,
          detail:
            `"${c.title ?? cid}" has no mechanical consumer: nothing fails when this constraint is violated, ` +
            "so it only enforces through someone's attention (which runs out exactly when it is needed most).",
          next_step:
            "Wire an enforcer (recommended): 1) write or locate the executable check (test / lint config / type " +
            `definition) that fails on violation; 2) add a comment marker \`graphrag:enforces ${cid}\` inside that file; ` +
            "3) re-run constraint-check — the unregistered-enforcer finding then hands you the exact " +
            "commit-mutation fragment. Or apply the plan_fragment below after replacing <PATH-TO-CHECK>. " +
            'If this is a genuine external condition (law / SLA) no check can express: commit-mutation with ' +
            `{nodes:[{op:"update", id:"${cid}", updates:{enforcement:"none", enforcement_reason:"<why>"}}]} — ` +
            "it stays visible here as unenforceable instead of silently unguarded.",
          plan_fragment: {
            reason: `wire enforcement for ${cid}`,
            nodes: [],
            edges: [
              {
                op: "create",
                id: edgeId(cid, "enforced_by", `file:${sys}:<PATH-TO-CHECK>`),
                type: "enforced_by",
                from: cid,
                to: `file:${sys}:<PATH-TO-CHECK>`
              }
            ]
          }
        });
      }
      continue;
    }

    enforcedCount++;
    for (const enf of enforcers) {
      if (!enf.filePath) {
        findings.push({
          kind: "enforcer-missing",
          severity: "error",
          constraint_id: cid,
          file_path: enf.fileId,
          detail: `enforced_by target ${enf.fileId} has no resolvable path (File node missing and id carries no path).`,
          next_step:
            "The enforcement promise cannot run. Point the edge at a real check file: delete this enforced_by edge " +
            "and re-wire it via commit-mutation to the actual file id (file:<system>:<path>), or restore the missing File node."
        });
        continue;
      }
      if (!fileExists(options.root, enf.filePath)) {
        findings.push({
          kind: "enforcer-missing",
          severity: "error",
          constraint_id: cid,
          file_path: enf.filePath,
          detail:
            `"${c.title ?? cid}" claims to be enforced by ${enf.filePath}, but that file does not exist on disk ` +
            "(deleted or renamed after wiring). The graph promises enforcement that can no longer run.",
          next_step:
            `If the check moved: re-wire via commit-mutation (delete edge to ${enf.fileId}, create enforced_by to the ` +
            "new file id, and carry the `graphrag:enforces` marker over). If the check was deleted: either restore it, or " +
            'downgrade honestly — delete the edge and mark the constraint {enforcement:"none", enforcement_reason:"<why>"} ' +
            "or record a Risk. Do not leave a dead enforcement promise in the graph."
        });
        continue;
      }
      let content: string;
      try {
        content = readFile(options.root, enf.filePath);
      } catch (e: any) {
        findings.push({
          kind: "enforcer-missing",
          severity: "error",
          constraint_id: cid,
          file_path: enf.filePath,
          detail: `enforcer ${enf.filePath} exists but cannot be read: ${String(e?.message ?? e)}`,
          next_step: "Fix the file permissions/encoding so the enforcer can be inspected, then re-run constraint-check."
        });
        continue;
      }
      const skips = scanSkipMarkers(content);
      if (skips.length > 0) {
        findings.push({
          kind: "enforcer-skipped",
          severity: "warn",
          constraint_id: cid,
          file_path: enf.filePath,
          line: skips[0].line,
          detail:
            `enforcer ${enf.filePath} contains skip marker(s): ` +
            skips.map((s) => `L${s.line} ${s.label} (${s.text})`).join("; ") +
            ". A skipped check enforces nothing (best-effort detection — a skip of an unrelated test in the same file is possible).",
          next_step:
            "Open the file and check whether the skipped test is the one guarding this constraint. If yes: un-skip it " +
            "or fix whatever made it get skipped — the constraint is currently unenforced. If the skip is unrelated, no action."
        });
      }
      const markerIds = new Set([...content.matchAll(ENFORCES_MARKER_RE)].map((m) => m[1]));
      if (!markerIds.has(cid)) {
        findings.push({
          kind: "marker-missing",
          severity: "warn",
          constraint_id: cid,
          file_path: enf.filePath,
          detail:
            `enforcer ${enf.filePath} lacks the comment marker \`graphrag:enforces ${cid}\`. Without it, whoever edits or ` +
            "deletes this check never learns it is load-bearing for a registered constraint (the graph knows, the code doesn't).",
          next_step: `Add a comment line \`graphrag:enforces ${cid}\` next to the guarding test/rule in ${enf.filePath}.`
        });
      }
    }
  }

  // ── コード → グラフ: repo 中のマーカーを逆走査 ──────────────────────────────
  let markers: MarkerHit[] = [];
  let markerScanNote = "";
  try {
    markers = grepMarkers(options.root);
  } catch (e: any) {
    markerScanNote = ` Marker reverse-scan unavailable (${String(e?.message ?? e)}) — orphan-marker/unregistered-enforcer checks skipped.`;
  }
  const tombs = latestTombstones(options.vaultDir);
  for (const hit of markers) {
    const target = nodesById.get(hit.constraintId);
    if (!target) {
      // tombstone 台帳で 301 追跡 (successor チェーンを畳んだ最終後継)。
      const entry = tombs.get(hit.constraintId);
      const successor = entry ? resolveSuccessor(tombs, hit.constraintId).final_successor : null;
      findings.push({
        kind: "orphan-marker",
        severity: "warn",
        constraint_id: hit.constraintId,
        file_path: hit.path,
        line: hit.line,
        detail:
          `${hit.path}:${hit.line} claims to enforce ${hit.constraintId}, but that constraint does not exist in the vault` +
          (entry
            ? ` (deleted ${String(entry.deleted_at)}${successor ? `, replaced by ${successor}` : ""}).`
            : " (never existed under this id, or was renamed without tombstone)."),
        next_step: successor
          ? `Update the marker to \`graphrag:enforces ${successor}\` and wire enforced_by from ${successor} to this file via commit-mutation.`
          : entry
            ? "The constraint was deleted without successor. If the invariant still matters, re-register it " +
              "(add-constraint --enforced-by this file); otherwise remove the stale marker."
            : "Fix the id in the marker if it is a typo; otherwise register the constraint " +
              "(add-constraint --enforced-by this file) or remove the marker."
      });
      continue;
    }
    if (canonicalType(target.type as string) !== "Constraint") {
      findings.push({
        kind: "orphan-marker",
        severity: "warn",
        constraint_id: hit.constraintId,
        file_path: hit.path,
        line: hit.line,
        detail: `${hit.path}:${hit.line} marker points at ${hit.constraintId}, which exists but is a ${String(target.type)}, not a Constraint.`,
        next_step: "Point the marker at a Constraint node id, or register the invariant as a Constraint."
      });
      continue;
    }
    const wired = enforcedFileIdsByConstraint.get(hit.constraintId) ?? new Set<string>();
    const sys = systemSegment(hit.constraintId) ?? "<system>";
    const fileId = `file:${sys}:${hit.path}`;
    // 同じファイルを指す enforced_by が既に在るか (File id は path ベースで突合)。
    const alreadyWired = [...wired].some((fid) => {
      const n = nodesById.get(fid);
      const p = n && typeof n.path === "string" ? (n.path as string) : fid.split(":").slice(2).join(":");
      return p === hit.path;
    });
    if (!alreadyWired) {
      const fileNodeExists = nodesById.has(fileId);
      findings.push({
        kind: "unregistered-enforcer",
        severity: "warn",
        constraint_id: hit.constraintId,
        file_path: hit.path,
        line: hit.line,
        detail:
          `${hit.path}:${hit.line} declares \`graphrag:enforces ${hit.constraintId}\` but the graph has no enforced_by edge to it — ` +
          "the code knows it is an enforcer, the graph doesn't.",
        next_step:
          "Apply the plan_fragment below via commit-mutation to register the wiring (it includes the File node when absent).",
        plan_fragment: {
          reason: `register enforcer ${hit.path} for ${hit.constraintId} (marker found by constraint-check)`,
          nodes: fileNodeExists
            ? []
            : [{ op: "create", id: fileId, type: "File", path: hit.path, title: path.basename(hit.path) }],
          edges: [
            {
              op: "create",
              id: edgeId(hit.constraintId, "enforced_by", fileId),
              type: "enforced_by",
              from: hit.constraintId,
              to: fileId
            }
          ]
        }
      });
    }
  }

  const severityRank = { error: 0, warn: 1 } as const;
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.kind.localeCompare(b.kind));
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;

  return {
    ...base,
    status: errors > 0 ? "error" : warnings > 0 ? "warn" : "ok",
    constraints: { total: constraints.length, enforced: enforcedCount, unenforceable: unenforceableCount, unguarded: unguardedCount },
    findings,
    counts: { errors, warnings, markers_scanned: markers.length },
    note:
      "Read-only wiring check. Running the enforcers themselves is CI / pre-commit / the graphrag-pr-review " +
      "mechanical pass's job — this verb only detects rot in the wiring, in both directions (graph→code and " +
      "code→graph). Skip detection is best-effort per language; whether a check still semantically guards its " +
      "constraint is the marker + review's territory. Markers in *.md and under .graphrag/ are ignored." +
      markerScanNote
  };
}

/**
 * ask / inspect 同乗用の軽量集計: 未ガード Constraint 数。
 * enforcement contract 導入前に作られた vault を新版で開いた時の移行導線 —
 * 「新バージョンでは繋がないとな」を、利用者が constraint-check を知らなくても
 * 普段の読み (ask) で気づける形にする。system スキーマ前提 (呼び出し側でゲート)。
 */
export function enforcementDebt(graph: { nodes: any[]; edges: any[] }): { total: number; unguarded: number } {
  const enforced = new Set<string>();
  for (const e of graph.edges ?? []) {
    if (e?.type === "enforced_by" && typeof e.from === "string") enforced.add(e.from);
  }
  let total = 0;
  let unguarded = 0;
  for (const n of graph.nodes ?? []) {
    if (canonicalType(n?.type as string) !== "Constraint") continue;
    total += 1;
    if (!enforced.has(String(n.id)) && n.enforcement !== "none") unguarded += 1;
  }
  return { total, unguarded };
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
    root: typeof p.root === "string" ? p.root : process.cwd(),
    strict: p.strict === true
  };
}

export function runConstraintCheck(
  argv: string[] = process.argv.slice(2),
  deps: ConstraintCheckDeps = {}
): ConstraintCheckResult {
  const args = parseArgs(argv);
  if (!args.vault) {
    throw new Error("constraint-check requires a vault: pass --vault <dir> or set GRAPHRAG_VAULT_DIR");
  }
  const schema = resolveSchema(args.vault);
  const result = constraintCheck({ vaultDir: args.vault, root: args.root, schemaId: schema.id }, deps);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // exit code 契約: ok/warn → 0, error → 1。--strict は warn も 1 (CI で赤にする用)。
  process.exitCode = result.status === "error" || (args.strict && result.status === "warn") ? 1 : 0;
  return result;
}

function isMainModule(url: string): boolean {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
if (isMainModule(import.meta.url)) {
  runConstraintCheck();
}

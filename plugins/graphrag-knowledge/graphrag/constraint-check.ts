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
 *                               言語別ベストエフォート) = WARN。同じ行に `graphrag:skip-unrelated <fingerprint> <理由>`
 *                               がある skip は確認済みとして数えない。判定単位は Constraint: 実在・読めて・
 *                               その cid のマーカーを持ち・未確認の skip 兆候が無い enforcer が別に登記されて
 *                               いれば warn にせず covered_skips に出す (.only と stale な印の行は除く)。各 enforced_by は
 *                               単独でその制約を検査する登録として読む (合わせて初めて検査できるなら制約を分ける)
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
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { importVault } from "./import-vault.ts";
import { canonicalType } from "./schema.ts";
import { resolveSchema } from "./schema-registry.ts";
import { latestTombstones, resolveSuccessor } from "./tombstones.ts";
import { edgeId } from "./cli-typed-add.ts";
import { stripQuotedInLine } from "./markers.ts";

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
  counts: { errors: number; warnings: number; markers_scanned: number; covered_skips: number };
  /** graphrag:skip-unrelated で確認済みにされ warn から外れた skip 行 (免除の監査用に必ず可視化)。 */
  acknowledged_skips: { path: string; line: number; label: string; reason: string }[];
  /**
   * 同じ制約の clean な enforcer (下記) が別に登記されているため warn から外れた skip 行 (issue #49 — 判定単位は Constraint)。
   * covered_by = 実在・読めて・その cid のマーカーを持ち・未確認の skip 兆候が無い enforcer。
   * 実際に走って守っているかは見ない (静的事実)。無関係と確認した acknowledged_skips とは混ぜない。
   * acknowledged_skips はファイル単位で 1 件だが、こちらは制約ごとに 1 件 (同じ行が制約の数だけ並び得る)。
   */
  covered_skips: { constraint_id: string; path: string; line: number; label: string; covered_by: string[] }[];
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
// 行単位の字句一致なので実行条件・到達性は評価しない: コメント/文字列内の一致も拾う (既知の限界)、
// 複数行・alias/分割代入・呼び出しを挟むチェーン (test.each(...).skip) は拾えない。
// JS の skip は呼び出しに限らず参照も拾う (issue #47: `cond ? describe.skip : describe` のような
// 条件付き skip)。receiver をテスト API 名に限るのは audit.skip() / obj.skipIf() を拾わないため。
const JS_TEST_RECEIVER = String.raw`\b(?:it|test|describe|suite|context)(?:\.\w+)*`;
// ackable:false = graphrag:skip-unrelated で確認済みにできない。.only はその行のテスト自身は走り、
// 別の場所の enforcer を止め得るので「この行は無関係」が免除の根拠にならない。同じ理由で、ackable:false の
// 兆候を持つ制約では別の enforcer による covered_skips も成り立たない (isOnlySkip)。
const SKIP_PATTERNS: { re: RegExp; label: string; ackable?: false; refine?: (line: string) => boolean }[] = [
  { re: new RegExp(String.raw`${JS_TEST_RECEIVER}\.skip\b`), label: "it/test/describe.skip" },
  { re: new RegExp(String.raw`${JS_TEST_RECEIVER}\.(?:skipIf|runIf)\s*\(`), label: "skipIf/runIf (conditional)" },
  { re: new RegExp(String.raw`${JS_TEST_RECEIVER}\.todo\s*\(`), label: "test.todo" },
  {
    re: new RegExp(String.raw`${JS_TEST_RECEIVER}\.only\b`),
    label: ".only (exclusive selection — may exclude other tests)",
    ackable: false
  },
  { re: /\bx(?:it|describe|test)\s*\(/, label: "xit/xdescribe/xtest" },
  // node:test: context の変数名が t の時だけ拾う (任意名は字句では追えない)。t.skip() は関数を止めない
  // (以降も実行される) ので「skip の兆候」として扱う。{ skip: cond } options は拾わない: 行単位では
  // テスト本体内のオブジェクトや `false || cond` と区別できない (issue #48 で見送り)。
  { re: /\bt\.(?:skip|todo)\s*\(/, label: "t.skip/t.todo (node:test)" },
  { re: /@Disabled\b/, label: "@Disabled (JUnit5)" },
  {
    re: /@(?:Disabled|Enabled)(?:OnOs|OnJre|ForJreRange|If|IfSystemPropert(?:y|ies)|IfEnvironmentVariables?|InNativeImage)\b/,
    label: "conditional (JUnit5)"
  },
  { re: /@Ignore\b/, label: "@Ignore (JUnit4)" },
  { re: /#\[ignore/, label: "#[ignore] (Rust)" },
  // ignore を predicate 側 (feature = "ignore" / any(unix, ignore)) でなく attribute 側に限る — 最上位の引数を数える。
  { re: /#\[cfg_attr\(/, label: "#[cfg_attr(..., ignore)] (Rust)", refine: rustCfgAttrIgnores },
  { re: /@pytest\.mark\.skip/, label: "@pytest.mark.skip" },
  { re: /\bpytest\.skip\s*\(/, label: "pytest.skip()" },
  { re: /@unittest\.skip/, label: "@unittest.skip" },
  { re: /\bt\.Skip(?:f|Now)?\s*\(/, label: "t.Skip/Skipf/SkipNow (Go)" }
];

/** `#[cfg_attr(<predicate>, <attr>, ...)]` の最上位引数を分け、2番目以降 (attribute 側) に ignore があるか。1行で閉じない属性は拾えない (既知の限界)。 */
function rustCfgAttrIgnores(line: string): boolean {
  const code = stripQuotedInLine(line);
  const open = code.indexOf("#[cfg_attr(");
  if (open < 0) return false;
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of code.slice(open + "#[cfg_attr(".length)) {
    if (ch === ")" && depth === 0) {
      args.push(cur);
      return args.slice(1).some((a) => /^\s*ignore\b/.test(a));
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      args.push(cur);
      cur = "";
    } else cur += ch;
  }
  return false;
}

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
 * 文字列リテラル内は markers.ts の stripQuotedInLine で潰す — テストフィクスチャに
 * 書かれた id を実マーカーと誤認しない (delta-check と同じ耐性)。
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
    const content = stripQuotedInLine(lineText.slice(second + 1));
    for (const m of content.matchAll(ENFORCES_MARKER_RE)) {
      hits.push({ path: relPath, line: Number.isFinite(lineNo) ? lineNo : 0, constraintId: m[1] });
    }
  }
  return hits;
}

/**
 * 同居する無関係な skip の確認済み印: skip と同じ行のコメントに
 * `graphrag:skip-unrelated <fingerprint> <理由>`。意味は「このファイルが enforcer として守る
 * **全ての** Constraint と無関係」(強い宣言 — 一部の Constraint だけに無関係な skip には使わない)。
 * fingerprint は印を除いた行の sha256 先頭 8 桁で、行内の条件・skip API の変更や同じ行への skip 追加で
 * 一致しなくなり再び warn になる (#46 の resurrection_ack を削除世代に束縛したのと同じ考え方 —
 * ソース上の永久免除にしない)。別の行にある条件の変更は追えない (既知の限界)。理由の無い印は無効。
 * 印は行コメント記号 (// # --) の直後に置いた時だけ有効 (禁止パターンの列挙でなく、行コメントの開始位置を
 * 特定できた時だけ受理する)。その位置で fingerprint を切るので、印の後ろはコメントであってコードではない。
 * 印より後ろ (生の行) にブロックコメントの閉じ記号があれば無効 — ブロックコメントの中では印の後ろにコードを続けられ、そのコードが
 * fingerprint から漏れるため。文字列リテラル内の印も数えない。
 * 正しい fingerprint は warn の next_step にそのまま貼れる形で出す。
 */
const SKIP_ACK_TOKEN = "graphrag:skip-unrelated";
const SKIP_ACK_RE = /^graphrag:skip-unrelated\s+([0-9a-f]{8})\s+(\S.*)$/;
const LINE_COMMENT_OPENER_RE = /(?:\/\/|#|--)\s*$/;

export function skipLineFingerprint(line: string): string {
  const at = line.lastIndexOf(SKIP_ACK_TOKEN);
  const code = (at >= 0 ? line.slice(0, at) : line).replace(LINE_COMMENT_OPENER_RE, "").trim();
  return createHash("sha256").update(code).digest("hex").slice(0, 8);
}

/** 行コメント記号の直後にある、文字列外の印だけを解析する。判別できなければ null (= ack しない)。 */
function parseSkipAck(line: string): { fingerprint: string; reason: string } | null {
  if (!stripQuotedInLine(line).includes(SKIP_ACK_TOKEN)) return null;
  const at = line.lastIndexOf(SKIP_ACK_TOKEN);
  if (!LINE_COMMENT_OPENER_RE.test(line.slice(0, at))) return null;
  const rest = line.slice(at);
  if (rest.includes("*/")) return null;
  const m = rest.match(SKIP_ACK_RE);
  return m ? { fingerprint: m[1], reason: m[2].trim() } : null;
}

type SkipHit = {
  line: number;
  label: string;
  text: string;
  fingerprint: string;
  ack: { state: "valid" | "stale"; reason: string } | null;
};

/** 物理行に分け、各行末の CR を 1 つ落とす — CRLF の作業ツリーでも検出・fingerprint・印の解析を LF と同じ行に揃える (issue #49)。 */
function physicalLines(content: string): string[] {
  return content.split("\n").map((line) => line.replace(/\r$/, ""));
}

function distinctLines(skips: SkipHit[]): number {
  return new Set(skips.map((s) => s.line)).size;
}

/** ackable:false の兆候 (.only) か — 確認済みにも covered にもできない。 */
function isOnlySkip(s: SkipHit): boolean {
  return SKIP_PATTERNS.find((p) => p.label === s.label)?.ackable === false;
}

function scanSkipMarkers(content: string): SkipHit[] {
  const found: SkipHit[] = [];
  const lines = physicalLines(content);
  for (let i = 0; i < lines.length; i++) {
    const hits = SKIP_PATTERNS.filter((p) => p.re.test(lines[i]) && (p.refine?.(lines[i]) ?? true));
    if (hits.length === 0) continue;
    const fingerprint = skipLineFingerprint(lines[i]);
    const parsed = parseSkipAck(lines[i]);
    for (const p of hits) {
      const ack =
        parsed && p.ackable !== false
          ? { state: parsed.fingerprint === fingerprint ? ("valid" as const) : ("stale" as const), reason: parsed.reason }
          : null;
      found.push({ line: i + 1, label: p.label, text: lines[i].trim(), fingerprint, ack });
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
      counts: { errors: 0, warnings: 0, markers_scanned: 0, covered_skips: 0 },
      acknowledged_skips: [],
      covered_skips: [],
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
  const acknowledgedSkips = new Map<string, ConstraintCheckResult["acknowledged_skips"][number]>();
  const coveredSkips: ConstraintCheckResult["covered_skips"] = [];

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
    const inspected: { filePath: string; allSkips: SkipHit[]; skips: SkipHit[]; hasMarker: boolean }[] = [];
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
      const allSkips = scanSkipMarkers(content);
      for (const s of allSkips) {
        if (s.ack?.state === "valid") acknowledgedSkips.set(`${enf.filePath}:${s.line}:${s.label}`, {
          path: enf.filePath, line: s.line, label: s.label, reason: s.ack.reason
        });
      }
      const markerIds = new Set(
        physicalLines(content).flatMap((line) => [...stripQuotedInLine(line).matchAll(ENFORCES_MARKER_RE)].map((m) => m[1]))
      );
      const hasMarker = markerIds.has(cid);
      inspected.push({ filePath: enf.filePath, allSkips, skips: allSkips.filter((s) => s.ack?.state !== "valid"), hasMarker });
      if (!hasMarker) {
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

    // skip の判定単位は Constraint (issue #49): 実在・読めて・この cid のマーカーを持ち・未確認の skip 兆候が
    // 無い enforcer が別に登記されていれば、他の enforcer の skip は warn にせず covered_skips に出す。
    // 「守られている」の証明ではなく静的事実 — 各 enforced_by は単独でその制約を検査する登録として読む。
    // 既知の限界: clean かどうかも字句検出なので、検出できない skip (pytestmark / this.skip() / テスト本体の
    // コメントアウト等) や走らないコピー (dist/ の生成物) が代替に数えられると、検出できた skip まで隠れる。
    // covered_skips を pr-review が diff と突き合わせて拾うのはそのため。
    // .only を持つ制約では covered を作らない: .only は別ファイルの代替 enforcer ごと実行対象から外し得る。
    // stale な印の行も covered にしない: 確認済みの行が書き換わったという信号を代替の存在で消さない。
    const onlyAt = inspected.flatMap((x) => x.skips.filter(isOnlySkip).map((s) => `${x.filePath} L${s.line}`));
    const hasOnly = onlyAt.length > 0;
    const clean = hasOnly ? [] : inspected.filter((x) => x.hasMarker && x.skips.length === 0).map((x) => x.filePath);
    for (const x of inspected) {
      const alternatives = clean.filter((p) => p !== x.filePath);
      const covered = alternatives.length > 0 ? x.skips.filter((s) => s.ack === null) : [];
      for (const s of covered) {
        coveredSkips.push({ constraint_id: cid, path: x.filePath, line: s.line, label: s.label, covered_by: alternatives });
      }
      const skips = x.skips.filter((s) => !covered.includes(s));
      if (skips.length === 0) continue;
      const onlySkips = skips.filter(isOnlySkip);
      const ackableSkips = skips.filter((s) => !isOnlySkip(s));
      const ackedLines = distinctLines(x.allSkips.filter((s) => s.ack?.state === "valid"));
      const coveredLines = distinctLines(covered);
      findings.push({
        kind: "enforcer-skipped",
        severity: "warn",
        constraint_id: cid,
        file_path: x.filePath,
        line: skips[0].line,
        detail:
          `enforcer ${x.filePath} contains skip marker(s): ` +
          skips.map((s) => `L${s.line} ${s.label} (${s.text})${s.ack?.state === "stale" ? " [stale graphrag:skip-unrelated — the line changed since it was acknowledged]" : ""}`).join("; ") +
          ". Skip markers are static signals: whether the check actually ran is not checked here " +
          "(best-effort detection — a skip of an unrelated test in the same file is possible)." +
          (ackedLines > 0 ? ` ${ackedLines} other skip line(s) are acknowledged as unrelated (graphrag:skip-unrelated).` : "") +
          (coveredLines > 0
            ? ` ${coveredLines} other skip line(s) are recorded in covered_skips because another registered enforcer of this ` +
              "constraint has no unacknowledged skip marker."
            : ""),
        next_step: [
          onlySkips.length === 0 && hasOnly
            ? `Another enforcer of this constraint has .only (${onlyAt.join(", ")}): while it remains, no skip of this ` +
              "constraint is covered by another enforcer — remove it first."
            : "",
          onlySkips.length > 0
            ? `Remove the .only (${onlySkips.map((s) => `L${s.line}`).join(", ")}): it can exclude other tests — including ` +
              "other enforcers — from the run, so it can be neither acknowledged nor covered by another enforcer " +
              "(while it remains, no skip of this constraint is covered)."
            : "",
          ackableSkips.length > 0
            ? "Open the file and check whether the skipped test is the one guarding this constraint. If yes: un-skip it " +
              "or fix whatever made it get skipped" +
              // 代替で解消するのは stale でない行だけ (.only が残る間は何も covered にならない)
              (!hasOnly && alternatives.length === 0 && ackableSkips.some((s) => s.ack === null)
                ? " — or register another enforcer that checks this constraint without a skip (e.g. rewrite the check " +
                  "so it runs regardless of the condition), with its own marker; skips are then recorded in covered_skips " +
                  "instead of warning"
                : "") +
              ". If the skip is unrelated to EVERY constraint this file enforces, acknowledge it with a comment on that " +
              "same line: " +
              ackableSkips.map((s) => `L${s.line} \`${SKIP_ACK_TOKEN} ${s.fingerprint} <reason>\``).join("; ") +
              " (the fingerprint binds it to the current line; editing the line warns again)."
            : ""
        ]
          .filter((t) => t !== "")
          .join(" ")
      });
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
    counts: { errors, warnings, markers_scanned: markers.length, covered_skips: coveredSkips.length },
    acknowledged_skips: [...acknowledgedSkips.values()],
    covered_skips: coveredSkips,
    note:
      "Read-only wiring check. Running the enforcers themselves is CI / pre-commit / the graphrag-pr-review " +
      "mechanical pass's job — this verb only detects rot in the wiring, in both directions (graph→code and " +
      "code→graph). Skip detection is best-effort per language; whether a check still semantically guards its " +
      "constraint is the marker + review's territory. covered_skips is a static wiring fact, not evidence the check ran. Markers in *.md and under .graphrag/ are ignored." +
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

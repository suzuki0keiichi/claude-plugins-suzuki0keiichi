/**
 * delta-check: diff スコープの「登記済み知識の決定的逆引き」— commit 境界の読みの導線。
 *
 * 背景 (VDU/MOT 実測): 知識が効かなかった事例は全部同じ機序だった — 知識は正本側
 * (OK・Constraint・正本宣言コメント) に存在したが、破る側の作業経路上に無かった。
 * 読みの導線は着手時 (ask) にしか無く、書き終えて commit する瞬間には「書き戻せ」
 * (write-back hook) としか言わない。この verb はその空白を埋める: いま変更した
 * ファイル群に エッジで繋がる知識の見出しを、embedding 無しで決定的に返す。
 *
 * 4つの検査 (すべて決定的・意味判断なし):
 *   - connected_knowledge : 変更ファイルへ constrains / documented_by / sets_policy_for /
 *                           enforced_by / risks_in で繋がる知識ノードの見出し1行ずつ
 *                           (診断ではなく「commit 前に読むべきもの」の提示。severity なし)
 *   - authority_echoes    : 権威を宣言する知識ノード (File 配線済み) の aliases =
 *                           「権威の語彙指紋」が、diff の追加行に権威の家の外で現れた。
 *                           重複実装 (VDU の ERROR_STATUSES 3重ハードコード型) の2箇所目を
 *                           現行犯で見せる。再実装の diff に現れるのは権威のシンボル名では
 *                           なく中身の語彙 — だから権威ノードの aliases には守りたい語彙
 *                           (状態リテラル・正規化キー等) を入れる運用とセットで効く。
 *                           import 等の正当利用でも現れるため裁かない (行内容を添えて
 *                           書き手に判断させる — 地図の思想)。
 *   - marker_findings     : 変更ファイル内の graphrag:see / graphrag:enforces マーカーの
 *                           参照先生存検証 (broken / tombstoned 301 / superseded — markers.ts)
 *   - placement_findings  : frame-check の高精度2判定の転載 (縄張り内未配線 / クラスタ閾値)
 *
 * 出力契約: clean なら summary 1行で終わる (findings ゼロ時のコンテキスト消費 ≈ 0)。
 * hook / pre-commit から毎回呼ばれる前提の設計 — 効果がある時だけ膨らむ。
 *
 * これは gate ではない。connected_knowledge は「読め」であって「直せ」ではない。
 * そして clean は「登記済み知識がこの diff に配線されていない」であって「安全」では
 * ない — エッジが張られていない知識はここには現れない (登記されないものは守れない)。
 *
 * Usage:
 *   node --experimental-strip-types graphrag/cli.ts delta-check [--files <p,...>] [--diff <range>]
 *     [--root <repo>] [--vault <dir>] [--strict]
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { importVault } from "./import-vault.ts";
import { canonicalType } from "./schema.ts";
import { KNOWLEDGE_TO_FILE_EDGES } from "./crosscut-map.ts";
import {
  frameCheck,
  defaultGitDiffPaths,
  defaultGitWorktreePaths,
  type FrameCheckDeps,
  type FrameFinding
} from "./frame-check.ts";
import { scanMarkersInContent, verifyMarkerRefs, type MarkerRefFinding } from "./markers.ts";

const CONNECTED_CAP = 20;
const VIA_CAP = 3;
const HEADLINE_CHARS = 160;

/** 見出しの型優先度: 破ってはならないもの → 判断 → 記録。同格は via 数降順。 */
const TYPE_PRIORITY: Record<string, number> = {
  Constraint: 0,
  Risk: 1,
  Decision: 2,
  OperationalKnowledge: 3,
  RejectedOption: 4,
  Goal: 5,
  Investigation: 6
};

export interface ConnectedKnowledge {
  id: string;
  type: string;
  title: string;
  state?: string;
  headline: string;
  /** どの変更ファイルにどのエッジで繋がっているか (最大 VIA_CAP 件 + overflow)。 */
  via: { edge: string; path: string }[];
  via_overflow?: number;
}

export interface DeltaCheckResult {
  generated_by: "graphrag/delta-check.ts";
  vault_dir: string;
  root: string;
  input_source: "files" | "diff" | "worktree";
  status: "clean" | "info" | "warn";
  summary: string;
  connected_knowledge: ConnectedKnowledge[];
  authority_echoes: AuthorityEcho[];
  marker_findings: MarkerRefFinding[];
  placement_findings: FrameFinding[];
  counts: {
    inputs: number;
    connected: number;
    connected_overflow: number;
    authority_echoes: number;
    marker_findings: number;
    placement_findings: number;
  };
  note: string;
}

export interface AuthorityEcho {
  alias: string;
  knowledge_id: string;
  knowledge_type: string;
  title: string;
  /** 権威の家 (この知識が File エッジで配線されている path 群)。 */
  authority_paths: string[];
  occurrences: { path: string; line: number; text: string }[];
  occurrences_overflow?: number;
}

export interface DeltaCheckDeps extends FrameCheckDeps {
  /** 変更ファイル内容の読み込み (マーカー走査・files モードの echo 用)。テスト DI 用。 */
  readFile?: (root: string, relPath: string) => string;
  fileExists?: (root: string, relPath: string) => boolean;
  /** diff の追加行取得 (authority echo 用)。range=null は worktree (HEAD 比較)。テスト DI 用。 */
  gitAddedLines?: (root: string, range: string | null, paths: string[]) => Map<string, { line: number; text: string }[]>;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

// ── authority echo: 追加行の取得と語彙照合 ──────────────────────────────────

/** unified diff テキストから「新側の追加行」を path → [{line,text}] で取り出す。 */
export function parseUnifiedAddedLines(diffText: string): Map<string, { line: number; text: string }[]> {
  const out = new Map<string, { line: number; text: string }[]>();
  let current: string | null = null;
  let newLine = 0;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      current = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (!out.has(current)) out.set(current, []);
      out.get(current)!.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith(" ")) {
      newLine += 1; // context 行 (--unified=0 では出ないが防御)
    }
  }
  return out;
}

function defaultGitAddedLines(
  root: string,
  range: string | null,
  paths: string[]
): Map<string, { line: number; text: string }[]> {
  const args = range === null
    ? ["diff", "HEAD", "--unified=0", "--no-color", "--", ...paths]
    : ["diff", range, "--unified=0", "--no-color", "--", ...paths];
  const out = execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return parseUnifiedAddedLines(out);
}

/**
 * echo 対象の alias: コード識別子形式 (先頭英字・4文字以上)、ただし単一の全小文字英単語
 * (migration / footprint 等) は除外 — 自然な英語としてコード/コメントに頻出し、指紋に
 * ならない (自 vault での実測)。効く指紋は固有識別子: ERROR_STATUSES (大文字) /
 * zero_bytes (_) / decideAutoUnmount (camelCase) / constraint-check (ハイフン) 型。
 */
const ECHO_ALIAS_RE = /^[A-Za-z_$][A-Za-z0-9_$./-]{3,}$/;
const PLAIN_LOWERCASE_WORD_RE = /^[a-z]+$/;
export function isEchoAlias(alias: string): boolean {
  return ECHO_ALIAS_RE.test(alias) && !PLAIN_LOWERCASE_WORD_RE.test(alias);
}

/** 行内に alias が識別子境界つきで現れるか (前後が英数/_/$ でない)。 */
export function lineHasToken(line: string, token: string): boolean {
  let idx = 0;
  for (;;) {
    idx = line.indexOf(token, idx);
    if (idx < 0) return false;
    const before = idx > 0 ? line[idx - 1] : "";
    const after = idx + token.length < line.length ? line[idx + token.length] : "";
    const wordish = /[A-Za-z0-9_$]/;
    if (!wordish.test(before) && !wordish.test(after)) return true;
    idx += token.length;
  }
}

export function deltaCheck(
  options: {
    vaultDir: string;
    root: string;
    paths: string[];
    inputSource: "files" | "diff" | "worktree";
    /** inputSource="diff" のときの range (authority echo が追加行を取るのに使う)。 */
    diffRange?: string;
  },
  deps: DeltaCheckDeps = {}
): DeltaCheckResult {
  const readFile = deps.readFile ?? ((root: string, rel: string) => readFileSync(path.join(root, rel), "utf8"));
  const fileExists = deps.fileExists ?? ((root: string, rel: string) => existsSync(path.join(root, rel)));

  const graph = importVault(options.vaultDir);
  const paths = [...new Set(options.paths.map((p) => toPosix(p).replace(/^\.\//, "")))];
  const pathSet = new Set(paths);

  const nodesById = new Map<string, any>();
  for (const n of graph.nodes ?? []) {
    if (typeof n?.id === "string") nodesById.set(n.id, n);
  }

  // ── connected_knowledge: 知識 → File エッジの逆引き ─────────────────────────
  // File の同定は path フィールド優先、無ければ id 規約 `file:<system>:<path>` から復元
  // (dangling エッジでも実在検査を続けるのは constraint-check と同じ流儀)。
  const connectedByNode = new Map<string, { node: any; via: { edge: string; path: string }[] }>();
  for (const e of graph.edges ?? []) {
    if (typeof e?.type !== "string" || !KNOWLEDGE_TO_FILE_EDGES.has(e.type)) continue;
    if (typeof e.from !== "string" || typeof e.to !== "string") continue;
    const toNode = nodesById.get(e.to);
    const derived = e.to.startsWith("file:") ? e.to.split(":").slice(2).join(":") : null;
    const filePath =
      toNode && typeof toNode.path === "string" ? (toNode.path as string) : derived && derived.length > 0 ? derived : null;
    if (!filePath || !pathSet.has(filePath)) continue;
    const fromNode = nodesById.get(e.from);
    if (!fromNode) continue;
    // constrains は Decision|File|OK も宛先に取るが、逆引きの主語は常に from 側の知識ノード。
    if (!connectedByNode.has(e.from)) connectedByNode.set(e.from, { node: fromNode, via: [] });
    connectedByNode.get(e.from)!.via.push({ edge: e.type, path: filePath });
  }

  const connectedAll = [...connectedByNode.values()].map(({ node, via }) => {
    const type = canonicalType(node.type as string) ?? String(node.type);
    const entry: ConnectedKnowledge = {
      id: String(node.id),
      type,
      title: String(node.title ?? node.id),
      ...(typeof node.state === "string" && node.state.length > 0 ? { state: node.state } : {}),
      headline: truncate(String(node.summary ?? ""), HEADLINE_CHARS),
      via: via.slice(0, VIA_CAP),
      ...(via.length > VIA_CAP ? { via_overflow: via.length - VIA_CAP } : {})
    };
    return entry;
  });
  connectedAll.sort(
    (a, b) =>
      (TYPE_PRIORITY[a.type] ?? 9) - (TYPE_PRIORITY[b.type] ?? 9) ||
      (b.via.length + (b.via_overflow ?? 0)) - (a.via.length + (a.via_overflow ?? 0)) ||
      a.id.localeCompare(b.id)
  );
  const connected = connectedAll.slice(0, CONNECTED_CAP);
  const connectedOverflow = connectedAll.length - connected.length;

  // ── authority_echoes: 権威の語彙指紋が家の外の追加行に現れた ─────────────────
  // 権威 = KNOWLEDGE_TO_FILE_EDGES で File に配線され、識別子形式の alias を持つ知識
  // ノード。その alias が「家 (配線先 path 群) 以外」の追加行に現れたら、重複実装の
  // 2箇所目の疑い (正当な import でも現れる — 行内容を添えて書き手に判断させる)。
  const echoTargets = new Map<string, { node: any; homes: Set<string>; aliases: string[] }>();
  for (const e of graph.edges ?? []) {
    if (typeof e?.type !== "string" || !KNOWLEDGE_TO_FILE_EDGES.has(e.type)) continue;
    if (typeof e.from !== "string" || typeof e.to !== "string") continue;
    const fromNode = nodesById.get(e.from);
    if (!fromNode) continue;
    const aliases = (Array.isArray(fromNode.aliases) ? fromNode.aliases : [])
      .filter((a: unknown): a is string => typeof a === "string" && isEchoAlias(a));
    if (aliases.length === 0) continue;
    const toNode = nodesById.get(e.to);
    const derived = e.to.startsWith("file:") ? e.to.split(":").slice(2).join(":") : null;
    const filePath =
      toNode && typeof toNode.path === "string" ? (toNode.path as string) : derived && derived.length > 0 ? derived : null;
    if (!filePath) continue;
    if (!echoTargets.has(e.from)) echoTargets.set(e.from, { node: fromNode, homes: new Set(), aliases });
    echoTargets.get(e.from)!.homes.add(filePath);
  }

  const authorityEchoes: AuthorityEcho[] = [];
  if (echoTargets.size > 0) {
    // 追加行の収集: files モードは全文 = 全行、diff/worktree は git diff の + 行
    // (worktree では diff に出ない実在ファイル = untracked を全文で補完)。
    const echoScanPaths = paths.filter((p) => !p.endsWith(".md") && !p.split("/").includes(".graphrag"));
    let addedByPath = new Map<string, { line: number; text: string }[]>();
    try {
      if (options.inputSource === "files") {
        for (const rel of echoScanPaths) {
          if (!fileExists(options.root, rel)) continue;
          try {
            addedByPath.set(rel, readFile(options.root, rel).split("\n").map((text, i) => ({ line: i + 1, text })));
          } catch { /* unreadable — skip */ }
        }
      } else {
        const gitAddedLines = deps.gitAddedLines ?? defaultGitAddedLines;
        addedByPath = gitAddedLines(options.root, options.inputSource === "diff" ? (options.diffRange ?? null) : null, echoScanPaths);
        if (options.inputSource === "worktree") {
          for (const rel of echoScanPaths) {
            if (addedByPath.has(rel) || !fileExists(options.root, rel)) continue;
            try {
              addedByPath.set(rel, readFile(options.root, rel).split("\n").map((text, i) => ({ line: i + 1, text })));
            } catch { /* unreadable — skip */ }
          }
        }
      }
    } catch {
      addedByPath = new Map(); // git 不能環境では echo を静かに諦める (他の検査は生きる)
    }

    const ECHO_CAP = 10;
    const ECHO_OCCURRENCE_CAP = 5;
    for (const [knowledgeId, target] of echoTargets) {
      for (const alias of target.aliases) {
        const occurrences: { path: string; line: number; text: string }[] = [];
        for (const [rel, lines] of addedByPath) {
          if (target.homes.has(rel)) continue; // 家の中は権威自身の変更 — echo ではない
          for (const { line, text } of lines) {
            if (lineHasToken(text, alias)) occurrences.push({ path: rel, line, text: truncate(text.trim(), 120) });
          }
        }
        if (occurrences.length === 0) continue;
        const type = canonicalType(target.node.type as string) ?? String(target.node.type);
        authorityEchoes.push({
          alias,
          knowledge_id: knowledgeId,
          knowledge_type: type,
          title: String(target.node.title ?? knowledgeId),
          authority_paths: [...target.homes].sort(),
          occurrences: occurrences.slice(0, ECHO_OCCURRENCE_CAP),
          ...(occurrences.length > ECHO_OCCURRENCE_CAP ? { occurrences_overflow: occurrences.length - ECHO_OCCURRENCE_CAP } : {})
        });
      }
    }
    authorityEchoes.sort((a, b) => b.occurrences.length - a.occurrences.length || a.knowledge_id.localeCompare(b.knowledge_id));
    authorityEchoes.splice(ECHO_CAP);
  }

  // ── marker_findings: 変更ファイル内マーカーの参照先生存検証 ─────────────────
  // .md と .graphrag/ 配下は走査しない (文書中のコード例・vault 本文の引用を誤検出しない —
  // constraint-check / grepMarkersInRepo と同じ除外規約)。
  const markerHits = [];
  for (const rel of paths) {
    if (rel.endsWith(".md") || rel.split("/").includes(".graphrag")) continue;
    if (!fileExists(options.root, rel)) continue; // 削除された diff ファイルは走査しない
    let content: string;
    try {
      content = readFile(options.root, rel);
    } catch {
      continue; // 読めないファイル (permission / binary) は無音で飛ばす — gate ではない
    }
    markerHits.push(...scanMarkersInContent(rel, content));
  }
  const markerFindings = verifyMarkerRefs(markerHits, graph, options.vaultDir);

  // ── placement_findings: frame-check の高精度2判定を転載 ─────────────────────
  // entries (per-file 地図) は載せない — 出力契約を薄く保つ。地図が要る時は frame-check 直呼び。
  const frame = frameCheck(
    { vaultDir: options.vaultDir, root: options.root, paths, inputSource: options.inputSource },
    deps
  );
  const placementFindings = frame.findings;

  const warn = markerFindings.length + placementFindings.length;
  const hasInfo = connected.length > 0 || authorityEchoes.length > 0;
  const status: DeltaCheckResult["status"] = warn > 0 ? "warn" : hasInfo ? "info" : "clean";
  const infoParts = [
    ...(connected.length > 0 ? [`${connected.length} knowledge node(s) wired to this diff`] : []),
    ...(authorityEchoes.length > 0 ? [`${authorityEchoes.length} authority echo(es) — registered vocabulary added outside its home`] : [])
  ];
  const summary =
    status === "clean"
      ? `clean — no registered knowledge is wired to this diff (${paths.length} file(s) checked)`
      : status === "info"
        ? `${infoParts.join(" + ")} — read before committing`
        : `${warn} finding(s) (${markerFindings.length} marker, ${placementFindings.length} placement)` +
          (infoParts.length > 0 ? ` + ${infoParts.join(" + ")}` : "");

  return {
    generated_by: "graphrag/delta-check.ts",
    vault_dir: options.vaultDir,
    root: options.root,
    input_source: options.inputSource,
    status,
    summary,
    connected_knowledge: connected,
    authority_echoes: authorityEchoes,
    marker_findings: markerFindings,
    placement_findings: placementFindings,
    counts: {
      inputs: paths.length,
      connected: connected.length,
      connected_overflow: connectedOverflow,
      authority_echoes: authorityEchoes.length,
      marker_findings: markerFindings.length,
      placement_findings: placementFindings.length
    },
    note:
      "Read-only, deterministic reverse lookup (no embedding). connected_knowledge is a reading list, not a " +
      "diagnosis — it means these registered decisions/constraints/burns touch the files you changed. " +
      "authority_echoes flags registered authority vocabulary (node aliases) added outside its home files — " +
      "a legitimate import and a re-implementation both trigger it; the added line is attached so you can tell " +
      "which one you just wrote. 'clean' means no registered knowledge is WIRED to this diff, not that the " +
      "diff is safe: knowledge without edges cannot appear here. Wiring the checks themselves is " +
      "constraint-check's territory; the per-file placement map is frame-check's."
  };
}

function parseArgs(argv: string[]) {
  const p: Record<string, any> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) {
      if (p[k] === undefined) p[k] = v;
      else p[k] = Array.isArray(p[k]) ? [...p[k], v] : [p[k], v];
      i += 1;
    } else p[k] = true;
  }
  const files = p.files === undefined
    ? undefined
    : (Array.isArray(p.files) ? p.files : [p.files]).flatMap((s: string) => s.split(",")).map((s: string) => s.trim()).filter(Boolean);
  return {
    vault: typeof p.vault === "string" ? p.vault : process.env.GRAPHRAG_VAULT_DIR,
    root: typeof p.root === "string" ? p.root : process.cwd(),
    files,
    diff: typeof p.diff === "string" ? p.diff : undefined,
    strict: p.strict === true
  };
}

export function runDeltaCheck(
  argv: string[] = process.argv.slice(2),
  deps: DeltaCheckDeps = {}
): DeltaCheckResult {
  const args = parseArgs(argv);
  if (!args.vault) {
    throw new Error("delta-check requires a vault: pass --vault <dir> or set GRAPHRAG_VAULT_DIR");
  }
  let paths: string[];
  let inputSource: "files" | "diff" | "worktree";
  if (args.files && args.files.length > 0) {
    paths = args.files;
    inputSource = "files";
  } else if (args.diff) {
    paths = (deps.gitDiffPaths ?? defaultGitDiffPaths)(args.root, args.diff);
    inputSource = "diff";
  } else {
    paths = (deps.gitWorktreePaths ?? defaultGitWorktreePaths)(args.root);
    inputSource = "worktree";
  }
  const result = deltaCheck(
    { vaultDir: args.vault, root: args.root, paths, inputSource, ...(args.diff ? { diffRange: args.diff } : {}) },
    deps
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // 出力契約: findings (warn) のみ --strict で exit 1。info (読むべき見出しがある) は失敗ではない。
  process.exitCode = args.strict && result.status === "warn" ? 1 : 0;
  return result;
}

function isMainModule(url: string): boolean {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
if (isMainModule(import.meta.url)) {
  runDeltaCheck();
}

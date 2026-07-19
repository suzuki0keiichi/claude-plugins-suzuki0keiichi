#!/usr/bin/env node
// Proactive Persistence リマインダ + commit 境界の読みの導線 (PreToolUse / Bash)。
//
// stdin の hook 入力 JSON を読み、コマンドが git commit を含む時だけ additionalContext を注入する。
// 2つの成分:
//   (1) 書き戻し促し (従来): 採用判断/却下案/リスク/運用ハマりの write-back チェック。常に出す。
//   (2) 読みの導線 (delta-check 同乗): いま commit しようとしている変更ファイルに エッジで
//       繋がる登記済み知識の見出しと、マーカー/配置の所見。**見せる価値がある時だけ**
//       (clean なら成分ゼロ = 従来文言のみ)。知識が正本側に在っても破る側の作業経路上に
//       届かない、という VDU/MOT の実測ギャップへの手当て — commit の瞬間は、その diff に
//       繋がる知識を読む最後で最良のタイミング。
//
// 常に allow (deny しない)。vault 無し / git 無し / CLI 失敗 / タイムアウトは全て (2) を
// 無音で落とし、(1) だけ出す。依存ゼロの素 node (spawn する CLI 側が strip-types を持つ)。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 引用符内 (コミットメッセージ等) の "git commit" に誤爆しないよう、
// 判定前にクォート文字列を潰す。完璧なシェル解析は不要 (単語境界程度の堅さでよい)。
const stripQuoted = (command) =>
  command.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'[^']*'/g, "''");

// git (グローバルオプション任意) commit を単語境界で検出。
// "git commitlint" や "mygit commit" には反応しない。-C <dir> / -c <k=v> 形式の介在は許容。
const GIT_COMMIT_RE = /\bgit(?:\s+-[Cc]\s+\S+|\s+-\S+)*\s+commit\b/;

export const isGitCommitCommand = (command) =>
  typeof command === "string" && GIT_COMMIT_RE.test(stripQuoted(command));

// `git -C <dir> commit` = cwd と別の場所への commit。delta-check は cwd 基準で root を
// 解決するため、この形では「別 repo の diff で読みの導線」を作りかねない — 検出と検査
// 対象の非対称を仕様化するより、非対称になるケースで黙る (write-back 促しのみ出す)。
const GIT_DASH_C_RE = /\bgit\s+-C\s+\S+/i;

export const commitsOutsideCwd = (command) =>
  typeof command === "string" && GIT_DASH_C_RE.test(stripQuoted(command));

const WRITE_BACK_TEXT =
  "<graphrag write-back check, on commit boundary: (1) Have you written back the adoption decision behind this change, the alternatives you rejected, the risks you hit, and the operational gotchas? If not, write them back via add-* right after the commit (run the duplicate pre-check first). (2) If you wrote or said \"later\" / \"in a separate step\" / \"Step N\" anywhere in this change, that IS deferred work — register it now as a Goal (state: planned) or it dies with this session. (3) If this focus is now settled, include an op:update setting its active Investigation to state:closed in the same write-back plan — no other natural closing trigger exists; this commit boundary IS the closing moment.>";

// ── delta-check 同乗 ─────────────────────────────────────────────────────────

// cwd の祖先方向に .graphrag (vault/ か .env を持つ) を探す = graphrag リポジトリ判定。
// git 境界 (メイン checkout の .git ディレクトリ / linked worktree の .git ファイル) を
// 越えて探索しない: .graphrag は通常 gitignore されるので linked worktree には存在せず、
// 境界を越えると親 checkout に到達して「別の working tree の diff」で読みの導線を
// 作ってしまう (メインが clean なら偽 clean、dirty なら無関係な見出し)。worktree に
// .graphrag が無ければ無音が正しい。
// なお cwd が git repo の外なら .git に出会わないので従来どおり無制限に walk する
// (repo 外からの利用は従来互換)。非サポートになるのは「git repo 内で、toplevel より
// 上の親ディレクトリに .graphrag を置く」配置のみ (意図的 — それは別 repo の vault)。
export const findRepoRoot = (startDir) => {
  let dir = startDir;
  for (;;) {
    const anchor = path.join(dir, ".graphrag");
    if (existsSync(path.join(anchor, "vault")) || existsSync(path.join(anchor, ".env"))) return dir;
    if (existsSync(path.join(dir, ".git"))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

// delta-check 実行 (テスト DI: GRAPHRAG_DELTA_CHECK_CLI にスタブ .mjs を指せる)。
// commit されるのは staged だが、worktree デフォルト (HEAD 比較 + untracked) で近似する —
// commit 直前の worktree は staged とほぼ一致し、広めに見る分には読みの導線として害がない。
const runDeltaCheck = (root) => {
  const stub = process.env.GRAPHRAG_DELTA_CHECK_CLI;
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const argv = stub
    ? [stub]
    : ["--experimental-strip-types", path.join(pluginRoot, "graphrag", "cli.ts"), "delta-check", "--root", root];
  const out = execFileSync(process.execPath, argv, {
    encoding: "utf8",
    cwd: root,
    // hooks.json の外側 timeout (10s) より内側が先に諦める: 同値だと遅いテールで
    // delta 成分どころか従来の write-back 促しごと harness に殺される。
    timeout: 8000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
  return JSON.parse(out);
};

const HEADLINE_LINES_CAP = 10;

// 見せる価値がある時だけ非 null (clean なら null = 従来文言のみ)。
export const composeDeltaInjection = (result) => {
  if (!result || result.status === "clean") return null;
  const lines = [];

  const connected = Array.isArray(result.connected_knowledge) ? result.connected_knowledge : [];
  if (connected.length > 0) {
    lines.push(
      `${connected.length} registered knowledge node(s) are wired to the files you are committing — read before you commit:`
    );
    for (const k of connected.slice(0, HEADLINE_LINES_CAP)) {
      const state = k.state ? ` [${k.state}]` : "";
      const via = Array.isArray(k.via) && k.via.length > 0 ? ` (${k.via[0].edge} ${k.via[0].path})` : "";
      lines.push(`- ${k.type}${state} ${k.id}: ${k.title}${k.headline ? ` — ${k.headline}` : ""}${via}`);
    }
    const hidden = connected.length - Math.min(connected.length, HEADLINE_LINES_CAP) + (result.counts?.connected_overflow ?? 0);
    if (hidden > 0) lines.push(`(+${hidden} more — run delta-check for the full list)`);
  }

  const echoes = Array.isArray(result.authority_echoes) ? result.authority_echoes : [];
  if (echoes.length > 0) {
    lines.push(
      `${echoes.length} authority echo(es) — vocabulary of a registered authority appears in your added lines outside its home files. If you just re-implemented what the authority owns, use the authority instead:`
    );
    for (const e of echoes.slice(0, HEADLINE_LINES_CAP)) {
      const occ = Array.isArray(e.occurrences) && e.occurrences[0] ? e.occurrences[0] : null;
      lines.push(
        `- "${e.alias}" belongs to ${e.knowledge_id} ("${e.title}", home: ${(e.authority_paths ?? []).join(", ")})` +
          (occ ? ` — added at ${occ.path}:${occ.line}: ${occ.text}` : "")
      );
    }
  }

  const findings = [
    ...(Array.isArray(result.marker_findings) ? result.marker_findings : []),
    ...(Array.isArray(result.placement_findings) ? result.placement_findings : [])
  ];
  if (findings.length > 0) {
    lines.push(`${findings.length} wiring finding(s) in this diff (markers / placement):`);
    for (const f of findings.slice(0, HEADLINE_LINES_CAP)) {
      lines.push(`- ${f.detail}`);
    }
    lines.push("(run `delta-check` for per-finding next_step prescriptions)");
  }

  if (lines.length === 0) return null;
  return `<graphrag delta check, knowledge wired to this diff>\n${lines.join("\n")}\n</graphrag delta check>`;
};

// ── main ─────────────────────────────────────────────────────────────────────

const main = async () => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (!isGitCommitCommand(input?.tool_input?.command)) return;

  let deltaText = null;
  try {
    // git -C <dir> の commit は cwd と別の場所 — 誤った repo の読み物を注入するより黙る。
    if (!commitsOutsideCwd(input?.tool_input?.command)) {
      const startDir = typeof input?.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();
      const root = findRepoRoot(path.resolve(startDir));
      if (root) deltaText = composeDeltaInjection(runDeltaCheck(root));
    }
  } catch {
    // 読みの導線は完全にベストエフォート — 失敗は無音で書き戻し促しだけ出す
  }

  const additionalContext = deltaText ? `${deltaText}\n${WRITE_BACK_TEXT}` : WRITE_BACK_TEXT;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext }
    }) + "\n"
  );
};

// テストから composeDeltaInjection / isGitCommitCommand を import できるよう、直接実行時のみ main を回す。
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch {
    // 何があってもブロックしない — 無音で正常終了
  }
  process.exit(0);
}

#!/usr/bin/env node
// 配置の地図 (PostToolUse / Write)。
// エージェントが「新規」実装ファイルを作ったその場で、そのパスの局所地図
// (どの Component の縄張りか / 未登記の山が閾値を超えたか) を additionalContext に注入する。
// 裁かない: 無所属は正当 (小さいクラスタは Component を彫らない — carving の思想) なので、
// 注入するのは「見せる価値がある地図」がある時だけ。何も無ければ完全に無音。
// 常に非ブロッキング — vault 無し / git 無し / CLI 失敗は全て無音で正常終了。
// 依存ゼロの素 node (spawn する CLI 側が strip-types を持つ)。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── gates (安いものから順に) ─────────────────────────────────────────────────

// 実装拡張子の近似 (crosscut-map.ts の IMPL_EXTENSIONS と同義。hook は .ts を import
// できないため写しを持つ — ずれても安全側: CLI 側の non-impl 判定が最終判断)。
const IMPL_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|c|cc|cpp|h|hpp|m|mm|swift|scala|sh|bash|zsh|pl|lua|sql)$/i;

const isImplPath = (p) => typeof p === "string" && IMPL_EXT_RE.test(p) && !p.endsWith(".d.ts");

// tool_response から「新規作成」を推定。判定不能 (フィールド欠落) は進む (CLI 側の
// registered 判定が既存ファイルを無音に落とす)。明確に更新なら終了。
const looksLikeCreation = (toolResponse) => {
  if (toolResponse === undefined || toolResponse === null) return true;
  const s = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);
  if (/creat/i.test(s)) return true;
  if (/update/i.test(s)) return false;
  return true;
};

// file の祖先方向に .graphrag (vault/ か .env を持つ) を探す = graphrag リポジトリ判定。
// git 境界 (.git ディレクトリ/ファイル) を越えない — linked worktree で親 checkout の
// vault に到達すると別ツリー基準の地図を注入してしまう (proactive-persistence-reminder
// と同じ理由)。worktree に .graphrag が無ければ無音が正しい。
const findRepoRoot = (fileDir) => {
  let dir = fileDir;
  for (;;) {
    const anchor = path.join(dir, ".graphrag");
    if (existsSync(path.join(anchor, "vault")) || existsSync(path.join(anchor, ".env"))) return dir;
    if (existsSync(path.join(dir, ".git"))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

// ── frame-check 実行 (テスト DI: GRAPHRAG_FRAME_MAP_CLI にスタブ .mjs を指せる) ──

const runFrameCheck = (root, relPath) => {
  const stub = process.env.GRAPHRAG_FRAME_MAP_CLI;
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const argv = stub
    ? [stub]
    : ["--experimental-strip-types", path.join(pluginRoot, "graphrag", "cli.ts"), "frame-check", "--files", relPath, "--root", root];
  const out = execFileSync(process.execPath, argv, {
    encoding: "utf8",
    cwd: root,
    timeout: 12000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
  return JSON.parse(out);
};

// ── 注入文の組み立て (見せる価値がある時だけ非 null) ─────────────────────────

export const composeInjection = (result, relPath) => {
  const entry = (result?.entries ?? []).find((e) => e?.path === relPath);
  if (!entry) return null;
  // 登記済み / 免除 / 非実装 は言うことが無い
  if (entry.status === "registered" || entry.status === "exempt" || entry.status === "non-impl") return null;

  const findings = result?.findings ?? [];
  const unwired = findings.find((f) => f.kind === "in-footprint-unwired" && f.file_path === relPath);
  const cluster = findings.find((f) => f.kind === "component-candidate" && relPath.startsWith(`${f.dir}/`));
  const claimants = entry.claimants ?? [];

  const lines = [];
  if (unwired) {
    lines.push(
      `You just created ${relPath} inside the home directory of ${claimants[0]?.id ?? "a registered Component"} ` +
        `("${claimants[0]?.title ?? ""}") without wiring it. Decide consciously: it belongs there (wire it — ` +
        "run frame-check for a paste-ready plan_fragment), it belongs elsewhere (move it now while it is cheap), " +
        "or it is genuinely frameless (fine — exempt with a reason via carving-allow)."
    );
  } else if (claimants.length > 0) {
    const list = claimants.slice(0, 3).map((c) => `${c.id} "${c.title}" (${c.dir_members} files here)`).join(" / ");
    lines.push(
      `Local map for ${relPath}: registered structure sharing this directory — ${list}. ` +
        "If the new code belongs to one of these, keep it in that frame (wire via evidenced_by); " +
        "a genuinely new concept deserves its own registration instead of squatting."
    );
  }
  if (cluster) {
    lines.push(cluster.detail + " " + cluster.next_step);
  }
  if (lines.length === 0) return null; // 無所属で周りに構造も無い = 正当。無音。
  return `<graphrag frame map>\n${lines.join("\n")}\n</graphrag frame map>`;
};

// ── main ─────────────────────────────────────────────────────────────────────

const main = async () => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (input?.tool_name !== "Write") return;
  const filePath = input?.tool_input?.file_path;
  if (!isImplPath(filePath)) return;
  if (!looksLikeCreation(input?.tool_response)) return;

  const abs = path.resolve(filePath);
  const root = findRepoRoot(path.dirname(abs));
  if (!root) return;
  const relPath = path.relative(root, abs).split(path.sep).join("/");
  if (relPath.startsWith("..")) return;

  const result = runFrameCheck(root, relPath);
  const context = composeInjection(result, relPath);
  if (!context) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context }
    }) + "\n"
  );
};

// テストから composeInjection を import できるよう、直接実行時のみ main を回す。
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch {
    // 何があってもブロックしない — 無音で正常終了
  }
  process.exit(0);
}

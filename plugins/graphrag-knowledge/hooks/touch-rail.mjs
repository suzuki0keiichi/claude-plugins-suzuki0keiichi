#!/usr/bin/env node
// ファイル接触時の読みレール (PreToolUse / Edit|Write)。
// これから編集するファイルに配線済みの知識 (constrains / documented_by / sets_policy_for /
// enforced_by / risks_in の逆引き) を、編集が着地する前に additionalContext で届ける。
// セッション後半のドリフト (エージェント単独のツールループにはユーザープロンプトが無く、
// prompt レールが届かない) の受け皿 — 編集は必ず起きるので、そこに記憶を敷く。
// 判定・dedup・ログは CLI 側 (graphrag/rail-touch.ts)。ここは薄い spawn ラッパ +
// 「同一ファイルは同一セッションで一度だけ」の fast-path (seen ファイルを直接読み、
// 既読なら spawn せず即終了 — 毎編集にコストを払わない)。
// 既定 off: GRAPHRAG_RAIL_TOUCH=on (シェル env または .graphrag/.env) で opt-in。
// 常に非ブロッキング — vault 無し / off / CLI 失敗は全て無音で正常終了 (編集は必ず通る)。
// 依存ゼロの素 node (spawn する CLI 側が strip-types を持つ)。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { railEnabled } from "./prompt-rail.mjs";

// 実装拡張子の近似 (frame-map と同じ写し)。read-rail からも import される。
const IMPL_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|c|cc|cpp|h|hpp|m|mm|swift|scala|sh|bash|zsh|pl|lua|sql)$/i;
export const isImplPath = (p) => typeof p === "string" && IMPL_EXT_RE.test(p) && !p.endsWith(".d.ts");

// file の祖先方向に .graphrag を探す (frame-map と同じ: git 境界を越えない)。
export const findRepoRoot = (fileDir) => {
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

// 書き手 (rail-touch verb の cacheDirForVault) と同じ規則で seen ファイルの置き場所を解決する
// (clear-restore と同じ依存ゼロ複製): シェル env → anchor の .graphrag/.env の GRAPHRAG_VAULT_DIR
// → ローカル既定。vault 親を .graphrag に正規化し、その下の cache/。
export const resolveVaultDir = (anchorDir) => {
  const fromEnv = process.env.GRAPHRAG_VAULT_DIR;
  if (typeof fromEnv === "string" && fromEnv !== "") return path.resolve(anchorDir, fromEnv);
  try {
    const envPath = path.join(anchorDir, ".graphrag", ".env");
    if (existsSync(envPath)) {
      for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
        const m = /^GRAPHRAG_VAULT_DIR\s*=\s*(.*)$/.exec(body);
        if (!m) continue;
        let value = m[1].trim();
        if (
          (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
          (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
        ) {
          value = value.slice(1, -1);
        }
        if (value) return path.resolve(anchorDir, value);
      }
    }
  } catch {
    // 読めなければローカル既定へ
  }
  return path.join(anchorDir, ".graphrag", "vault");
};

const seenPath = (vaultDir, sessionId) => {
  let stateDir = path.dirname(path.resolve(vaultDir));
  if (path.basename(stateDir) !== ".graphrag") stateDir = path.join(stateDir, ".graphrag");
  return path.join(stateDir, "cache", `rail-seen-${sessionId}.json`);
};

export const sanitizeSessionId = (raw) => {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  return s.length > 0 ? s : null;
};

// fast-path: seen を直接読んで既読なら spawn しない。読めない/壊れているは「未読」扱い
// (CLI 側の seen 判定が最終防衛 — ここは節約であって正しさの根拠ではない)。
// listKey: touch レールは touched_files、read レールは read_files を見る。
export const seenListIncludes = (vaultDir, sessionId, listKey, relPath) => {
  try {
    const fp = seenPath(vaultDir, sessionId);
    if (!existsSync(fp)) return false;
    const parsed = JSON.parse(readFileSync(fp, "utf8"));
    return Array.isArray(parsed?.[listKey]) && parsed[listKey].includes(relPath);
  } catch {
    return false;
  }
};

export const alreadyTouched = (vaultDir, sessionId, relPath) =>
  seenListIncludes(vaultDir, sessionId, "touched_files", relPath);

// ── rail-touch 実行 (テスト DI: GRAPHRAG_TOUCH_RAIL_CLI にスタブ .mjs を指せる) ──

const runRailTouch = (root, relPath, sessionId) => {
  const stub = process.env.GRAPHRAG_TOUCH_RAIL_CLI;
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const argv = stub
    ? [stub]
    : ["--experimental-strip-types", path.join(pluginRoot, "graphrag", "cli.ts"), "rail-touch", "--file", relPath,
       ...(sessionId ? ["--session", sessionId] : [])];
  const out = execFileSync(process.execPath, argv, {
    encoding: "utf8",
    cwd: root,
    timeout: 12000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
  return JSON.parse(out);
};

const main = async () => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (input?.tool_name !== "Edit" && input?.tool_name !== "Write") return;
  const filePath = input?.tool_input?.file_path;
  if (!isImplPath(filePath)) return;

  const abs = path.resolve(filePath);
  const root = findRepoRoot(path.dirname(abs));
  if (!root) return;
  if (!railEnabled("GRAPHRAG_RAIL_TOUCH", root)) return;
  const relPath = path.relative(root, abs).split(path.sep).join("/");
  if (relPath.startsWith("..")) return;

  const sessionId = sanitizeSessionId(input?.session_id);
  if (sessionId && alreadyTouched(resolveVaultDir(root), sessionId, relPath)) return;

  const result = runRailTouch(root, relPath, sessionId);
  if (result?.status !== "inject" || typeof result?.context !== "string") return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: result.context }
    }) + "\n"
  );
};

// テストから alreadyTouched を import できるよう、直接実行時のみ main を回す。
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch {
    // 何があってもブロックしない — 無音で正常終了
  }
  process.exit(0);
}

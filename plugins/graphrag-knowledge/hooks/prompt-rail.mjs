#!/usr/bin/env node
// 課題受領時の読みレール (UserPromptSubmit)。
// ユーザープロンプトを rail-prompt verb に機械投入し、登記済み知識に高確信で当たった
// 時だけ headline を additionalContext に注入する。「着手前に引く」を skill description の
// 確率的発火から決定的機構へ移す — ハーネスの自走圧の下で最初に削られるのが
// 「取りに行く読み」なので、記憶の側を行動経路に置く。
// 判定・閾値・dedup・ログは全て CLI 側 (graphrag/rail-prompt.ts) — ここは薄い spawn ラッパ。
// 既定 off: GRAPHRAG_RAIL_PROMPT=on (シェル env または .graphrag/.env) で opt-in。
// 常に非ブロッキング — vault 無し / off / CLI 失敗は全て無音で正常終了。
// 依存ゼロの素 node (spawn する CLI 側が strip-types を持つ)。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// cwd から上方向に .graphrag (vault/ か .env を持つ) を探す。git 境界を越えない
// (linked worktree で親 checkout の vault に到達しないため — frame-map と同じ理由)。
const findAnchor = (startDir) => {
  let dir = startDir;
  for (;;) {
    const dot = path.join(dir, ".graphrag");
    if (existsSync(path.join(dot, "vault")) || existsSync(path.join(dot, ".env"))) return dir;
    if (existsSync(path.join(dir, ".git"))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

// opt-in 判定: シェル env が最優先 (on/off どちらも明示可)、無ければ anchor の
// .graphrag/.env の GRAPHRAG_RAIL_PROMPT=on。既定は off (稼働系への慎重な導入)。
export const railEnabled = (envName, anchorDir) => {
  const fromEnv = process.env[envName];
  if (typeof fromEnv === "string" && fromEnv !== "") return /^(on|1|true)$/i.test(fromEnv);
  try {
    const envPath = path.join(anchorDir, ".graphrag", ".env");
    if (existsSync(envPath)) {
      const re = new RegExp(`^\\s*${envName}\\s*=\\s*(on|1|true)\\s*$`, "im");
      return re.test(readFileSync(envPath, "utf8"));
    }
  } catch {
    // 読めなければ off
  }
  return false;
};

// ── rail-prompt 実行 (テスト DI: GRAPHRAG_PROMPT_RAIL_CLI にスタブ .mjs を指せる) ──

const runRailPrompt = (anchor, prompt, sessionId) => {
  const stub = process.env.GRAPHRAG_PROMPT_RAIL_CLI;
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const argv = stub
    ? [stub]
    : ["--experimental-strip-types", path.join(pluginRoot, "graphrag", "cli.ts"), "rail-prompt", "--stdin",
       ...(sessionId ? ["--session", sessionId] : [])];
  const out = execFileSync(process.execPath, argv, {
    encoding: "utf8",
    cwd: anchor,
    input: prompt,
    timeout: 8000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"]
  });
  return JSON.parse(out);
};

const main = async () => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const prompt = input?.prompt;
  if (typeof prompt !== "string") return;
  // 安いゲートだけここで (完全なフィルタは CLI 側が持つ): 短文とコマンドは spawn しない
  const t = prompt.trim();
  if (t.length < 15 || t.startsWith("/")) return;

  const anchor = findAnchor(input?.cwd ?? process.cwd());
  if (!anchor) return;
  if (!railEnabled("GRAPHRAG_RAIL_PROMPT", anchor)) return;

  const sessionId = typeof input?.session_id === "string" ? input.session_id : null;
  const result = runRailPrompt(anchor, prompt, sessionId);
  if (result?.status !== "inject" || typeof result?.context !== "string") return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: result.context }
    }) + "\n"
  );
};

// テストから railEnabled を import できるよう、直接実行時のみ main を回す。
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch {
    // 何があってもブロックしない — 無音で正常終了
  }
  process.exit(0);
}

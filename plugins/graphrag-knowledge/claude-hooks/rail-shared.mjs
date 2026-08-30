// rail-shared: ファイル系レール hook (touch-rail / read-rail / edit-observe) の共有部品。
// 依存ゼロの素 node。パス解決・ゲート・seen fast-path・rail-log 直接追記と、
// touch/read hook 本体の共通ランナー (runFileRailHook) の正本 — hook 側の修正が
// 片方のミラーにだけ当たる事故を構造的に防ぐ。railEnabled は prompt-rail.mjs が正本。

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { railEnabled } from "./prompt-rail.mjs";

// 実装拡張子の近似 (frame-map と同じ写し)。
const IMPL_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|c|cc|cpp|h|hpp|m|mm|swift|scala|sh|bash|zsh|pl|lua|sql)$/i;
// 依存・生成物ディレクトリは対象外 — 依存の中を読む/生成物を吐く度に vault import の
// コストを払わない (repo 相対パスで判定)。
const EXCLUDED_PATH_RE = /(^|\/)(node_modules|vendor|dist|build|\.git)\//;

export const isImplPath = (p) => typeof p === "string" && IMPL_EXT_RE.test(p) && !p.endsWith(".d.ts");
export const isExcludedRelPath = (rel) => EXCLUDED_PATH_RE.test(rel);

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

// 書き手 (CLI 側の cacheDirForVault) と同じ規則で vault の場所を解決する
// (clear-restore と同じ依存ゼロ複製): シェル env → anchor の .graphrag/.env の
// GRAPHRAG_VAULT_DIR → ローカル既定。
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

// vault 親を .graphrag に正規化し、その下の cache/ (CLI 側 cacheDirForVault の写し)。
export const cacheDirForVaultDir = (vaultDir) => {
  let stateDir = path.dirname(path.resolve(vaultDir));
  if (path.basename(stateDir) !== ".graphrag") stateDir = path.join(stateDir, ".graphrag");
  return path.join(stateDir, "cache");
};

export const sanitizeSessionId = (raw) => {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  return s.length > 0 ? s : null;
};

// fast-path: seen を直接読んで既読なら spawn しない。読めない/壊れているは「未読」扱い
// (seen 判定の正本は CLI 側 railFileLane — ここは spawn 節約であって正しさの根拠ではない)。
// 新形式 rail-seen-<session>.jsonl ({k:"file",l:"read"|"touch",f}) と
// 旧形式 rail-seen-<session>.json (read_files/touched_files 配列) の両方を見る。
export const seenListIncludes = (vaultDir, sessionId, list, relPath) => {
  const cacheDir = cacheDirForVaultDir(vaultDir);
  try {
    const fp = path.join(cacheDir, `rail-seen-${sessionId}.jsonl`);
    if (existsSync(fp)) {
      for (const line of readFileSync(fp, "utf8").split("\n")) {
        if (!line.includes('"file"')) continue;
        try {
          const e = JSON.parse(line);
          if (e?.k === "file" && e.l === list && e.f === relPath) return true;
        } catch {
          /* 壊れた行は捨てる */
        }
      }
    }
  } catch {
    /* 読めない = 未読扱い */
  }
  try {
    const legacy = path.join(cacheDir, `rail-seen-${sessionId}.json`);
    if (existsSync(legacy)) {
      const parsed = JSON.parse(readFileSync(legacy, "utf8"));
      const key = list === "read" ? "read_files" : "touched_files";
      return Array.isArray(parsed?.[key]) && parsed[key].includes(relPath);
    }
  } catch {
    /* 読めない = 未読扱い */
  }
  return false;
};

const LOG_ROTATE_BYTES = 2 * 1024 * 1024;

// rail-log.jsonl への直接追記 (spawn なし)。CLI 側 appendJsonlLog と同じ流儀:
// ローテーションと追記の try を分け、rename 失敗でも追記は続行。成否を返し throw しない。
export const appendRailLogDirect = (cacheDir, entry) => {
  const fp = path.join(cacheDir, "rail-log.jsonl");
  try {
    if (existsSync(fp) && statSync(fp).size > LOG_ROTATE_BYTES) renameSync(fp, `${fp}.1`);
  } catch {
    /* ローテーション失敗でも追記は続行 */
  }
  try {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    appendFileSync(fp, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    return true;
  } catch {
    return false;
  }
};

const readStdinJson = async () => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
};

/**
 * touch/read hook の共通本体。spec:
 *   toolNames  — 発火対象 tool_name の集合
 *   envName    — opt-in フラグ (GRAPHRAG_RAIL_TOUCH / GRAPHRAG_RAIL_READ)
 *   rail       — "touch" | "read" (seen の list 名かつ rail-log の rail 名)
 *   cliVerb    — spawn する CLI verb
 *   stubEnvVar — テスト DI: スタブ .mjs のパスを指す env 名
 *   buildOutput(context) — hookSpecificOutput の組み立て
 * 契約: 常に非ブロッキング。session id が無い時は沈黙 (dedup 不能なまま毎 Read 再注入
 * する劣化より、レール停止の方が安全)。spawn/parse 失敗は rail-log に spawn-error を
 * 直接追記してから無音終了 — 「発火も沈黙も全部記録」の脱出口を塞ぐ。
 */
export const runFileRailHook = async (spec) => {
  const input = await readStdinJson();
  if (!spec.toolNames.includes(input?.tool_name)) return;
  const filePath = input?.tool_input?.file_path;
  if (!isImplPath(filePath)) return;

  const abs = path.resolve(filePath);
  const root = findRepoRoot(path.dirname(abs));
  if (!root) return;
  if (!railEnabled(spec.envName, root)) return;
  const relPath = path.relative(root, abs).split(path.sep).join("/");
  if (relPath.startsWith("..") || isExcludedRelPath(relPath)) return;

  const sessionId = sanitizeSessionId(input?.session_id);
  if (!sessionId) return;
  const vaultDir = resolveVaultDir(root);
  if (seenListIncludes(vaultDir, sessionId, spec.rail, relPath)) return;

  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const stub = process.env[spec.stubEnvVar];
  const argv = stub
    ? [stub]
    : ["--experimental-strip-types", path.join(pluginRoot, "graphrag", "cli.ts"), spec.cliVerb,
       "--file", relPath, "--session", sessionId];
  let result;
  try {
    const out = execFileSync(process.execPath, argv, {
      encoding: "utf8",
      cwd: root,
      timeout: 12000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    result = JSON.parse(out);
  } catch (e) {
    appendRailLogDirect(cacheDirForVaultDir(vaultDir), {
      rail: spec.rail,
      file: relPath,
      fired: false,
      reason: `spawn-error: ${String(e?.message ?? e).slice(0, 120)}`,
      session: sessionId
    });
    return;
  }
  if (result?.status !== "inject" || typeof result?.context !== "string") return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: spec.buildOutput(result.context) }) + "\n");
};

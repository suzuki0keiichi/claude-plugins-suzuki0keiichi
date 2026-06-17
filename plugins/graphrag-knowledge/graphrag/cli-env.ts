import { existsSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

/**
 * .env 形式テキストを Record<string,string> にパース。
 * 対応: KEY=value / export KEY=value / "..." / '...' / # コメント / 空行。
 * 非対応 (YAGNI): 変数展開 ${VAR}、エスケープ、改行 continuation。
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!key) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * parsed の各エントリを process.env に反映。
 * 既に process.env に存在する (かつ非空の) キーは上書きしない。
 * → CLI flag / シェル env を優先する。
 */
export function applyDotEnv(parsed: Record<string, string>): void {
  for (const [key, value] of Object.entries(parsed)) {
    const existing = process.env[key];
    if (existing !== undefined && existing !== "") continue;
    process.env[key] = value;
  }
}

/**
 * cwd から `.env` を探して読み、parse して applyDotEnv する。
 * .env が無ければ no-op (エラーにしない)。
 */
export function loadDotEnvFromCwd(cwd: string = process.cwd()): void {
  const dotEnvPath = path.join(cwd, ".env");
  if (!existsSync(dotEnvPath)) return;
  const text = readFileSync(dotEnvPath, "utf8");
  applyDotEnv(parseDotEnv(text));
}

/**
 * cwd から上方向へ `.graphrag/.env` を探し、見つけたら applyDotEnv する。
 *
 * graphrag 専用の env ファイル。プロジェクトの `.env` と分離できるので
 * 他ツールと干渉しない。worktree・サブディレクトリからでも親の
 * `.graphrag/.env` を拾えるよう walk-up する。
 *
 * 典型: vault が外部リポジトリにある時に
 *   GRAPHRAG_VAULT_DIR=/path/to/other-repo/.graphrag/vault
 * と書いておく。gitignore に `.graphrag/.env` を足せばリポには残らない。
 */
export function discoverAndLoadGraphragEnv(cwd: string = process.cwd()): void {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, ".graphrag", ".env");
    if (existsSync(candidate) && !statSync(candidate).isDirectory()) {
      const text = readFileSync(candidate, "utf8");
      applyDotEnv(parseDotEnv(text));
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

// ── vault isolation detection ──────────────────────────────────

export type VaultMode = "readonly" | "direct";

export interface VaultIsolation {
  in_worktree: boolean;
  vault_external: boolean;
  mode: VaultMode | null;
  message: string | null;
}

function gitToplevel(dir: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch { return null; }
}

function isWorktree(dir: string): boolean {
  const dotGit = path.join(dir, ".git");
  if (!existsSync(dotGit)) return false;
  try {
    return statSync(dotGit).isFile();
  } catch { return false; }
}

/**
 * cwd と vault の関係を検出し、vault_mode を判定する。
 *
 * - in_worktree: cwd が git worktree (.git がファイル) かどうか
 * - vault_external: vault が cwd と同じ git リポジトリに属さないかどうか
 * - mode: GRAPHRAG_VAULT_MODE env (readonly | direct | null=未設定)
 * - message: LLM に伝えるべき状況説明 (問題なければ null)
 *
 * mode が未設定かつ vault が外部の場合のみ message を生成する。
 * mode が設定済みなら CLI がそれに従うため、LLM への確認は不要。
 */
export function detectVaultIsolation(cwd: string = process.cwd()): VaultIsolation {
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  const rawMode = process.env.GRAPHRAG_VAULT_MODE;
  const mode: VaultMode | null =
    rawMode === "readonly" ? "readonly" :
    rawMode === "direct" ? "direct" : null;

  const worktree = isWorktree(cwd);
  if (!vaultDir) {
    return { in_worktree: worktree, vault_external: false, mode, message: null };
  }

  const cwdRepo = gitToplevel(cwd);
  const vaultRepo = gitToplevel(vaultDir);
  const external = !!(cwdRepo && vaultRepo && cwdRepo !== vaultRepo);

  let message: string | null = null;
  if (external && mode === null) {
    message =
      `vault is external (${vaultDir} — repo: ${vaultRepo}), ` +
      `but GRAPHRAG_VAULT_MODE is not configured. ` +
      `Ask the user: set GRAPHRAG_VAULT_MODE=readonly (read only, no writes) ` +
      `or GRAPHRAG_VAULT_MODE=direct (write to shared vault as-is) ` +
      `in .graphrag/.env, then retry.`;
  }

  return { in_worktree: worktree, vault_external: external, mode, message };
}

/**
 * `GRAPHRAG_VAULT_DIR` が (env / .env で) 未設定の時に限り、cwd から上方向へ
 * `.graphrag/vault` ディレクトリを探し、見つかれば process.env に焼く。
 *
 * 狙い: root `.env` に依存せず「素で `ask` が通る」状態を作る (graphrag 自身の
 * 名前空間 `.graphrag/vault` を発見規約にするので、利用先の他ツール `.env` と干渉しない)。
 * クロスプラットフォーム (Node の path で上方向探索するだけ)。
 *
 * 不可分原則は維持: どこにも `.graphrag/vault` が無ければ no-op (未設定のまま) →
 * 各 verb が従来どおり大声でエラー停止する。lexical fallback や当て推量はしない。
 */
export function discoverVaultDir(cwd: string = process.cwd()): void {
  const existing = process.env.GRAPHRAG_VAULT_DIR;
  if (existing !== undefined && existing !== "") return;
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, ".graphrag", "vault");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      process.env.GRAPHRAG_VAULT_DIR = candidate;
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return; // ファイルシステム root に到達
    dir = parent;
  }
}

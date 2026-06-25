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

function isFile(p: string): boolean {
  try { return existsSync(p) && !statSync(p).isDirectory(); }
  catch { return false; }
}

function isDir(p: string): boolean {
  try { return existsSync(p) && statSync(p).isDirectory(); }
  catch { return false; }
}

/**
 * cwd から上方向へ、graphrag の「アクティブな root」を探す。
 * root = 最も近い `.graphrag/` で、`.env` か `vault/` の少なくとも一方を持つもの。
 *
 * worktree や subdir に自前の `.graphrag/vault` があれば、たとえ `.env` を
 * 持たなくてもそこが root になる。これにより親の `.graphrag/.env` が
 * ローカルの vault を覆い隠す事故 (#14) を防ぐ — closest-wins。
 */
function findGraphragRoot(cwd: string): { dir: string; hasEnv: boolean; hasVault: boolean } | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const graphragDir = path.join(dir, ".graphrag");
    const hasEnv = isFile(path.join(graphragDir, ".env"));
    const hasVault = isDir(path.join(graphragDir, "vault"));
    if (hasEnv || hasVault) return { dir: graphragDir, hasEnv, hasVault };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
 *
 * closest-wins (#14): 最も近い `.graphrag/` root が `vault/` を持つのに
 * `.env` を持たない場合、親の `.graphrag/.env` までは降りない。ローカルの
 * vault がアクティブなので、親の設定を継承して上書きしてはいけない
 * (worktree はそれぞれ独立した root)。
 */
export function discoverAndLoadGraphragEnv(cwd: string = process.cwd()): void {
  const root = findGraphragRoot(cwd);
  if (!root || !root.hasEnv) return;
  const text = readFileSync(path.join(root.dir, ".env"), "utf8");
  applyDotEnv(parseDotEnv(text));
}

// ── vault isolation detection ──────────────────────────────────

export type VaultMode = "readonly" | "direct" | "worktree";

export interface VaultIsolation {
  in_worktree: boolean;
  vault_external: boolean;
  mode: VaultMode | null;
  mode_source: "local" | "inherited" | "none";
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

function parseVaultMode(raw: string | undefined): VaultMode | null {
  if (raw === "readonly") return "readonly";
  if (raw === "direct") return "direct";
  if (raw === "worktree") return "worktree";
  return null;
}

/**
 * cwd 直下の `.graphrag/.env` から GRAPHRAG_VAULT_MODE を読む。
 * walk-up で親から継承された process.env の値は使わない。
 * mode はワークツリーごとの意思決定なので、cwd ローカルの設定だけが有効。
 */
function readLocalVaultMode(cwd: string): { mode: VaultMode | null; source: "local" | "inherited" | "none" } {
  const localEnvPath = path.join(cwd, ".graphrag", ".env");
  if (existsSync(localEnvPath) && !statSync(localEnvPath).isDirectory()) {
    const parsed = parseDotEnv(readFileSync(localEnvPath, "utf8"));
    const mode = parseVaultMode(parsed["GRAPHRAG_VAULT_MODE"]);
    if (mode !== null) return { mode, source: "local" };
  }
  const envMode = parseVaultMode(process.env.GRAPHRAG_VAULT_MODE);
  if (envMode !== null) return { mode: envMode, source: "inherited" };
  return { mode: null, source: "none" };
}

/**
 * cwd と vault の関係を検出し、vault_mode を判定する。
 *
 * mode の判定は cwd 直下の `.graphrag/.env` を優先。
 * walk-up で親から拾った process.env の GRAPHRAG_VAULT_MODE は
 * mode_source: "inherited" として区別し、外部 vault の場合は
 * inherited mode でも安全ゲートを通す（ローカル設定を要求する）。
 */
export function detectVaultIsolation(cwd: string = process.cwd()): VaultIsolation {
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  const { mode, source } = readLocalVaultMode(cwd);

  const worktree = isWorktree(cwd);
  if (!vaultDir) {
    return { in_worktree: worktree, vault_external: false, mode, mode_source: source, message: null };
  }

  const cwdRepo = gitToplevel(cwd);
  const vaultRepo = gitToplevel(vaultDir);
  const external = !!(cwdRepo && vaultRepo && cwdRepo !== vaultRepo);

  const needsLocalDecision = external && source !== "local";

  let message: string | null = null;
  if (needsLocalDecision) {
    message =
      `vault is external (${vaultDir}). ` +
      (source === "inherited"
        ? `GRAPHRAG_VAULT_MODE=${mode} is inherited from a parent directory, but each worktree needs its own decision. `
        : `GRAPHRAG_VAULT_MODE is not configured. `) +
      `Set GRAPHRAG_VAULT_MODE in this directory's .graphrag/.env (${path.join(cwd, ".graphrag", ".env")}).`;
  }

  return {
    in_worktree: worktree,
    vault_external: external,
    mode: needsLocalDecision ? null : mode,
    mode_source: source,
    message
  };
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

import { existsSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
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
 * baseDir 直下の state dir (`.graphrag`) を冪等に返す。
 *
 * baseDir が既に `.graphrag` ならそれ自身を返す。これを欠くと
 * `<root>/.graphrag` を baseDir に渡したとき `<root>/.graphrag/.graphrag` を
 * 掘ってしまう (carving-config.resolveCarvingConfigPath と同じ防御)。
 */
export function stateDirUnder(baseDir: string): string {
  const abs = path.resolve(baseDir);
  if (path.basename(abs) === ".graphrag") return abs;
  return path.join(abs, ".graphrag");
}

/**
 * vault dir を保持する state dir (`.graphrag`) を冪等に解決する。
 *
 * 既定レイアウト `<root>/.graphrag/vault` では state dir は vault の親
 * (`<root>/.graphrag`) 自身。legacy/sibling レイアウト `<root>/vault` では
 * vault の隣 `<root>/.graphrag`。どちらでも vector.json / lock / call-count /
 * carving.json は単一の `.graphrag` に集約される。
 *
 * 以前は `path.join(path.dirname(vaultDir), ".graphrag")` を各所に直書きしており、
 * 既定レイアウトに対して `<root>/.graphrag/.graphrag` を量産していた。
 */
export function stateDirForVault(vaultDir: string): string {
  return stateDirUnder(path.dirname(path.resolve(vaultDir)));
}

/**
 * cwd から上方向に既存の `.graphrag` を探す。見つからなければ null。
 *
 * vault を解決できない verb (carving-allow 等) の state dir fallback 用。
 * vault ディレクトリ内から実行しても、walk-up で `<root>/.graphrag` を辿り当てる
 * (素朴な `path.join(cwd, ".graphrag")` だと `<root>/.graphrag/vault/.graphrag` を掘る)。
 *
 * 以前はどこにも無いとき cwd 直下の `.graphrag` を「候補として」返しており、
 * 呼び出し元がそこへ書くと vault も設定も無いゴミ `.graphrag` を量産していた
 * (しかもそれが以後の walk-up 発見を汚染する)。null を返し、呼び出し元は
 * state 永続化を skip するか明確にエラーで止まる。新規 `.graphrag` を作るのは
 * 明示的にそこを対象にした verb (world-join 等) だけ。
 */
export function discoverStateDir(cwd: string = process.cwd()): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, ".graphrag");
    if (isDir(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * state dir (`.graphrag`) 直下の機械ローカル cache dir (`<stateDir>/cache`) を冪等に返す。
 *
 * E1: 再生成可能・マシンローカルなファイル (vector.json / vector-index.json /
 * indexed-graph.json / ask-state.json / vault.lock / vault.seq) はすべてここへ集約する。
 * `.env` / `VAULT.md` / `carving.json` / `world.json` (追跡・設定) は stateDir 直下のまま。
 * cache/ は writer が走っていなければ丸ごと消して安全 (vault.seq のリセットは設計上許容)。
 */
export function cacheDirUnder(stateDir: string): string {
  const abs = path.resolve(stateDir);
  if (path.basename(abs) === "cache") return abs; // 冪等 (二重に掘らない)
  return path.join(abs, "cache");
}

/** vault に対応する機械ローカル cache dir。stateDirForVault と同じ冪等性を持つ。 */
export function cacheDirForVault(vaultDir: string): string {
  return cacheDirUnder(stateDirForVault(vaultDir));
}

/**
 * E3 (readonly mode): 外部 vault を読み専用で使う消費側の、vault ごとの cache dir。
 * `<ローカル .graphrag>/cache/external/<vault絶対パスの短hash>`。
 * ローカルに正当な `.graphrag` root が見つからなければ null (呼び出し元は永続化 skip)。
 */
export function consumerCacheDirForVault(vaultDir: string, cwd: string = process.cwd()): string | null {
  const stateDir = discoverStateDir(cwd);
  if (!stateDir) return null;
  const key = createHash("sha1").update(path.resolve(vaultDir)).digest("hex").slice(0, 8);
  return path.join(cacheDirUnder(stateDir), "external", key);
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

/**
 * `~/.graphrag/.env` を読み、applyDotEnv する。無ければ no-op。
 *
 * これは「環境 (マシン/ユーザ) ごと」のグローバル設定。典型は vector index
 * 用の embedding API サーバ位置 (GRAPHRAG_EMBEDDING_ENDPOINT /
 * GRAPHRAG_EMBEDDING_API_KEY / GRAPHRAG_EMBEDDING_MODEL) — vault ごとではなく
 * 環境ごとに決まる値を置く。各 vault の `.graphrag/.env` から API サーバ URL を
 * 消し、ここ 1 箇所に集約できる。
 *
 * 優先順位は最下位 (フォールバック)。applyDotEnv は first-wins なので、
 * ローカルの `.graphrag/.env` / cwd `.env` / vault 自動発見をすべて読んだ後に
 * 呼ぶ。これにより:
 *   - vault 固有のキー (GRAPHRAG_VAULT_DIR 等) は常にローカルが勝つ
 *     (home に紛れ込んでも closest-wins (#14) を壊さない)
 *   - 環境固有のキー (embedding endpoint) はローカルが触れていなければ home が埋める
 */
export function loadHomeGraphragEnv(home: string = homedir()): void {
  const homeEnvPath = path.join(home, ".graphrag", ".env");
  if (!isFile(homeEnvPath)) return;
  applyDotEnv(parseDotEnv(readFileSync(homeEnvPath, "utf8")));
}

// ── vault isolation detection ──────────────────────────────────

export type VaultMode = "readonly" | "direct";

export interface VaultIsolation {
  in_worktree: boolean;
  vault_external: boolean;
  mode: VaultMode | null;
  // needsLocalDecision で null に demote される前の、生の parse 結果。
  // 制限的 (readonly) な設定は worktree をまたいで「継承してよい」— 消費側
  // cache のような読み取り経路のルーティングはこちらを見る。書き込みゲート
  // (assertVaultWriteAllowed) は demote 後の `mode` を見続ける (inherited な
  // direct が書き込みを許可してはいけないので)。
  raw_mode: VaultMode | null;
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

// worktree 値の警告は process あたり 1 回だけ出す (read verb は ask 等で
// detectVaultIsolation を複数回呼びうるため、毎回吠えるとログが埋まる)。
let warnedWorktreeMode = false;

function parseVaultMode(raw: string | undefined): VaultMode | null {
  if (raw === "readonly") return "readonly";
  if (raw === "direct") return "direct";
  if (raw === "worktree") {
    // mode は「書き込み」のポリシーであって、読み専用 verb (ask 等) の生死には
    // 関わらない。以前はここで throw しており、アップグレード後の環境で
    // .env に legacy な worktree が残っているだけで ask すら死んでいた。
    // 未実装であることは伝えつつ、read path を殺さないよう unset 扱いにする。
    // 書き込みは (mode が null のまま) assertVaultWriteAllowed の
    // 「外部 vault なのに mode 未設定」ゲートで安全側に止まる。
    if (!warnedWorktreeMode) {
      warnedWorktreeMode = true;
      process.stderr.write(
        "[graphrag] GRAPHRAG_VAULT_MODE=worktree is not implemented, treating as unset — " +
        "writes to an external vault will hard-error until you set readonly|direct.\n"
      );
    }
    return null;
  }
  return null;
}

/** テスト用: 「worktree 警告済み」フラグをリセットする (module state のため)。 */
export function resetWorktreeModeWarningForTest(): void {
  warnedWorktreeMode = false;
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
 *
 * `mode` は書き込みゲート用に demote 済み (外部 vault でローカル未決定なら null)。
 * 読み取り経路 (消費側 cache のルーティング等) は demote 前の `raw_mode` を見る —
 * readonly のような制限的な設定は worktree をまたいで継承してよく、
 * inherited だからといって null 扱いにして外部 vault に書いてしまってはいけない。
 */
export function detectVaultIsolation(cwd: string = process.cwd(), vaultDirOverride?: string): VaultIsolation {
  const vaultDir = vaultDirOverride ?? process.env.GRAPHRAG_VAULT_DIR;
  const { mode, source } = readLocalVaultMode(cwd);

  const worktree = isWorktree(cwd);
  if (!vaultDir) {
    return { in_worktree: worktree, vault_external: false, mode, raw_mode: mode, mode_source: source, message: null };
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
    raw_mode: mode,
    mode_source: source,
    message
  };
}

/**
 * vault への書き込みを許可してよいかの単一ゲート。
 * typed-add / commit-mutation / vault-build 等、vault を書き換える verb の入口で呼ぶ。
 *   - GRAPHRAG_VAULT_MODE=readonly → 常に拒否
 *   - 外部 vault なのにローカル mode 未設定 (inherited 含む) → 拒否 (worktree ごとの意思決定を要求)
 * 通れば isolation を返す (出力への同梱用)。unit テストはコア関数
 * (applyMutationToVault / buildVaultFiles 等) を直接呼べばこのゲートを踏まない。
 */
export function assertVaultWriteAllowed(
  opts: { cwd?: string; vaultDir?: string } = {}
): VaultIsolation {
  const cwd = opts.cwd ?? process.cwd();
  const isolation = detectVaultIsolation(cwd, opts.vaultDir);
  if (isolation.mode === "readonly") {
    throw new Error(
      `Vault is in readonly mode (GRAPHRAG_VAULT_MODE=readonly). ` +
      `Writes are blocked. To allow writes, set GRAPHRAG_VAULT_MODE=direct in .graphrag/.env.`
    );
  }
  if (isolation.vault_external && isolation.mode === null) {
    const cwdEnvPath = path.join(cwd, ".graphrag", ".env");
    throw new Error(
      `Vault is external (${opts.vaultDir ?? process.env.GRAPHRAG_VAULT_DIR}) but this directory has no local GRAPHRAG_VAULT_MODE. ` +
      (isolation.mode_source === "inherited"
        ? `(A parent directory has a mode setting, but each worktree needs its own decision.) `
        : ``) +
      `Refusing to write — ask the user which mode to use, then set it in ${cwdEnvPath}:\n` +
      `  GRAPHRAG_VAULT_MODE=readonly   — read only, block all writes\n` +
      `  GRAPHRAG_VAULT_MODE=direct     — write to the shared vault as-is`
    );
  }
  return isolation;
}

// ── vault 解決の可視化 (どの層が GRAPHRAG_VAULT_DIR を決めたか) ──────────

export type VaultDirSource =
  | "shell-env"        // シェル環境変数 (env 読み込み開始前から設定済み)
  | "graphrag-env"     // walk-up した .graphrag/.env
  | "cwd-env"          // cwd の .env
  | "auto-discovered"  // .graphrag/vault の自動発見 (closest-vault bind 含む)
  | "home-env"         // ~/.graphrag/.env
  | "cli-arg";         // CLI 引数 (--vault / positional)

let vaultDirSource: VaultDirSource | null = null;

/**
 * env 読み込みシーケンス (cli.ts runCli) の各段の直後に呼ぶ。GRAPHRAG_VAULT_DIR が
 * その段で初めて確定していたら、その層を「勝った層」として記録する (first-wins)。
 */
export function noteVaultDirSource(layer: VaultDirSource): void {
  if (vaultDirSource !== null) return;
  const v = process.env.GRAPHRAG_VAULT_DIR;
  if (v !== undefined && v !== "") vaultDirSource = layer;
}

export function getVaultDirSource(): VaultDirSource | null {
  return vaultDirSource;
}

/** テスト用: 記録をリセットする (module state のため)。 */
export function resetVaultDirSourceForTest(): void {
  vaultDirSource = null;
}

/**
 * 書き込み verb が「どの vault にどの根拠で書くのか」を毎回可視化する 1 行を stderr へ
 * 出し、JSON 出力へ同梱するフィールドを返す。source 未記録 (runCli を経ない直接呼び出し)
 * は process.env に既に居た値とみなし shell-env 扱い。
 */
export function reportVaultResolution(
  vaultDir: string,
  sourceOverride?: VaultDirSource
): { vault_dir: string; vault_dir_source: VaultDirSource } {
  const source = sourceOverride ?? getVaultDirSource() ?? "shell-env";
  const abs = path.resolve(vaultDir);
  process.stderr.write(`[graphrag] vault: ${abs} (source: ${source})\n`);
  return { vault_dir: abs, vault_dir_source: source };
}

/**
 * E2 closest-vault-wins の穴塞ぎ: 最も近い `.graphrag` root が `vault/` を持ち、
 * その root の `.env` が無い/GRAPHRAG_VAULT_DIR を書いていない場合、cwd の `.env`
 * (プロジェクト直下の素朴な .env に残った stale な GRAPHRAG_VAULT_DIR) が読まれる
 * 「前に」その vault を確定する。runCli で discoverAndLoadGraphragEnv の直後・
 * loadDotEnvFromCwd の前に呼ぶ。シェル env は first-wins のまま常に勝つ。
 */
export function bindClosestVaultDir(cwd: string = process.cwd()): void {
  const existing = process.env.GRAPHRAG_VAULT_DIR;
  if (existing !== undefined && existing !== "") return;
  const root = findGraphragRoot(cwd);
  if (!root || !root.hasVault) return;
  if (root.hasEnv) {
    // root の .env が GRAPHRAG_VAULT_DIR を明示しているなら、それは
    // discoverAndLoadGraphragEnv が既に適用済みのはず (ここには来ない) だが、
    // 念のため二重確認して明示指定を尊重する。
    const parsed = parseDotEnv(readFileSync(path.join(root.dir, ".env"), "utf8"));
    if (parsed["GRAPHRAG_VAULT_DIR"]) return;
  }
  process.env.GRAPHRAG_VAULT_DIR = path.join(root.dir, "vault");
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

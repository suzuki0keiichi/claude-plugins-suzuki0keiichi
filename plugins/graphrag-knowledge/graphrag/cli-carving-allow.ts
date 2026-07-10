// carving-allow — .graphrag/carving.json (プロジェクト固有 allowed-orphan) の管理 verb。
//
//   carving-allow add --path <p> --reason <r> [--config <path>]
//   carving-allow remove --path <p> [--config <path>]
//   carving-allow list [--config <path>]
//   carving-allow migrate --graph <path>
//
// add/remove は vault-lock を共用した直列化 + tmp+rename の原子書き (vault は並行多書き前提)。
// git repo 内なら add+commit を試み、失敗は非致命で出力に注記する (vault は git だけが頼り)。
// migrate は check-carving の builtin から削除した旧パターンに該当する graph 内 File を
// config エントリ案として出すだけで書き込まない (LLM/人間が妥当性を判断して add する前提)。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { withVaultLock } from "./vault-lock.ts";
import {
  CARVING_CONFIG_BASENAME,
  hasGlobChars,
  loadCarvingConfig,
  type CarvingConfig,
} from "./carving-config.ts";
import { REMOVED_BUILTIN_ORPHAN_PATTERNS } from "./check-carving.ts";
import { discoverStateDir, cacheDirUnder, reportVaultResolution } from "./cli-env.ts";

function parseArgs(argv: string[]): { verb: string | undefined; flags: Record<string, string | true> } {
  const flags: Record<string, string | true> = {};
  let verb: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (verb === undefined) verb = a;
      continue;
    }
    const v = argv[i + 1];
    if (v !== undefined && !v.startsWith("--")) {
      flags[a.slice(2)] = v;
      i += 1;
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return { verb, flags };
}

function requireString(flags: Record<string, string | true>, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) throw new Error(`--${name} is required`);
  return v;
}

function defaultConfigPath(flags: Record<string, string | true>): string {
  if (typeof flags.config === "string") return path.resolve(flags.config);
  // vault ディレクトリ内から実行しても walk-up で既存 <root>/.graphrag を辿り当てる
  // (素朴な cwd/.graphrag だと <root>/.graphrag/vault/.graphrag を量産していた)。
  // どこにも .graphrag が無ければ cwd に勝手に掘らず明確にエラー (ゴミ生成防止)。
  const stateDir = process.env.GRAPHRAG_STATE_DIR ?? discoverStateDir();
  if (!stateDir) {
    throw new Error(
      "Cannot resolve where to put carving.json: no .graphrag found above cwd. " +
      "Pass --config <path>, or run from the project root (where .graphrag lives)."
    );
  }
  return path.join(stateDir, CARVING_CONFIG_BASENAME);
}

function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function writeConfigAtomic(configPath: string, config: CarvingConfig): void {
  const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, configPath);
}

type GitResult = { committed: boolean; note?: string };

// 免除の追加/削除も判断なので履歴に残す。失敗 (git repo 外 / git 不在等) は非致命。
function tryGitCommit(configPath: string, message: string): GitResult {
  const dir = path.dirname(configPath);
  try {
    execFileSync("git", ["add", "--", configPath], { cwd: dir, stdio: "pipe" });
    const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--", configPath], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!staged) return { committed: false, note: "no change to commit" };
    execFileSync("git", ["commit", "-q", "-m", message, "--", configPath], { cwd: dir, stdio: "pipe" });
    return { committed: true };
  } catch (e: any) {
    return { committed: false, note: `git commit failed (non-fatal): ${String(e?.message ?? e).split("\n")[0]}` };
  }
}

// lock 取得下で既存 config を読み、不正なら止める (壊れた設定に上書きで追い打ちしない)。
function loadForWrite(configPath: string): CarvingConfig {
  const loaded = loadCarvingConfig(configPath);
  if (loaded.exists && loaded.errors.length > 0) {
    throw new Error(`Existing carving.json is invalid: ${loaded.errors.join("; ")}`);
  }
  return loaded.config ?? { allowed_orphans: [] };
}

async function runAdd(flags: Record<string, string | true>): Promise<any> {
  const configPath = defaultConfigPath(flags);
  const p = requireString(flags, "path");
  const reason = requireString(flags, "reason");
  if (hasGlobChars(p)) throw new Error(`--path must not contain glob/regex chars (* ? [); literal path only: ${p}`);
  const entry = { path: p, reason, added: todayISO() };
  // carving.json は追跡設定なので stateDir 直下のまま、lock (機械ローカル) は cache/ に置く (E1)。
  const lockDir = cacheDirUnder(path.dirname(configPath));
  fs.mkdirSync(lockDir, { recursive: true });
  await withVaultLock(lockDir, () => {
    const config = loadForWrite(configPath);
    if (config.allowed_orphans.some((e) => e.path === p)) {
      throw new Error(`Already exempted: ${p} (to update, carving-allow remove then add)`);
    }
    config.allowed_orphans.push(entry);
    writeConfigAtomic(configPath, config);
  });
  const git = tryGitCommit(configPath, `carving-allow add: ${p}`);
  return { action: "add", config_path: configPath, entry, git };
}

async function runRemove(flags: Record<string, string | true>): Promise<any> {
  const configPath = defaultConfigPath(flags);
  const p = requireString(flags, "path");
  let removed: any = null;
  const lockDir = cacheDirUnder(path.dirname(configPath));
  fs.mkdirSync(lockDir, { recursive: true });
  await withVaultLock(lockDir, () => {
    const config = loadForWrite(configPath);
    removed = config.allowed_orphans.find((e) => e.path === p) ?? null;
    if (!removed) throw new Error(`Exemption entry not found: ${p}`);
    config.allowed_orphans = config.allowed_orphans.filter((e) => e.path !== p);
    writeConfigAtomic(configPath, config);
  });
  const git = tryGitCommit(configPath, `carving-allow remove: ${p}`);
  return { action: "remove", config_path: configPath, removed, git };
}

function runList(flags: Record<string, string | true>): any {
  const configPath = defaultConfigPath(flags);
  const loaded = loadCarvingConfig(configPath);
  return {
    action: "list",
    config_path: configPath,
    exists: loaded.exists,
    errors: loaded.errors,
    allowed_orphans: loaded.config?.allowed_orphans ?? [],
  };
}

// 移行等価性の担保: 削除した旧 builtin パターンで免除されていた File を黙って ERROR に
// 落とさず、graph から該当 File を拾って config エントリ案として提示する (書き込みなし)。
function runMigrate(flags: Record<string, string | true>): any {
  const graphPath = requireString(flags, "graph");
  const graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));
  const candidates: any[] = [];
  for (const n of graph.nodes ?? []) {
    if (n.type !== "File" || typeof n.path !== "string") continue;
    const hit = REMOVED_BUILTIN_ORPHAN_PATTERNS.find((r) => r.pattern.test(n.path));
    if (!hit) continue;
    candidates.push({
      path: n.path,
      reason: `exemption migrated from removed builtin pattern '${hit.name}' (re-verify validity)`,
      added: todayISO(),
      from_builtin: hit.name,
    });
  }
  return {
    action: "migrate",
    graph: graphPath,
    note: "Candidates only, no writes. Confirm the valid ones with carving-allow add --path <p> --reason <r>.",
    candidates,
  };
}

export async function runCarvingAllow(argv: string[]): Promise<any> {
  const { verb, flags } = parseArgs(argv);
  // 書き込み系 (add/remove) は vault 解決の可視化 1 行を出す (typed-add 等と同じ運用)。
  // carving-allow 自体は vault でなく carving.json を書くので、vault が解決できて
  // いる時だけ同梱する。
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  const vaultResolution = (verb === "add" || verb === "remove") && vaultDir
    ? reportVaultResolution(vaultDir)
    : null;
  let result: any;
  switch (verb) {
    case "add": result = await runAdd(flags); break;
    case "remove": result = await runRemove(flags); break;
    case "list": result = runList(flags); break;
    case "migrate": result = runMigrate(flags); break;
    default:
      throw new Error(`usage: carving-allow <add|remove|list|migrate> (got: ${verb ?? "(none)"})`);
  }
  if (vaultResolution) result = { ...vaultResolution, ...result };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result;
}

if (process.argv[1] && process.argv[1].endsWith("cli-carving-allow.ts")) {
  runCarvingAllow(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

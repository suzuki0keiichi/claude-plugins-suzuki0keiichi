import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadWorldConfig, resolveWorldDir, WORLD_FILE, vaultProfilePath } from "./world.ts";
import { parseVaultSlug } from "./xref-resolver.ts";
import { writeFileAtomic } from "./build-vector-index.ts";
import { parseDotEnv } from "./cli-env.ts";

export interface WorldJoinResult {
  vault_path: string;
  vault_slug: string | null;
  world_dir: string;
  world_json_updated: boolean;
  env_updated: boolean;
  env_path: string;
  message: string;
}

function resolveVaultDir(flagValue?: string): string | undefined {
  if (typeof flagValue === "string" && flagValue.length > 0) return path.resolve(flagValue);
  const v = process.env.GRAPHRAG_VAULT_DIR;
  return v && v.length > 0 ? path.resolve(v) : undefined;
}

function normalizeVaultPaths(config: { vaults: { path: string }[] }): string[] {
  return config.vaults.map((v) => path.resolve(v.path));
}

/**
 * cwd から上方向に `.graphrag` ディレクトリを探す。
 * discoverAndLoadGraphragEnv と同じ探索方式。
 * 見つからなければ cwd 直下に `.graphrag` を返す（新規作成用）。
 */
function discoverGraphragDir(cwd: string = process.cwd()): string {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, ".graphrag");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(path.resolve(cwd), ".graphrag");
}

/**
 * .graphrag/.env にキーを追加/更新する。
 * 既存行があれば値を上書き、なければ末尾に追記。
 */
export function upsertDotEnvKey(envPath: string, key: string, value: string): void {
  const dir = path.dirname(envPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let lines: string[] = [];
  if (existsSync(envPath)) {
    lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  }

  const pattern = new RegExp(`^(export\\s+)?${key}\\s*=`);
  const idx = lines.findIndex((l) => pattern.test(l.trim()));
  const newLine = `${key}=${value}`;

  if (idx >= 0) {
    if (lines[idx].trim() === newLine) return; // already correct
    lines[idx] = newLine;
  } else {
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.splice(lines.length - 1, 0, newLine);
    } else {
      lines.push(newLine);
      lines.push("");
    }
  }

  writeFileSync(envPath, lines.join("\n"));
}

export async function worldJoin(options: {
  vaultDir?: string;
  worldDir?: string;
  graphragDir?: string;
}): Promise<WorldJoinResult> {
  const vaultDir = options.vaultDir ?? resolveVaultDir();
  if (!vaultDir) {
    throw new Error(
      "vault directory not specified. Pass --vault <dir> or set GRAPHRAG_VAULT_DIR, " +
      "or run from a directory with .graphrag/vault."
    );
  }
  const resolvedVault = path.resolve(vaultDir);
  if (!existsSync(resolvedVault)) {
    throw new Error(`vault directory does not exist: ${resolvedVault}`);
  }

  const worldDir = options.worldDir ?? resolveWorldDir();
  if (!worldDir) {
    throw new Error(
      "world directory not specified. Pass --world <dir> or set GRAPHRAG_WORLD_DIR."
    );
  }
  const resolvedWorld = path.resolve(worldDir);

  // VAULT.md から vault_slug を読む
  const profile = vaultProfilePath(resolvedVault);
  let vaultSlug: string | null = null;
  if (existsSync(profile)) {
    const content = readFileSync(profile, "utf8");
    vaultSlug = parseVaultSlug(content);
  }

  // world.json を読む (無ければ新規作成)
  const worldJsonPath = path.join(resolvedWorld, WORLD_FILE);
  let worldJsonUpdated = false;

  if (!existsSync(resolvedWorld)) {
    mkdirSync(resolvedWorld, { recursive: true });
  }

  const newEntry: Record<string, string> = { path: resolvedVault };
  if (vaultSlug) newEntry.slug = vaultSlug;

  if (existsSync(worldJsonPath)) {
    const config = loadWorldConfig(resolvedWorld);
    const existing = normalizeVaultPaths(config);
    if (!existing.includes(resolvedVault)) {
      const raw = JSON.parse(readFileSync(worldJsonPath, "utf8"));
      raw.vaults.push(newEntry);
      await writeFileAtomic(worldJsonPath, `${JSON.stringify(raw, null, 2)}\n`);
      worldJsonUpdated = true;
    }
  } else {
    const initial = { vaults: [newEntry] };
    await writeFileAtomic(worldJsonPath, `${JSON.stringify(initial, null, 2)}\n`);
    worldJsonUpdated = true;
  }

  // .graphrag/.env に GRAPHRAG_WORLD_DIR を書く
  // cwd から上方向に .graphrag/ を探す（vault が外部リポジトリにあっても LOCAL の .env に書く）
  const graphragDir = options.graphragDir ?? discoverGraphragDir();
  const envPath = path.join(graphragDir, ".env");
  let envUpdated = false;

  if (existsSync(envPath)) {
    const parsed = parseDotEnv(readFileSync(envPath, "utf8"));
    if (parsed["GRAPHRAG_WORLD_DIR"] === resolvedWorld) {
      // already set correctly
    } else {
      upsertDotEnvKey(envPath, "GRAPHRAG_WORLD_DIR", resolvedWorld);
      envUpdated = true;
    }
  } else {
    upsertDotEnvKey(envPath, "GRAPHRAG_WORLD_DIR", resolvedWorld);
    envUpdated = true;
  }

  const parts: string[] = [];
  if (worldJsonUpdated) parts.push(`added to ${worldJsonPath}` + (vaultSlug ? ` (slug: ${vaultSlug})` : ""));
  else parts.push(`already in ${worldJsonPath}`);
  if (envUpdated) parts.push(`wrote GRAPHRAG_WORLD_DIR to ${envPath}`);
  else parts.push(`GRAPHRAG_WORLD_DIR already set in ${envPath}`);
  if (!existsSync(profile)) parts.push(`warning: ${profile} not found — create a VAULT.md so world-refresh can index this vault`);
  else if (!vaultSlug) parts.push(`warning: ${profile} has no vault_slug — cross-vault refs will not resolve to this vault`);

  return {
    vault_path: resolvedVault,
    vault_slug: vaultSlug,
    world_dir: resolvedWorld,
    world_json_updated: worldJsonUpdated,
    env_updated: envUpdated,
    env_path: envPath,
    message: parts.join("; ")
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const worldIdx = argv.indexOf("--world");
  const worldFlag = worldIdx >= 0 ? argv[worldIdx + 1] : undefined;

  const vaultIdx = argv.indexOf("--vault");
  const vaultFlag = vaultIdx >= 0 ? argv[vaultIdx + 1] : undefined;

  const positional = argv.find((a) => !a.startsWith("--") && a !== worldFlag && a !== vaultFlag);

  const result = await worldJoin({
    vaultDir: vaultFlag,
    worldDir: worldFlag ?? positional
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function isMainModule(url: string): boolean {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
if (isMainModule(import.meta.url)) {
  await main();
}

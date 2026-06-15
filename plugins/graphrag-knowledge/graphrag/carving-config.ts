// .graphrag/carving.json — allowed-orphan のプロジェクト固有免除を設定化する (carving ゲート C3)。
//
// builtin パターン (check-carving の BUILTIN_ORPHAN_PATTERNS) が「どのプロジェクトでも
// 構造的に Pocket に属さないもの」だけを持つのに対し、プロジェクト固有の免除は
// この設定に literal path + reason + added で明記する。
//   - literal path のみ (glob/regex 文字は ERROR)。パターン免除を許すと免除の射程が
//     書いた本人にも読めなくなり、網羅性ゲートが黙って空洞化する。
//   - graph に存在しない path のエントリは ERROR (stale-exemption)。掃除を強制し、
//     免除が増えっぱなしで腐るのを防ぐ。
import fs from "node:fs";
import path from "node:path";

export interface CarvingAllowedOrphan {
  path: string;
  reason: string;
  added: string; // YYYY-MM-DD
}

export interface CarvingConfig {
  allowed_orphans: CarvingAllowedOrphan[];
}

export const CARVING_CONFIG_BASENAME = "carving.json";

// glob/regex として解釈されうる文字。literal path のみ許す。
const GLOB_CHARS = /[*?[]/;

export function hasGlobChars(p: string): boolean {
  return GLOB_CHARS.test(p);
}

/**
 * graph パスからの規約解決。
 * graph が .graphrag/ 配下 (規約: <root>/.graphrag/indexed-graph.json) ならその隣、
 * そうでなければ graph と同階層の .graphrag/ 配下を見る。
 */
export function resolveCarvingConfigPath(graphPath: string): string {
  const dir = path.dirname(path.resolve(graphPath));
  if (path.basename(dir) === ".graphrag") return path.join(dir, CARVING_CONFIG_BASENAME);
  return path.join(dir, ".graphrag", CARVING_CONFIG_BASENAME);
}

/**
 * carving.json の構造検証。path が読める範囲のエントリは errors があっても config に
 * 含めて返す (ERROR は check-carving 側で exit 1 になるので、免除の適用自体は寛容でよい)。
 */
export function parseCarvingConfig(raw: string): { config: CarvingConfig | null; errors: string[] } {
  const errors: string[] = [];
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (e: any) {
    return { config: null, errors: [`JSON として読めない: ${e?.message ?? e}`] };
  }
  if (typeof data !== "object" || data === null || !Array.isArray(data.allowed_orphans)) {
    return { config: null, errors: [`形が不正: { "allowed_orphans": [ { path, reason, added } ] } であるべき`] };
  }
  const entries: CarvingAllowedOrphan[] = [];
  const seen = new Set<string>();
  data.allowed_orphans.forEach((entry: any, i: number) => {
    const where = `allowed_orphans[${i}]`;
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${where}: オブジェクトでない`);
      return;
    }
    const p = entry.path;
    if (typeof p !== "string" || p.length === 0) {
      errors.push(`${where}: path 必須`);
      return;
    }
    if (hasGlobChars(p)) errors.push(`${where} (${p}): glob/regex 文字 (* ? [) は不可。literal path のみ`);
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      errors.push(`${where} (${p}): reason 必須`);
    }
    if (typeof entry.added !== "string" || entry.added.trim().length === 0) {
      errors.push(`${where} (${p}): added (YYYY-MM-DD) 必須`);
    }
    if (seen.has(p)) errors.push(`${where} (${p}): path 重複`);
    seen.add(p);
    entries.push({ path: p, reason: String(entry.reason ?? ""), added: String(entry.added ?? "") });
  });
  return { config: { allowed_orphans: entries }, errors };
}

export function loadCarvingConfig(configPath: string): {
  exists: boolean;
  config: CarvingConfig | null;
  errors: string[];
} {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return { exists: false, config: null, errors: [] };
  }
  const parsed = parseCarvingConfig(raw);
  return { exists: true, config: parsed.config, errors: parsed.errors };
}

/** stale-exemption: graph に存在しない path のエントリ (掃除を強制する ERROR の材料)。 */
export function staleConfigEntries(config: CarvingConfig, graphFilePaths: Set<string>): string[] {
  return config.allowed_orphans.map((e) => e.path).filter((p) => !graphFilePaths.has(p));
}

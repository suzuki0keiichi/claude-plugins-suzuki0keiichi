import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SCHEMA, type SchemaDefinition } from "./schema.ts";
import { vaultProfilePath, parseVaultProfile } from "./world.ts";

const presets = new Map<string, SchemaDefinition>();

export function registerPreset(schema: SchemaDefinition): void {
  presets.set(schema.id, schema);
}

export function getPreset(id: string): SchemaDefinition | undefined {
  return presets.get(id);
}

export function listPresets(): string[] {
  return [...presets.keys()];
}

registerPreset(DEFAULT_SCHEMA);

/**
 * vault の VAULT.md から schema プリセットを解決する。
 * 優先順位:
 *   1. VAULT.md frontmatter の `schema` フィールド → プリセット検索
 *   2. フォールバック → DEFAULT_SCHEMA
 *
 * VAULT.md が無い / schema フィールドが無い場合も DEFAULT_SCHEMA。
 */
export function resolveSchema(vaultDir: string): SchemaDefinition {
  const profilePath = vaultProfilePath(vaultDir);
  if (!existsSync(profilePath)) return DEFAULT_SCHEMA;

  const content = readFileSync(profilePath, "utf8");
  const schemaId = parseSchemaField(content);
  if (!schemaId) return DEFAULT_SCHEMA;

  const preset = presets.get(schemaId);
  if (!preset) {
    const available = [...presets.keys()].join(", ");
    throw new Error(
      `VAULT.md specifies schema: "${schemaId}" but no preset with that id exists. ` +
      `Available presets: ${available}`
    );
  }
  return preset;
}

function parseSchemaField(content: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!fm) return null;
  for (const line of fm[1].split(/\r?\n/)) {
    const m = /^schema\s*:\s*(.*)$/.exec(line.trim());
    if (m) {
      const value = m[1].trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  }
  return null;
}

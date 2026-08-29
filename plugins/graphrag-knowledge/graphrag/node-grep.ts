/**
 * node-grep: 決定的な全フィールド検索 (grep) とノード全文読み出し (show)。
 * graphrag:see goal:graphrag-skill-dev:search-field-gap-direct-grep
 *
 * 背景 (実運用の観測): vault .md への直接 grep/cat が ask 呼び出しに匹敵する規模で
 * 発生していた。原因は欠けていた2つの読み口:
 *   - ranked search (ask/search) は改名耐性のため node.id / node.type を意図的に
 *     ランキング対象から外し (retrieval.computeNodeLexical のコメント参照)、
 *     description / raw_content も対象外 — id 断片・本文・型名で「探す」手段が無い。
 *   - 出力は nodeForOutput のホワイトリスト + summary 短縮で、ノード本文を「読む」
 *     手段が無い (.md を cat するしかない)。
 *
 * この2 verb は ranked search の設計 (意味の一致・改名耐性) には触れない。grep は
 * ランキングではなく決定的な文字一致列挙なので、id/type/description/raw_content を
 * 含めても改名移行で「順位が動く」問題は起きない (一致した事実を列挙するだけ)。
 *
 *   grep "<pattern>" [--regex] [--types A,B] [--limit N] [--vault <dir>]
 *   show <id> [<id>...] [--vault <dir>]
 *
 * どちらも読み取り専用・embedding 不要。show は欠損 id に tombstone 台帳 (301) を
 * 引いて後継を案内する。
 */

import { pathToFileURL } from "node:url";
import { loadGraph } from "./retrieval.ts";
import { latestTombstones, resolveSuccessor } from "./tombstones.ts";

const GREP_DEFAULT_LIMIT = 20;
const GREP_SNIPPETS_PER_NODE = 3;
const SNIPPET_CHARS = 200;

interface GrepMatch {
  field: string;
  /** 複数行フィールド内の行番号 (1-origin)。単一行フィールドは省略。 */
  line?: number;
  snippet: string;
}

export interface GrepNodeHit {
  id: string;
  type: string;
  title?: string;
  state?: string;
  matches: GrepMatch[];
  matches_overflow?: number;
}

function truncate(value: string, maxChars: number): string {
  const t = value.replace(/\s+/g, " ").trim();
  return t.length <= maxChars ? t : `${t.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** ノードの全文字列フィールドを {field, text} で列挙する (ネストは field をドット連結)。 */
export function collectTextFields(node: Record<string, unknown>): { field: string; text: string }[] {
  const out: { field: string; text: string }[] = [];
  const visit = (field: string, value: unknown) => {
    if (typeof value === "string") {
      if (value.length > 0) out.push({ field, text: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(`${field}[${i}]`, item));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(`${field}.${k}`, v);
    }
  };
  for (const [key, value] of Object.entries(node)) visit(key, value);
  return out;
}

export function grepGraph(
  graph: { nodes?: any[] },
  pattern: string,
  options: { regex?: boolean; caseSensitive?: boolean; types?: string[]; limit?: number } = {}
): { hits: GrepNodeHit[]; nodes_scanned: number; hits_total: number } {
  const limit = options.limit ?? GREP_DEFAULT_LIMIT;
  const flags = options.caseSensitive ? "" : "i";
  let re: RegExp;
  if (options.regex) {
    re = new RegExp(pattern, flags); // 不正 regex はここで throw (fail-loud)
  } else {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }
  const typeFilter = options.types && options.types.length > 0 ? new Set(options.types) : null;

  const hits: GrepNodeHit[] = [];
  let hitsTotal = 0;
  let scanned = 0;
  for (const node of graph.nodes ?? []) {
    if (typeof node?.id !== "string") continue;
    if (typeFilter && !typeFilter.has(String(node.type))) continue;
    scanned += 1;
    const matches: GrepMatch[] = [];
    for (const { field, text } of collectTextFields(node)) {
      if (text.includes("\n")) {
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          if (re.test(lines[i])) matches.push({ field, line: i + 1, snippet: truncate(lines[i], SNIPPET_CHARS) });
        }
      } else if (re.test(text)) {
        matches.push({ field, snippet: truncate(text, SNIPPET_CHARS) });
      }
    }
    if (matches.length === 0) continue;
    hitsTotal += 1;
    if (hits.length >= limit) continue; // limit 超過分は hits_total にだけ数える (無言 cap にしない)
    hits.push({
      id: String(node.id),
      type: String(node.type ?? "?"),
      ...(typeof node.title === "string" ? { title: node.title } : {}),
      ...(typeof node.state === "string" ? { state: node.state } : {}),
      matches: matches.slice(0, GREP_SNIPPETS_PER_NODE),
      ...(matches.length > GREP_SNIPPETS_PER_NODE ? { matches_overflow: matches.length - GREP_SNIPPETS_PER_NODE } : {})
    });
  }
  return { hits, nodes_scanned: scanned, hits_total: hitsTotal };
}

// ── show: ノード全文 + 接続エッジ ────────────────────────────────────────────

export interface ShowNodeResult {
  found: boolean;
  id: string;
  node?: Record<string, unknown>;
  edges?: { relation: string; direction: "out" | "in"; other: string; other_title?: string }[];
  /** 欠損 id の tombstone 解決 (301 後継 / 410 gone)。 */
  tombstone?: { status: string; successor?: string | null; note: string };
}

export function showNodes(
  graph: { nodes?: any[]; edges?: any[] },
  ids: string[],
  vaultDir?: string
): ShowNodeResult[] {
  const nodesById = new Map<string, any>((graph.nodes ?? []).map((n: any) => [n.id, n]));
  // 欠損 id の tombstone 解決は vault 1 回分をまとめて読む (per-id で読み直さない)。
  let tombstones: ReturnType<typeof latestTombstones> | null = null;
  const lookupTombstone = (id: string) => {
    if (!vaultDir) return undefined;
    try {
      tombstones = tombstones ?? latestTombstones(vaultDir);
    } catch {
      return undefined; // 台帳が読めない場合は not-found のみ
    }
    if (!tombstones.has(id)) return undefined;
    const res = resolveSuccessor(tombstones, id);
    return {
      status: res.final_successor ? "deleted-301" : "deleted-410",
      successor: res.final_successor,
      note: res.final_successor
        ? `deleted — follow the 301 successor: ${res.final_successor}`
        : "deleted with no successor (410 gone)"
    };
  };
  return ids.map((id) => {
    const node = nodesById.get(id);
    if (!node) {
      const result: ShowNodeResult = { found: false, id };
      const tomb = lookupTombstone(id);
      if (tomb) result.tombstone = tomb;
      return result;
    }
    const edges: ShowNodeResult["edges"] = [];
    for (const e of graph.edges ?? []) {
      if (e?.from !== id && e?.to !== id) continue;
      const direction: "out" | "in" = e.from === id ? "out" : "in";
      const otherId = direction === "out" ? e.to : e.from;
      const other = nodesById.get(otherId);
      edges.push({
        relation: String(e.type ?? "?"),
        direction,
        other: String(otherId),
        ...(other && typeof other.title === "string" ? { other_title: other.title } : {})
      });
    }
    // ノードは全フィールド verbatim (nodeForOutput のホワイトリストを通さない — これが
    // 「.md を cat するしかない」を潰す読み口)。
    return { found: true, id, node, edges };
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const p: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v !== undefined && !v.startsWith("--")) {
      p[k] = v;
      i += 1;
    } else {
      p[k] = true;
    }
  }
  return { positional, flags: p };
}

// boolean フラグが次の positional を値として飲む事故の防止 (ask --lexical-only と同型)。
function booleanFlag(flags: Record<string, string | true>, positional: string[], name: string): boolean {
  const v = flags[name];
  if (typeof v === "string") {
    positional.unshift(v);
    flags[name] = true;
    return true;
  }
  return v === true;
}

export async function runNodeGrep(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const regex = booleanFlag(flags, positional, "regex");
  const caseSensitive = booleanFlag(flags, positional, "case-sensitive");
  const pattern = positional[0];
  if (!pattern) throw new Error('grep "<pattern>" requires a pattern (add --regex for regular expressions)');
  const vault = typeof flags.vault === "string" ? flags.vault : process.env.GRAPHRAG_VAULT_DIR;
  if (!vault) throw new Error("grep requires a vault: pass --vault <dir> or set GRAPHRAG_VAULT_DIR");
  const types = typeof flags.types === "string" ? flags.types.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : undefined;

  const graph = await loadGraph(vault);
  const result = grepGraph(graph, pattern, { regex, caseSensitive, types, limit });
  process.stdout.write(
    JSON.stringify(
      {
        generated_by: "graphrag/node-grep.ts",
        pattern,
        mode: regex ? "regex" : "substring",
        case_sensitive: caseSensitive,
        ...(types ? { types } : {}),
        ...result,
        note:
          "Deterministic full-field match (id / type / title / summary / aliases / tags / description / " +
          "raw_content / path / …) — an enumeration, not a ranking. For conceptual queries use `ask`; " +
          "to read a hit in full use `show <id>`."
      },
      null,
      2
    ) + "\n"
  );
}

export async function runNodeShow(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const ids = positional.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("show <id> [<id>...] requires at least one node id");
  const vault = typeof flags.vault === "string" ? flags.vault : process.env.GRAPHRAG_VAULT_DIR;
  if (!vault) throw new Error("show requires a vault: pass --vault <dir> or set GRAPHRAG_VAULT_DIR");

  const graph = await loadGraph(vault);
  const results = showNodes(graph, ids, vault);
  process.stdout.write(
    JSON.stringify(
      {
        generated_by: "graphrag/node-grep.ts",
        results,
        note:
          "Full node content (all frontmatter fields + description + raw_content, verbatim) + incident edges. " +
          "This replaces reading vault .md files directly — the vault stays write-protected behind " +
          "commit-mutation/add-*."
      },
      null,
      2
    ) + "\n"
  );
  if (results.some((r) => !r.found)) process.exitCode = 1;
}

function isMainModule(url: string): boolean {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
if (isMainModule(import.meta.url)) {
  await runNodeGrep();
}

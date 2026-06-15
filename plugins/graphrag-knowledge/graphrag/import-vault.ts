import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Inverse of build-vault.ts. The vault *is* the canonical source (v3); the
// round-trippable parts are strictly delimited:
//   - frontmatter: the custom YAML emitted by build-vault.ts (double-quoted
//     strings, unquoted number/boolean/null, `|-` block scalars, arrays,
//     nested objects, and the authoritative `graph_edges:` records).
//   - body: <!-- graphrag:description:begin/end --> -> node.description
//           <!-- graphrag:raw_content:begin/end --> -> node.raw_content
//           (legacy <!-- gestalty:... --> markers are also accepted)
// Everything else in the body (banner, H1, `## 関係`, `links:` wikilinks) is
// human-facing decoration and is ignored on import.

type Json = unknown;

// ---- scalar parsing (inverse of emitScalar) -------------------------------

function unescapeInline(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = s[i + 1];
    i += 1;
    if (n === "\\") out += "\\";
    else if (n === '"') out += '"';
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else out += n ?? "";
  }
  return out;
}

// Parse an inline scalar token (the text after `key: `). build-vault emits:
//   - double-quoted strings (everything that was a string)
//   - bare `null`
//   - bare numbers / booleans
function parseInlineScalar(tokenRaw: string): Json {
  const token = tokenRaw.trim();
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return unescapeInline(token.slice(1, -1));
  }
  if (token === "null") return null;
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "[]") return [];
  if (token === "{}") return {};
  // Unquoted number (emitScalar only ever emits bare tokens for
  // number/boolean/null, so any remaining bare token is numeric).
  const num = Number(token);
  if (token !== "" && Number.isFinite(num)) return num;
  // Defensive fallback: treat as raw string (should not happen for
  // build-vault output).
  return token;
}

// ---- block (frontmatter) parser -------------------------------------------

interface Line {
  indent: number;
  text: string; // content after leading spaces, trailing \r stripped
  raw: string; // original line (for block scalars, verbatim)
}

function toLines(block: string): Line[] {
  return block.split("\n").map((raw) => {
    const noCr = raw.replace(/\r$/, "");
    const m = noCr.match(/^( *)(.*)$/);
    const indent = m ? m[1].length : 0;
    const text = m ? m[2] : noCr;
    return { indent, text, raw: noCr };
  });
}

// Recursive-descent over the indentation grammar emitted by build-vault.
class BlockParser {
  private lines: Line[];
  private pos = 0;

  constructor(block: string) {
    // Drop fully empty leading/trailing lines that the wrapper adds.
    this.lines = toLines(block);
  }

  parse(): Record<string, Json> {
    return this.parseMapping(0);
  }

  private peek(): Line | undefined {
    // Skip blank lines at structural boundaries (blank lines never carry
    // mapping/array structure in build-vault output; block-scalar interiors
    // are consumed inside parseBlockScalar before peek is called again).
    while (this.pos < this.lines.length && this.lines[this.pos].text === "") {
      this.pos += 1;
    }
    return this.lines[this.pos];
  }

  private parseMapping(minIndent: number): Record<string, Json> {
    const obj: Record<string, Json> = {};
    for (;;) {
      const line = this.peek();
      if (!line) break;
      if (line.indent < minIndent) break;
      if (line.text.startsWith("- ")) break; // belongs to an array, not a map
      const colon = this.splitKey(line.text);
      if (!colon) break;
      const { key, rest } = colon;
      this.pos += 1;
      obj[key] = this.parseValue(rest, line.indent);
    }
    return obj;
  }

  // Split `key: rest` honoring that keys here are always simple identifiers
  // (no quotes/colons) as emitted by build-vault.
  private splitKey(text: string): { key: string; rest: string } | null {
    const idx = text.indexOf(":");
    if (idx < 0) return null;
    const key = text.slice(0, idx);
    let rest = text.slice(idx + 1);
    if (rest.startsWith(" ")) rest = rest.slice(1);
    return { key, rest };
  }

  private parseValue(rest: string, keyIndent: number): Json {
    if (rest === "|-") {
      return this.parseBlockScalar(keyIndent);
    }
    if (rest === "") {
      // Nested mapping or array on the following deeper-indented lines.
      const next = this.peek();
      if (!next || next.indent <= keyIndent) {
        // Emitter never produces this, but be defensive: empty object.
        return {};
      }
      if (next.text.startsWith("- ") || next.text === "-") {
        return this.parseArray(next.indent);
      }
      return this.parseMapping(next.indent);
    }
    return parseInlineScalar(rest);
  }

  private parseArray(itemIndent: number): Json[] {
    const arr: Json[] = [];
    for (;;) {
      const line = this.peek();
      if (!line) break;
      if (line.indent !== itemIndent) break;
      if (!(line.text === "-" || line.text.startsWith("- "))) break;
      const after = line.text === "-" ? "" : line.text.slice(2);
      this.pos += 1;
      if (after === "{}") {
        arr.push({});
        continue;
      }
      // Discriminate the two shapes build-vault emits:
      //   scalar item:        `- "quoted"` / `- 42` / `- null`
      //   block-mapping item: `- key: value` then `key: value` siblings
      // A scalar string is always double-quoted, so an unquoted identifier
      // followed by `:` unambiguously marks a block-mapping list item.
      const mapHead = /^([A-Za-z_][A-Za-z0-9_]*): /.exec(after);
      if (mapHead) {
        const kv = this.splitKey(after)!;
        const obj: Record<string, Json> = {};
        obj[kv.key] = parseInlineScalar(kv.rest);
        const fieldIndent = itemIndent + 2;
        for (;;) {
          const l = this.peek();
          if (!l || l.indent !== fieldIndent) break;
          if (l.text.startsWith("- ") || l.text === "-") break;
          const fhead = /^([A-Za-z_][A-Za-z0-9_]*): /.exec(l.text);
          if (!fhead) break;
          const fkv = this.splitKey(l.text)!;
          this.pos += 1;
          obj[fkv.key] = parseInlineScalar(fkv.rest);
        }
        arr.push(obj);
        continue;
      }
      arr.push(parseInlineScalar(after));
    }
    return arr;
  }

  // build-vault block scalar: `key: |-` then each content line indented by
  // keyIndent + 2 spaces, with the final trailing newline(s) stripped on emit.
  private parseBlockScalar(keyIndent: number): string {
    const contentIndent = keyIndent + 2;
    const out: string[] = [];
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      const isBlank = line.raw.trim() === "";
      if (!isBlank && line.indent < contentIndent) break;
      // Strip exactly the content indent; blank lines may be shorter.
      const stripped = line.raw.startsWith(" ".repeat(contentIndent))
        ? line.raw.slice(contentIndent)
        : line.raw.slice(Math.min(line.raw.length, contentIndent));
      out.push(stripped);
      this.pos += 1;
    }
    // Emitter stripped trailing newlines before writing; mirror that so the
    // value matches the source exactly.
    return out.join("\n").replace(/\n+$/, "");
  }

}

// ---- frontmatter / body extraction ----------------------------------------

// build-vault は LF で書くが、core.autocrlf=true の git は Windows チェックアウトで
// LF→CRLF に変換する。パーサ(と churn 判定)は LF を前提にするので、入口で CRLF を LF へ
// 正規化して Windows チェックアウトの vault も読めるようにする。これは git autocrlf の
// 逆変換にあたり、build-vault が書いた本来の LF を復元するだけなので round-trip 等価性を壊さない。
export function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

function splitFrontmatter(content: string): { fm: string; body: string } {
  if (!content.startsWith("---\n")) {
    throw new Error("missing frontmatter open fence");
  }
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("missing frontmatter close fence");
  const fm = content.slice(4, end);
  const body = content.slice(end + 5);
  return { fm, body };
}

function extractMarked(
  body: string,
  name: "description" | "raw_content"
): string | undefined {
  // Accept the current `graphrag:` marker and the legacy `gestalty:` one so
  // vaults generated by older builds still round-trip.
  const tryNamespace = (ns: string): string | undefined => {
    const begin = `<!-- ${ns}:${name}:begin -->`;
    const end = `<!-- ${ns}:${name}:end -->`;
    const bi = body.indexOf(begin);
    if (bi < 0) return undefined;
    const ei = body.indexOf(end, bi);
    if (ei < 0) return undefined;
    // build-vault writes: marker line, "\n", value, "\n", marker line.
    let inner = body.slice(bi + begin.length, ei);
    if (inner.startsWith("\n")) inner = inner.slice(1);
    if (inner.endsWith("\n")) inner = inner.slice(0, -1);
    return inner;
  };
  return tryNamespace("graphrag") ?? tryNamespace("gestalty");
}

// ---- public API -----------------------------------------------------------

export interface ImportedGraph {
  nodes: Record<string, Json>[];
  edges: Record<string, Json>[];
}

export function importVaultFile(content: string): {
  node: Record<string, Json>;
  edges: Record<string, Json>[];
} {
  const { fm, body } = splitFrontmatter(normalizeEol(content));
  const parser = new BlockParser(fm);
  const fmObj = parser.parse();

  const node: Record<string, Json> = {};
  for (const [k, v] of Object.entries(fmObj)) {
    if (k === "links" || k === "graph_edges") continue; // decoration / edges
    node[k] = v;
  }

  const description = extractMarked(body, "description");
  if (description !== undefined) node.description = description;
  const rawContent = extractMarked(body, "raw_content");
  if (rawContent !== undefined) node.raw_content = rawContent;

  // Round-trip the banner-only `generated_at`. build-vault emits it ONLY in the
  // banner ("source snapshot: <iso>"), never as frontmatter, so recover it from
  // the body verbatim (opaque string; not parsed as Date). Legacy/banner-less
  // files leave generated_at unset (a new stamp is assigned on next build).
  const snapshot = /source snapshot:\s*(\S+)/.exec(body);
  if (snapshot) node.generated_at = snapshot[1];

  const rawEdges = fmObj["graph_edges"];
  const edges: Record<string, Json>[] = Array.isArray(rawEdges)
    ? (rawEdges.filter(
        (e) => e && typeof e === "object" && !Array.isArray(e)
      ) as Record<string, Json>[])
    : [];
  return { node, edges };
}

export function importVault(dir: string): ImportedGraph {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const abs = path.join(d, entry);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (entry.endsWith(".md")) files.push(abs);
    }
  };
  walk(dir);
  files.sort();

  const nodes: Record<string, Json>[] = [];
  const edges: Record<string, Json>[] = [];
  const seenEdgeIds = new Set<string>();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const { node, edges: fileEdges } = importVaultFile(content);
    nodes.push(node);
    for (const e of fileEdges) {
      const id = typeof e.id === "string" ? e.id : JSON.stringify(e);
      if (seenEdgeIds.has(id)) continue;
      seenEdgeIds.add(id);
      edges.push(e);
    }
  }
  return { nodes, edges };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // 入力 vault: CLI 引数 > GRAPHRAG_VAULT_DIR env > エラー停止 (skill 配下 default 撤廃)
  const dir = argv[0] ?? process.env.GRAPHRAG_VAULT_DIR;
  if (!dir) {
    console.error("Refusing to import: vault directory not specified.");
    console.error("Pass it as the first CLI argument or set GRAPHRAG_VAULT_DIR env.");
    process.exit(1);
  }
  // 出力 graph.json: 第 2 引数 > GRAPHRAG_GRAPH_JSON_PATH env > stdout
  const outPath = argv[1] ?? process.env.GRAPHRAG_GRAPH_JSON_PATH;
  const graph = importVault(dir);
  if (outPath) {
    const fs = await import("node:fs");
    fs.writeFileSync(outPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      wrote: outPath,
      nodes: graph.nodes.length,
      edges: graph.edges.length
    }, null, 2));
  } else {
    console.log(JSON.stringify(graph, null, 2));
  }
}

// Standalone entry (preserve backward compat for direct invocation)
if (process.argv[1] && process.argv[1].endsWith("import-vault.ts")) {
  await main();
}

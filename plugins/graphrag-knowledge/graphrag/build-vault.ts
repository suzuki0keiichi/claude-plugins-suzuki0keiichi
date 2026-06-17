import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { deriveShortLabel } from "./labels.ts";

// Minimal, conservative YAML emitter for the node value shapes we have
// (string / number / boolean / null / string[] / nested plain object).
// Strings with newlines use a literal block scalar (verbatim, no escaping).
// Single-line strings are always double-quoted and escaped.

function escapeInline(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
}

function emitScalar(value: unknown, indent: string): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const str = String(value);
  if (str.includes("\n")) {
    const lines = str.replace(/\n+$/, "").split("\n");
    return ["|-", ...lines.map((line) => `${indent}  ${line}`)].join("\n");
  }
  return `"${escapeInline(str)}"`;
}

function emitValue(key: string, value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}${key}: []`;
    const items = value
      .map((item) => `${indent}  - ${emitScalar(item, `${indent}  `)}`)
      .join("\n");
    return `${indent}${key}:\n${items}`;
  }
  if (value && typeof value === "object") {
    const inner = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => emitValue(k, v, `${indent}  `))
      .join("\n");
    return `${indent}${key}:\n${inner}`;
  }
  const scalar = emitScalar(value, indent);
  return `${indent}${key}: ${scalar}`;
}

export function slugifyTitle(title: string, fallback: string): string {
  const illegal = /[\/\\:*?"<>|]/g;
  const cleaned = String(title ?? "")
    .replace(illegal, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return cleaned || String(fallback ?? "node").replace(illegal, "-").slice(0, 80);
}

export function buildVaultFiles(graph: any) {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];

  // Stable, collision-free filename per node (unique within its type folder).
  // Collision suffixes (`-2`, `-3`, …) are assigned in node-id order, NOT in the
  // input array order. importVault returns nodes in vault file-path order, so an
  // array-order assignment made the filename↔node mapping flip every round-trip
  // for same-slug nodes (e.g. two `index.ts`): the suffix swapped, every linking
  // node's wikilink churned, and a partial multi-file write could leave two files
  // holding the same node id. Sorting by id makes buildVaultFiles a pure function
  // of identity, so import→build is idempotent regardless of input ordering.
  const usedByFolder = new Map<string, Set<string>>();
  const fileById = new Map<string, { folder: string; base: string }>();
  const orderedForNaming = [...nodes].sort((a: any, b: any) =>
    String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
  );
  for (const node of orderedForNaming) {
    const folder = String(node.type ?? "Unknown");
    if (!usedByFolder.has(folder)) usedByFolder.set(folder, new Set());
    const used = usedByFolder.get(folder)!;
    const baseSlug = slugifyTitle(deriveShortLabel(node), node.id);
    let candidate = baseSlug;
    let n = 2;
    while (used.has(candidate)) {
      candidate = `${baseSlug}-${n}`;
      n += 1;
    }
    used.add(candidate);
    fileById.set(node.id, { folder, base: candidate });
  }

  // Outgoing edges grouped by source node. Each edge is carried verbatim (all
  // fields, node ids / edge id unmodified) so the vault round-trips losslessly.
  const outByNode = new Map<string, Record<string, unknown>[]>();
  for (const edge of edges) {
    if (!outByNode.has(edge.from)) outByNode.set(edge.from, []);
    outByNode.get(edge.from)!.push(edge as Record<string, unknown>);
  }

  const titleById = new Map<string, string>(
    nodes.map((x: any) => [x.id, String(x.title ?? x.id)])
  );
  const linkFor = (id: string) => {
    const f = fileById.get(id);
    if (!f) return `"${id} (missing node)"`;
    const title = (titleById.get(id) ?? id).replace(/[\[\]"|]/g, " ");
    return `"[[${f.folder}/${f.base}|${title}]]"`;
  };

  const files: { relPath: string; content: string }[] = [];

  for (const node of nodes) {
    // Banner timestamp is PER NODE so an unchanged node round-trips byte-for-byte
    // (importVault restores node.generated_at from the banner). Fall back to the
    // graph-level stamp, then to now() for genuinely new nodes.
    const generatedAt =
      node.generated_at ?? graph.generated_at ?? new Date().toISOString();
    const { folder, base } = fileById.get(node.id)!;
    const outgoing = outByNode.get(node.id) ?? [];
    // `linksByType` drives ONLY the human/Obsidian-facing decoration (the
    // `links:` frontmatter and the `## 関係` body wikilinks). `graph_edges:`
    // below is built from `outgoing` independently and stays authoritative for
    // round-trip. (v3.3: System ノードと contains の撤去により、かつての
    // System super-hub 抑制分岐は存在理由ごと消滅した。全ノードの edge が
    // そのまま wikilink になる。)
    const linksByType = new Map<string, string[]>();
    for (const e of outgoing) {
      const etype = String(e.type ?? "");
      if (!linksByType.has(etype)) linksByType.set(etype, []);
      linksByType.get(etype)!.push(linkFor(String(e.to)));
    }

    // Frontmatter = authoritative for small structured fields + links.
    // The large prose fields (description, raw_content) live in the body as
    // strictly-delimited sections; the importer round-trips those from the
    // body markers, everything else from here.
    // `generated_at` is excluded from frontmatter: it drives ONLY the banner
    // timestamp (round-tripped from the banner on import), never a fm line.
    const BODY_FIELDS = new Set(["description", "raw_content", "generated_at"]);
    const fmLines: string[] = [];
    for (const [k, v] of Object.entries(node)) {
      if (BODY_FIELDS.has(k)) continue;
      // 値が undefined のフィールドは「無い」と同じ。書き出すと null として
      // 復活し round-trip が崩れる (undefined→null) ため skip する。
      if (v === undefined) continue;
      fmLines.push(emitValue(k, v, ""));
    }
    // Authoritative, machine-readable, language-independent edge records.
    // The importer reconstructs edges ONLY from here (node ids / edge id /
    // every edge field are emitted verbatim). The `links:` wikilinks and the
    // `## 関係` body section below are human-facing decoration only.
    if (outgoing.length > 0) {
      fmLines.push("graph_edges:");
      for (const e of outgoing) {
        const entries = Object.entries(e);
        if (entries.length === 0) {
          fmLines.push("  - {}");
          continue;
        }
        // Edge records are flat scalar maps (id/type/from/to + optional
        // scalar fields). Emit as a block-mapping list item; the importer
        // pairs the `-` line with the following indented `key: scalar` lines.
        entries.forEach(([k, v], i) => {
          const prefix = i === 0 ? "  - " : "    ";
          fmLines.push(`${prefix}${k}: ${emitScalar(v, "    ")}`);
        });
      }
    } else {
      fmLines.push("graph_edges: []");
    }
    if (linksByType.size > 0) {
      fmLines.push("links:");
      for (const [etype, arr] of linksByType) {
        fmLines.push(`  ${etype}:`);
        for (const l of arr) fmLines.push(`    - ${l}`);
      }
    } else {
      fmLines.push("links: {}");
    }

    // Body = two-part readable document. Value order: description (semantic
    // distillation) on top, raw source log after. Strict HTML-comment markers
    // make the prose fields machine-round-trippable while staying invisible in
    // rendered Markdown/Obsidian.
    // Round-trip markers wrap ONLY the canonical `description` field. The
    // human-readable section may fall back to `summary` for display, but that
    // fallback text stays outside the markers so the importer never resurrects
    // a `description` the source node did not have.
    const hasDescription =
      typeof node.description === "string" && node.description.trim() !== "";
    const rawText =
      typeof node.raw_content === "string" && node.raw_content.trim()
        ? node.raw_content
        : "";
    const bodyLines: string[] = [];
    bodyLines.push(
      `> 生成物 — 直接編集しない。正本は vault (この markdown 自身)。source snapshot: ${generatedAt}`
    );
    bodyLines.push("");
    bodyLines.push(`# ${deriveShortLabel(node)}`);
    bodyLines.push("");
    // `## 説明` は description (蒸留散文) がある時だけ出す。description が無い時に
    // summary を body へ流用すると、frontmatter の summary と一字一句同じ本文が
    // `## 説明` 見出し付きで出て「説明したのに情報ゼロ」に見える (丸写しの冗長)。
    // summary は frontmatter に残る (Obsidian properties で可視) ので body から
    // 落としても消失はしない。厚い説明が要るなら description を埋める運用。
    if (hasDescription) {
      bodyLines.push("## 説明");
      bodyLines.push("");
      bodyLines.push("<!-- graphrag:description:begin -->");
      bodyLines.push(node.description);
      bodyLines.push("<!-- graphrag:description:end -->");
      bodyLines.push("");
    }
    if (linksByType.size > 0) {
      bodyLines.push("## 関係");
      bodyLines.push("");
      for (const [etype, arr] of linksByType) {
        for (const l of arr) {
          bodyLines.push(`- ${etype} → ${l.slice(1, -1)}`);
        }
      }
      bodyLines.push("");
    }
    if (rawText) {
      bodyLines.push("## 一次情報");
      bodyLines.push("");
      bodyLines.push(
        `_逐語の一次情報。${node.raw_content_status ? `raw_content_status: ${node.raw_content_status}。` : ""}説明で足りない時のみ読む。_`
      );
      bodyLines.push("");
      bodyLines.push("<!-- graphrag:raw_content:begin -->");
      bodyLines.push(rawText);
      bodyLines.push("<!-- graphrag:raw_content:end -->");
      bodyLines.push("");
    }

    const content =
      "---\n" + fmLines.join("\n") + "\n---\n\n" + bodyLines.join("\n");

    // relPath は vault フォーマットの一部 (wikilink と同じ canonical な POSIX `/`)。
    // path.join だと Windows で `\` になり、`/` 前提の wikilink (linkFor) や relPath 照合と
    // 不整合になるため、明示的に `/` で組む。実書き込み側は path.join(dir, relPath) で
    // OS 区切りに正規化するので、`/` のままでクロスプラットフォームに動く。
    files.push({ relPath: `${folder}/${base}.md`, content });
  }

  return files;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  // 出力先の決定: CLI 引数 > env > エラー停止
  // スキルリポジトリ配下の default は意図的に提供しない (利用先プロジェクトの知識が
  // スキルリポジトリに混入するのを避けるため。明示指定を強制する)。
  const graphPath = argv[0] ?? process.env.GRAPHRAG_GRAPH_JSON_PATH;
  const outDir = argv[1] ?? process.env.GRAPHRAG_VAULT_DIR;
  if (!graphPath) {
    console.error("Refusing to build vault: graph.json input path is not specified.");
    console.error("Pass it as the first CLI argument or set GRAPHRAG_GRAPH_JSON_PATH env.");
    console.error("Note: graph.json is a transitional safety artifact; the future direction is the Obsidian vault alone.");
    process.exit(1);
  }
  if (!outDir) {
    console.error("Refusing to build vault: vault output directory is not specified.");
    console.error("Pass it as the second CLI argument or set GRAPHRAG_VAULT_DIR env.");
    console.error("(No default under the skill directory is provided — knowledge belongs to the consuming project, not the skill repository.)");
    process.exit(1);
  }
  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  const provisionalCount = (graph.nodes ?? []).filter(
    (n: any) => n.summary_provisional === true
  ).length;
  if (provisionalCount > 0) {
    console.error(
      `[warn] 要約がテンプレのまま (summary_provisional): ${provisionalCount}件 (File / Component / Layer 等) を vault に書き出す。` +
      `意味の要約に書き換えて summary_provisional を外すまで、検索・vein-hint の品質は落ちたまま。`
    );
  }
  const files = buildVaultFiles(graph);
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  for (const f of files) {
    const abs = path.join(outDir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  const byFolder: Record<string, number> = {};
  for (const f of files) {
    const folder = f.relPath.split("/")[0];
    byFolder[folder] = (byFolder[folder] ?? 0) + 1;
  }
  console.log(`vault: ${files.length} files -> ${outDir}/`);
  console.log(JSON.stringify(byFolder, null, 2));
}

// Standalone entry (preserve backward compat for direct invocation)
if (process.argv[1] && process.argv[1].endsWith("build-vault.ts")) {
  main();
}

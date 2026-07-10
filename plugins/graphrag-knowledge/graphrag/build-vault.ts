import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { deriveShortLabel } from "./labels.ts";
import { importVault } from "./import-vault.ts";
import { assertVaultWriteAllowed, reportVaultResolution } from "./cli-env.ts";

// Minimal, conservative YAML emitter for the node value shapes we have
// (string / number / boolean / null / string[] / nested plain object).
// Strings with newlines use a literal block scalar (verbatim, no escaping).
// Single-line strings are always double-quoted and escaped.

function escapeInline(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

// A `|-` block scalar carries its lines verbatim (no escaping), so it can only
// represent strings the chomping round-trips exactly:
//   - no \r anywhere (the importer's normalizeEol rewrites CRLF→LF on read, and
//     toLines strips a trailing \r per line, so CR would be silently lost), and
//   - no trailing newline (`|-` strips ALL trailing newlines on both sides).
// Anything else goes through the inline double-quoted form with \n/\r escaped.
function blockScalarSafe(str: string): boolean {
  return !str.includes("\r") && !str.endsWith("\n");
}

function emitScalar(value: unknown, indent: string): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const str = String(value);
  if (str.includes("\n") && blockScalarSafe(str)) {
    return ["|-", ...str.split("\n").map((line) => `${indent}  ${line}`)].join("\n");
  }
  return `"${escapeInline(str)}"`;
}

// graph_edges records are flat scalar maps parsed line-by-line on import
// (`- key: scalar` + indented `key: scalar` siblings); a block scalar inside a
// `- ` item is not part of that grammar, so edge values are ALWAYS emitted as
// single-line (escaped) scalars regardless of embedded newlines.
function emitInlineScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `"${escapeInline(String(value))}"`;
}

// Human-facing decoration (body H1, wikilink display text, the raw_content
// italics line) must stay single-line — a raw newline inside a `links:` item
// breaks the frontmatter line grammar and can leak text fragments back in as
// bogus node fields — and must never contain a round-trip marker: the importer
// matches `<!-- graphrag:...:begin/end -->` by indexOf over the WHOLE body, so
// a title carrying a literal marker would hijack extractMarked() and corrupt
// description/raw_content. Only marker-forming `<!--` prefixes are rewritten
// (plain HTML comments in titles stay byte-identical — no churn).
function sanitizeDecoration(value: unknown): string {
  return String(value)
    .replace(/\r\n?|\n/g, " ")
    .replace(/<!--(\s*(?:graphrag|gestalty):)/g, "<! --$1");
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
  // Beyond the classic path-hostile punctuation, strip C0/C1 control chars:
  // NUL is an outright invalid path byte (writeFileSync throws), and the rest
  // (BEL, ESC, …) make filenames that shells/editors mishandle. `\s+` below
  // only covers the whitespace-class controls (\t \n \r \f \v), not these.
  const illegal = /[\/\\:*?"<>|\u0000-\u001f\u007f-\u009f]/g;
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
  // Collision detection must be case- AND Unicode-normalization-insensitive:
  // APFS (macOS default) and NTFS treat `ABC.md` / `abc.md` — and NFC/NFD
  // spellings of the same accented name — as the SAME file, so a case-only or
  // normalization-only distinction would make the second write silently
  // overwrite the first node on disk (one node lost per collision pair).
  const collisionKey = (s: string) => s.normalize("NFC").toLowerCase();
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
    while (used.has(collisionKey(candidate))) {
      candidate = `${baseSlug}-${n}`;
      n += 1;
    }
    used.add(collisionKey(candidate));
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
    if (!f) return `"${sanitizeDecoration(id).replace(/[\[\]"|]/g, " ")} (missing node)"`;
    const title = sanitizeDecoration(titleById.get(id) ?? id).replace(/[\[\]"|]/g, " ");
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
    //
    // description / raw_content ride in the body ONLY when the body can carry
    // them verbatim: a non-empty string without \r (the importer's normalizeEol
    // rewrites CRLF→LF before the markers are read back) and without
    // marker-forming text (a value containing `<!-- graphrag:`/`<!-- gestalty:`
    // would shift the begin/end markers extractMarked matches by indexOf).
    // Everything else — empty / whitespace-only strings, CR-bearing text,
    // marker-like text, or non-string values — round-trips through frontmatter
    // (where the escaped inline form is exact) instead of being dropped.
    const bodyCarriable = (v: unknown): v is string =>
      typeof v === "string" &&
      v.trim() !== "" &&
      !v.includes("\r") &&
      !v.includes("<!-- graphrag:") &&
      !v.includes("<!-- gestalty:");
    const descriptionInBody = bodyCarriable(node.description);
    const rawContentInBody = bodyCarriable(node.raw_content);
    const fmLines: string[] = [];
    for (const [k, v] of Object.entries(node)) {
      if (k === "generated_at") continue;
      if (k === "description" && descriptionInBody) continue;
      if (k === "raw_content" && rawContentInBody) continue;
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
        // undefined-valued edge fields are "absent", exactly like node fields
        // above — emitting them would resurrect as null and break round-trip.
        const entries = Object.entries(e).filter(([, v]) => v !== undefined);
        if (entries.length === 0) {
          fmLines.push("  - {}");
          continue;
        }
        // Edge records are flat scalar maps (id/type/from/to + optional
        // scalar fields). Emit as a block-mapping list item; the importer
        // pairs the `-` line with the following indented `key: scalar` lines.
        // Values are inline-only (emitInlineScalar): a `|-` block scalar is
        // not part of the importer's edge-record grammar.
        entries.forEach(([k, v], i) => {
          const prefix = i === 0 ? "  - " : "    ";
          fmLines.push(`${prefix}${k}: ${emitInlineScalar(v)}`);
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
    const hasDescription = descriptionInBody;
    const rawText = rawContentInBody ? node.raw_content : "";
    const bodyLines: string[] = [];
    bodyLines.push(
      `> 生成物 — 直接編集しない。正本は vault (この markdown 自身)。source snapshot: ${generatedAt}`
    );
    bodyLines.push("");
    bodyLines.push(`# ${sanitizeDecoration(deriveShortLabel(node))}`);
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
        `_逐語の一次情報。${node.raw_content_status ? `raw_content_status: ${sanitizeDecoration(node.raw_content_status)}。` : ""}説明で足りない時のみ読む。_`
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

// vault-build は graph.json から vault を全消し→再構築する初回構築用の primitive。
// 索引 (graph.json) には File / Pocket / Stratum しか入らないので、手動で書き戻された
// 知識ノード (Decision / OK / Risk / Constraint / Vein …) が既に在る vault に対して
// 実行すると、それらは索引に居ないまま rmSync で消える。これを実行時に検知するため、
// 「target vault に在って source graph に無いノード」= 上書きで失われるノードを返す。
// 空配列なら損失なし (空 vault の初回構築・graph が superset の再索引) で安全に通せる。
export function nodesLostByOverwrite(
  existingGraph: { nodes?: any[] },
  sourceGraph: { nodes?: any[] }
): { id: string; type: string }[] {
  const sourceIds = new Set((sourceGraph.nodes ?? []).map((n: any) => String(n.id)));
  return (existingGraph.nodes ?? [])
    .filter((n: any) => !sourceIds.has(String(n.id)))
    .map((n: any) => ({ id: String(n.id), type: String(n.type ?? "Unknown") }));
}

export function main(argv: string[] = process.argv.slice(2)): void {
  // フラグ (--force) は位置引数の前後どこに来てもよいよう分離する。
  const flags = argv.filter((a) => a.startsWith("--"));
  const positionals = argv.filter((a) => !a.startsWith("--"));
  const force = flags.includes("--force") || process.env.GRAPHRAG_VAULT_BUILD_FORCE === "1";
  // 出力先の決定: CLI 引数 > env > エラー停止
  // スキルリポジトリ配下の default は意図的に提供しない (利用先プロジェクトの知識が
  // スキルリポジトリに混入するのを避けるため。明示指定を強制する)。
  const graphPath = positionals[0] ?? process.env.GRAPHRAG_GRAPH_JSON_PATH;
  const outDir = positionals[1] ?? process.env.GRAPHRAG_VAULT_DIR;
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
  // vault-build は outDir を全消し→再構築する最も破壊的な write verb。typed-add /
  // commit-mutation と同じ隔離ゲートをここでも通す (readonly / 外部 vault のローカル
  // mode 未設定は拒否)。--force はこのゲートを迂回しない (--force は「損失を承知で
  // 上書きする」であって「隔離方針を無視する」ではない)。
  assertVaultWriteAllowed({ vaultDir: outDir });
  const vaultResolution = reportVaultResolution(outDir, positionals[1] ? "cli-arg" : undefined);
  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  const provisionalCount = (graph.nodes ?? []).filter(
    (n: any) => n.summary_provisional === true
  ).length;
  if (provisionalCount > 0) {
    console.error(
      `[warn] summaries still template-only (summary_provisional): writing ${provisionalCount} node(s) (File / Component / Layer, etc.) to the vault. ` +
      `Until you rewrite them into meaningful summaries and clear summary_provisional, search / concern-hint quality stays degraded.`
    );
  }
  const files = buildVaultFiles(graph);
  // 上書きガード: vault-build は outDir を全消し→再構築する。既存 vault に索引外の
  // 知識ノードが在ると黙って消えるので、rmSync の前に「失われるノード」を検査する。
  // --force (または GRAPHRAG_VAULT_BUILD_FORCE=1) で明示的に握りつぶせる。
  if (existsSync(outDir) && !force) {
    let blocked = false;
    try {
      const lost = nodesLostByOverwrite(importVault(outDir), graph);
      if (lost.length > 0) {
        blocked = true;
        const byType: Record<string, number> = {};
        for (const n of lost) byType[n.type] = (byType[n.type] ?? 0) + 1;
        console.error(
          `Refusing to build vault: ${outDir} already contains ${lost.length} node(s) absent from the source graph.`
        );
        console.error(
          `These are absent from the index (graph.json) and will be lost by vault-build's full wipe: ${JSON.stringify(byType)}`
        );
        console.error(
          "vault-build is for the initial build of an empty vault. To re-index a vault with accumulated knowledge, import the existing vault first" +
          " and use a merge mutation/reconcile flow (normal writes go through commit-mutation, which writes directly to the vault without graph.json)."
        );
      }
    } catch (err) {
      // 既存ディレクトリを vault として読めない = 上書きで失う知識が無いと保証できない。安全側で止める。
      blocked = true;
      console.error(
        `Refusing to build vault: existing directory ${outDir} could not be read as a vault ` +
        `(${err instanceof Error ? err.message : String(err)}).`
      );
      console.error(
        "vault-build wipes this directory and rebuilds it, but since its contents cannot be verified, it cannot guarantee that overwriting loses no knowledge."
      );
    }
    if (blocked) {
      console.error("If you really must wipe and rebuild, re-run with --force.");
      process.exit(1);
    }
  }
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
  console.log(JSON.stringify({ ...vaultResolution, files_by_folder: byFolder }, null, 2));
}

// Standalone entry (preserve backward compat for direct invocation)
if (process.argv[1] && process.argv[1].endsWith("build-vault.ts")) {
  main();
}

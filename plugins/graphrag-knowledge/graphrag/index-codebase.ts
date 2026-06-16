// Generic codebase indexer. Redesigned from the originating project's essence
// (see references/indexer-redesign-notes.md), NOT a blind port. No project-specific
// rules. Targets the existing schema only (System / File + Vein / Pocket
// / Stratum candidates; contains / evidenced_by edges). Symbols/imports stay as
// File fields (see references/carving-rationale.md), woven into the embedding
// summary. Output feeds graph:falkor:sync / build-vault / graph:vector:index.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateGraph } from "./schema.ts";
import { importVault } from "./import-vault.ts";

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage", ".next",
  ".turbo", ".cache", "vendor", "target", "__pycache__", ".venv", "venv",
  // graphrag 自身の成果物 (vault / 索引キャッシュ)。既定 vault は <root>/.graphrag/vault に
  // 置かれるため、これを索引すると vault の *.md を File として自己索引してしまう。
  ".graphrag"
]);

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
  ".rb": "ruby", ".php": "php", ".cs": "csharp", ".swift": "swift",
  ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell",
  ".md": "markdown", ".mdx": "markdown",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".sql": "sql"
};

const TEXT_MAX_BYTES = 512 * 1024;

function slug(value: string): string {
  return String(value)
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 120) || "x";
}

// Deterministic, order-independent disambiguation. slug() is lossy for
// non-ASCII paths (e.g. Japanese filenames collapse to the same base), so any
// base shared by >1 key gets a stable sha1(key) suffix for every member.
// Singletons keep the clean slug. Same key -> same id across re-index runs.
function disambiguate(keys: string[]): Map<string, string> {
  const byBase = new Map<string, string[]>();
  for (const k of keys) {
    const b = slug(k);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b)!.push(k);
  }
  const out = new Map<string, string>();
  for (const list of byBase.values()) {
    for (const k of list) {
      out.set(k, list.length === 1 ? "" : `~${createHash("sha1").update(k).digest("hex").slice(0, 8)}`);
    }
  }
  return out;
}

// git ls-files が graphrag 自身の成果物 (<root>/.graphrag/vault 等) を列挙したときに除外する。
// vault が main repo に tracked だと ls-files が拾い、vault の *.md を File として自己索引して
// しまうため。ここでは .graphrag のみに絞る: その他の SKIP_DIRS (vendor/dist/target 等) を
// ls-files 出力から落とすと、意図的に tracked している repo の既存挙動を変えてしまうので
// 触らない (git 管理外は gitignore で既に除かれる)。walk 経路は従来どおり SKIP_DIRS 全体を見る。
function isGraphragArtifactPath(rel: string): boolean {
  return rel.split("/").includes(".graphrag");
}

function listFiles(root: string): string[] {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const files = out.split("\0").filter(Boolean);
    if (files.length > 0) return files.filter((f) => !isGraphragArtifactPath(f));
  } catch {
    /* not a git repo or git unavailable; fall back to walk */
  }
  const acc: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".github") {
        if (SKIP_DIRS.has(entry.name)) continue;
      }
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      // git ls-files は POSIX `/` を返す。非 git の walk フォールバックも同じく `/` に
      // 正規化する (Windows の `\` のままだと import 解決が path.posix を使うため壊れ、
      // 依存コミュニティ=Pocket 検出が機能しなくなる)。
      else if (entry.isFile()) acc.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  };
  walk(root);
  return acc;
}

function gitHead(root: string): string | null {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function langFor(rel: string): string {
  return LANG_BY_EXT[path.extname(rel).toLowerCase()] ?? "text";
}

function roleFor(rel: string, lang: string): string {
  const p = rel.toLowerCase();
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p)) return "test";
  if (lang === "markdown") return "documentation";
  if (/(^|\/)(docs?|adr)\//.test(p)) return "documentation";
  if (lang === "json" || lang === "yaml" || lang === "toml") return "config";
  if (/(^|\/)(pages|app|components|ui|views)\//.test(p) && /\.(tsx|jsx|vue|svelte)$/.test(p)) return "ui_component";
  if (/(^|\/)(api|routes?|handlers?|controllers?)\//.test(p)) return "api_route";
  if (/(^|\/)(bin|cli|scripts?)\//.test(p) || /(^|\/)(main|index|cli)\.[a-z]+$/.test(p)) return "entrypoint";
  // Declaration/aggregate modules (constants, config, settings, type/schema
  // barrels) are not behavior. General to any codebase: classify as config so
  // they do not outrank implementation for behavior queries.
  const base = p.split("/").pop() || "";
  // Dotfiles, env files, and *.example/*.sample/*.template are configuration,
  // not implementation. General to any codebase.
  if (base.startsWith(".") || /\.(example|sample|template|dist|lock)$/.test(base)
      || /(^|[.\-_])env([.\-_]|$)/.test(base)) return "config";
  const stem = base.replace(/\.[a-z0-9]+$/, "");
  if (/^(constants?|config|configuration|settings?|env|types?|schema|enums?)$/.test(stem)
      || /(^|\/)(config|constants?|settings)\//.test(p)) return "config";
  return "source";
}

function extractSymbols(lang: string, text: string): { exported: string[]; local: string[]; imports: string[] } {
  const exported = new Set<string>();
  const local = new Set<string>();
  const imports = new Set<string>();
  const add = (set: Set<string>, v?: string) => { if (v && set.size < 64) set.add(v); };

  if (lang === "typescript" || lang === "javascript") {
    for (const m of text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) add(exported, m[1]);
    for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) for (const n of m[1].split(",")) add(exported, n.trim().split(/\s+as\s+/)[0].trim());
    for (const m of text.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) add(local, m[1]);
    for (const m of text.matchAll(/(?:^|\n)\s*class\s+([A-Za-z_$][\w$]*)/g)) add(local, m[1]);
    for (const m of text.matchAll(/(?:import[^"']*?from\s*|require\(\s*)["']([^"']+)["']/g)) add(imports, m[1]);
  } else if (lang === "python") {
    for (const m of text.matchAll(/(?:^|\n)\s*(?:def|class)\s+([A-Za-z_]\w*)/g)) { add(local, m[1]); if (!m[1].startsWith("_")) add(exported, m[1]); }
    for (const m of text.matchAll(/(?:^|\n)\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g)) add(imports, m[1] ?? m[2]);
  } else if (lang === "go") {
    for (const m of text.matchAll(/(?:^|\n)func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/g)) add(exported, m[1]);
    for (const m of text.matchAll(/(?:^|\n)(?:type|func)\s+([A-Za-z_]\w*)/g)) add(local, m[1]);
    for (const m of text.matchAll(/"\s*([\w./-]+)\s*"/g)) if (m[1].includes("/")) add(imports, m[1]);
  } else if (lang === "rust") {
    for (const m of text.matchAll(/pub\s+(?:fn|struct|enum|trait|mod|const)\s+([A-Za-z_]\w*)/g)) add(exported, m[1]);
    for (const m of text.matchAll(/(?:fn|struct|enum|trait|mod)\s+([A-Za-z_]\w*)/g)) add(local, m[1]);
    for (const m of text.matchAll(/use\s+([\w:]+)/g)) add(imports, m[1]);
  } else if (lang === "java" || lang === "kotlin" || lang === "csharp") {
    for (const m of text.matchAll(/public\s+(?:final\s+|abstract\s+|static\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/g)) add(exported, m[1]);
    for (const m of text.matchAll(/(?:class|interface|enum)\s+([A-Za-z_]\w*)/g)) add(local, m[1]);
    for (const m of text.matchAll(/import\s+([\w.]+)/g)) add(imports, m[1]);
  } else if (lang === "c" || lang === "cpp") {
    for (const m of text.matchAll(/(?:^|\n)[A-Za-z_][\w<>:\s\*&]*\s+([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{/g)) add(local, m[1]);
    for (const m of text.matchAll(/#include\s*[<"]([^>"]+)[>"]/g)) add(imports, m[1]);
  } else if (lang === "shell") {
    for (const m of text.matchAll(/(?:^|\n)\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/g)) add(local, m[1]);
  }
  return { exported: [...exported], local: [...local], imports: [...imports] };
}

function markdownHeadings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^#{1,3}\s+(.+)$/gm)) { if (out.length < 8) out.push(m[1].trim()); }
  return out;
}

function buildSummary(fields: any): string {
  const parts = [
    `${fields.path} は ${describeRole(fields.role)}(${fields.language})。`,
    fields.exported_symbols.length ? `主要API: ${fields.exported_symbols.slice(0, 12).join(", ")}。` : "",
    fields.local_symbols.length ? `主な内部要素: ${fields.local_symbols.slice(0, 10).join(", ")}。` : "",
    fields.imports.length ? `依存先: ${fields.imports.slice(0, 10).join(", ")}。` : "",
    fields.headings?.length ? `見出し: ${fields.headings.slice(0, 5).join(", ")}。` : ""
  ];
  return parts.filter(Boolean).join(" ");
}

function describeRole(role: string): string {
  return ({
    test: "テスト", documentation: "ドキュメント", config: "設定",
    ui_component: "UI コンポーネント", api_route: "API/ルート",
    entrypoint: "エントリポイント", source: "ソース"
  } as Record<string, string>)[role] ?? role;
}

// Generic Pocket candidates: package/module roots. No project-specific rules.
const COMPONENT_MARKERS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "CMakeLists.txt"];

export function indexCodebase(opts: { root: string; systemName?: string; previous?: any; trustPreviousSummaries?: boolean }) {
  const root = path.resolve(opts.root);
  const systemName = opts.systemName ?? path.basename(root);
  const head = gitHead(root);
  // 前回 summary を「本物として継ぐ」のは、source が信頼できる正本 (= vault) のときだけ。
  // scaffold (indexed-graph.json) は summary が常に機械テンプレなので、change_status の
  // 算出には使うが summary content は信用しない (= 常に作り直して provisional フラグを立てる)。
  const trustPrevSummaries = opts.trustPreviousSummaries === true;
  const prevById = new Map<string, any>();
  for (const n of opts.previous?.nodes ?? []) prevById.set(n.id, n);

  // v3.3: System root ノードと contains は生成しない (vault=scope)。所属は vault の
  // 存在と id 規約 (`file:<system>:<path>` 等) が既に持つため、整理エッジは冗長。
  const nodes: any[] = [];
  const edges: any[] = [];
  const files = listFiles(root).sort();
  const fileSuffix = disambiguate(files);
  const fileNodeByDir = new Map<string, string[]>();
  const fileNodeById = new Map<string, any>();
  const componentDirs = new Set<string>();
  const relById = new Map<string, string>();
  const idByRel = new Map<string, string>();
  const importsById = new Map<string, string[]>();

  for (const rel of files) {
    const abs = path.join(root, rel);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > TEXT_MAX_BYTES) continue;
    let buf: Buffer;
    try { buf = readFileSync(abs); } catch { continue; }
    if (buf.includes(0)) continue; // binary
    const text = buf.toString("utf8");
    const lang = langFor(rel);
    const role = roleFor(rel, lang);
    const sym = extractSymbols(lang, text);
    const headings = lang === "markdown" ? markdownHeadings(text) : [];
    const content_hash = createHash("sha256").update(buf).digest("hex");
    const id = `file:${slug(systemName)}:${slug(rel)}${fileSuffix.get(rel) ?? ""}`;
    const prev = prevById.get(id);
    const change_status = !prev ? "new" : prev.content_hash === content_hash ? "unchanged" : "changed";
    const aliases = [...new Set([path.basename(rel), ...sym.exported, ...headings].filter(Boolean))].slice(0, 24);

    const fields: any = {
      id, type: "File", path: rel, language: lang, role,
      exported_symbols: sym.exported, local_symbols: sym.local, imports: sym.imports,
      headings, content_hash, git_head: head, change_status, aliases,
      title: path.basename(rel)
    };
    // index-codebase は path/role/language/symbols/imports からの機械テンプレ要約しか
    // 作れない。LLM がファイルを実際に読んで「何をする/何のためのコードか」を要約に
    // 書き換えるまで、summary_provisional=true で「未完」を自己申告する。これを消費側が
    // 見る: vein-hint は拒否 (テンプレ要約だと typescript/components 等の言語語で
    // クラスタリングして縦串が無意味化する)、vector は embedding から除外 (検索汚染防止)、
    // build-vault は警告。フラグが無いと「空でない=完了」に見えて作り直しでもサボりが残る。
    // content 不変かつ前回が本物要約 (provisional でない) なら、再索引でそれを壊さず継ぐ。
    const templateSummary = buildSummary(fields);
    const reusablePrevSummary =
      trustPrevSummaries
      && prev && change_status === "unchanged"
      && typeof prev.summary === "string" && prev.summary.trim().length > 0
      && prev.summary_provisional !== true;
    if (reusablePrevSummary) {
      fields.summary = prev.summary;
    } else {
      fields.summary = templateSummary;
      fields.summary_provisional = true;
    }
    nodes.push(fields);
    fileNodeById.set(id, fields);

    const dir = path.dirname(rel) === "." ? "" : path.dirname(rel);
    if (!fileNodeByDir.has(dir)) fileNodeByDir.set(dir, []);
    fileNodeByDir.get(dir)!.push(id);
    if (COMPONENT_MARKERS.includes(path.basename(rel))) componentDirs.add(dir);
    relById.set(id, rel);
    idByRel.set(rel, id);
    importsById.set(id, sym.imports);
  }

  // --- Internal dependency graph (resolve imports -> File ids) -------------
  const relSet = new Set(idByRel.keys());
  const depOut = new Map<string, Set<string>>();   // directed: file -> deps
  const adj = new Map<string, Set<string>>();       // undirected (for clusters)
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b); adj.get(b)!.add(a);
  };
  for (const [fid, imps] of importsById) {
    const rel = relById.get(fid)!;
    const outs = new Set<string>();
    for (const imp of imps) {
      const target = resolveInternalImport(imp, rel, relSet);
      const tid = target && idByRel.get(target);
      if (tid && tid !== fid) { outs.add(tid); link(fid, tid); }
    }
    depOut.set(fid, outs);
  }

  // Pocket (旧 Component) = dependency communities (graph distance), not heuristics.
  const rawCommunities = labelPropagation(adj);

  // ディレクトリ純度による後処理分割:
  // 依存コミュニティ検出は import 距離だけ見るので、test や audit が複数領域の
  // 実装を import すると違う責務領域が同コミュニティ化する (例: tests/unit/audit/
  // が ui + core/platform + core/device を同時 import してすべて 1 cluster に)。
  // クラスタを「同一ディレクトリ群」で分割し、責務 (= ディレクトリ) と
  // コミュニティ (= 依存) の両方を満たすメンバーだけを candidate として残す。
  // 最終的に LLM が命名・統合するので、indexer 段階では「dir で過剰分割される
  // のは許容、混在で巨大化するのは却下」のバイアス。
  const dirOfFid = (fid: string) => path.posix.dirname(relById.get(fid) ?? "");
  const communities: string[][] = [];
  for (const cluster of rawCommunities) {
    if (cluster.length < 3) continue;
    const byDir = new Map<string, string[]>();
    for (const fid of cluster) {
      const d = dirOfFid(fid);
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d)!.push(fid);
    }
    // 単一 dir が 70% 以上を占有するなら、その cluster はそのまま 1 candidate
    const sorted = [...byDir.entries()].sort((a, b) => b[1].length - a[1].length);
    const dominant = sorted[0];
    if (dominant[1].length / cluster.length >= 0.7) {
      communities.push(cluster);
      continue;
    }
    // 混在なら dir 別に分割 (メンバー >= 3 の dir のみ candidate に)
    for (const [, ids] of sorted) {
      if (ids.length >= 3) communities.push(ids);
    }
  }
  let ci = 0;
  for (const members of communities) {
    if (members.length < 3) continue;
    ci += 1;
    const cid = `pocket:${slug(systemName)}:c${ci}`;
    const sampleRels = members.map((m) => relById.get(m)).filter(Boolean);
    nodes.push({
      id: cid, type: "Pocket", candidate: true,
      // candidate summary は構成要素サマリ (どの File が束ねられたか) の機械生成テンプレで
      // あって「意味」ではない。LLM が judgment_input を見て機能境界を命名し意味の summary に
      // 書き換えるまで summary_provisional=true で未完を自己申告する (File summary と対称)。
      summary_provisional: true,
      title: `Pocket candidate c${ci} (${members.length} files)`,
      summary: `依存グラフのコミュニティ検出で抽出した結合の強いファイル群(${members.length}件)。機能境界の命名・要約は LLM 判定に委ねる。`,
      signals: { kind: "dependency-community", evidence_count: members.length },
      judgment_input: {
        definition: "files tightly coupled by import dependency (graph community)",
        member_files: sampleRels.slice(0, 60),
        instruction: "この結合クラスタが表す機能境界を命名し title/summary を与える。1クラスタ=1機能領域でなければ分割/却下も可。",
        expected_output_schema: { title: "string", summary: "string", accept: "boolean" }
      }
    });
    for (const fid of members) edges.push({ id: `edge:evidenced_by:${cid}->${fid}`, type: "evidenced_by", from: cid, to: fid });
  }

  // 縦串シグナル (Concern carving 補助):
  // 各 File について「自分を import している distinct Component 数」を計算し、
  // 2 以上なら cross_component_in_degree を signals に付与する。
  // Concern (= 縦に貫く動機) は依存距離では出ないので indexer は最終判定しないが、
  // 「複数 Component から参照されているファイル群」は Concern の縦串候補になりうる。
  // LLM concept pass は cross_component_in_degree が高いファイルを Concern carving の
  // 起点として参照する (詳細は carving-rules.md 参照)。
  const compOfFile = new Map<string, string>();
  for (let i = 0; i < communities.length; i += 1) {
    const cid = `pocket:${slug(systemName)}:c${i + 1}`;
    for (const fid of communities[i]) compOfFile.set(fid, cid);
  }
  const importersByTarget = new Map<string, Set<string>>();
  for (const [fid, deps] of depOut) {
    const importerComp = compOfFile.get(fid);
    if (!importerComp) continue; // importer が candidate 外なら無視
    for (const tid of deps) {
      if (!importersByTarget.has(tid)) importersByTarget.set(tid, new Set());
      importersByTarget.get(tid)!.add(importerComp);
    }
  }
  for (const [fid, comps] of importersByTarget) {
    if (comps.size < 2) continue;
    const node = fileNodeById.get(fid);
    if (!node) continue;
    node.cross_component_in_degree = comps.size;
    node.imported_from_components = [...comps];
  }

  // Stratum (旧 Layer) = position in the dependency DAG (graph topology), banded.
  const depthOf = dependencyDepth(depOut);
  const maxDepth = Math.max(0, ...depthOf.values());
  const BANDS = maxDepth >= 3 ? 4 : maxDepth + 1;
  const bandOf = (d: number) => maxDepth === 0 ? 0 : Math.min(BANDS - 1, Math.floor((d / (maxDepth + 1e-9)) * BANDS));
  const byBand = new Map<number, string[]>();
  for (const [fid, d] of depthOf) {
    const b = bandOf(d);
    if (!byBand.has(b)) byBand.set(b, []);
    byBand.get(b)!.push(fid);
  }
  for (const [b, ids] of [...byBand.entries()].sort((x, y) => x[0] - y[0])) {
    if (ids.length < 4) continue;
    const lid = `stratum:${slug(systemName)}:band${b}`;
    nodes.push({
      id: lid, type: "Stratum", candidate: true,
      // candidate summary は構成要素サマリ (深さ帯にどの File が居るか) の機械生成テンプレ。
      // LLM がアーキ層の意味を命名し summary に書き換えるまで provisional (File と対称)。
      summary_provisional: true,
      title: `Stratum band ${b}/${BANDS - 1} (${ids.length} files)`,
      summary: `依存トポロジの深さ帯 band ${b}(0=基盤・依存される側 〜 大=入口・依存する側)。アーキ層の命名は LLM 判定に委ねる。`,
      signals: { kind: "dependency-topology-band", depth_band: b, evidence_count: ids.length },
      judgment_input: {
        definition: "files at the same depth band in the import dependency DAG (0 = most depended-upon foundation, higher = entry/presentation)",
        member_files: ids.map((i) => relById.get(i)).filter(Boolean).slice(0, 60),
        instruction: "この依存深さ帯が示すアーキ層を命名し title/summary を与える。",
        expected_output_schema: { title: "string", summary: "string" }
      }
    });
    for (const fid of ids.slice(0, 100)) edges.push({ id: `edge:evidenced_by:${lid}->${fid}`, type: "evidenced_by", from: lid, to: fid });
  }

  const deleted = [...prevById.values()].filter((n) => n.type === "File" && !nodes.some((x) => x.id === n.id)).map((n) => n.id);
  const graph = { version: 1, generated_at: new Date().toISOString(), nodes, edges, stale_candidates: { deleted_files: deleted } };
  return graph;
}

function collectUnder(byDir: Map<string, string[]>, dir: string): string[] {
  const out: string[] = [];
  for (const [d, ids] of byDir) {
    if (d === dir || d.startsWith(dir ? `${dir}/` : "")) out.push(...ids);
  }
  return out;
}

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts",
  "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

// Best-effort, general resolution of an import specifier to an internal repo
// file path. Handles relative (./ ../), common src-alias (@/, ~/, @app/), and
// bare paths that match a known file. External (node_modules) -> null.
function resolveInternalImport(imp: string, fromRel: string, relSet: Set<string>): string | null {
  if (!imp) return null;
  let base: string | null = null;
  if (imp.startsWith(".")) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), imp));
  } else if (/^(@\/|~\/|@app\/|@\/)/.test(imp) || imp.startsWith("@/")) {
    const rest = imp.replace(/^(@|~)\//, "");
    for (const pre of ["src/", "app/", "", "lib/"]) {
      for (const ext of RESOLVE_EXTS) if (relSet.has(`${pre}${rest}${ext}`)) return `${pre}${rest}${ext}`;
    }
    base = `src/${rest}`;
  } else {
    // bare: only treat as internal if it directly matches a known file
    for (const ext of RESOLVE_EXTS) if (relSet.has(`${imp}${ext}`)) return `${imp}${ext}`;
    return null;
  }
  for (const ext of RESOLVE_EXTS) if (relSet.has(`${base}${ext}`)) return `${base}${ext}`;
  return null;
}

// Deterministic label propagation community detection on an undirected graph.
// Ubiquitous hub files (imported almost everywhere: prisma, constants, auth
// helpers) blur communities into one giant blob, so edges through very
// high-degree nodes are dropped for the clustering pass (general, parameter-
// free: hub = degree above mean + 2*stddev, capped at >12% of nodes).
function labelPropagation(rawAdj: Map<string, Set<string>>): string[][] {
  const allNodes = [...rawAdj.keys()];
  const deg = (n: string) => rawAdj.get(n)?.size ?? 0;
  const degs = allNodes.map(deg);
  const mean = degs.reduce((a, b) => a + b, 0) / Math.max(1, degs.length);
  const sd = Math.sqrt(degs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, degs.length));
  const hubCut = Math.max(mean + 2 * sd, 0.12 * allNodes.length);
  // Only damp hubs on graphs large enough for a giant-community to be a real
  // problem; small graphs/clusters must stay intact.
  const dampHubs = allNodes.length >= 25;
  const isHub = (n: string) => dampHubs && deg(n) > hubCut;
  const adj = new Map<string, Set<string>>();
  for (const n of allNodes) {
    if (isHub(n)) continue;
    const keep = new Set<string>();
    for (const m of rawAdj.get(n) ?? []) if (!isHub(m)) keep.add(m);
    adj.set(n, keep);
  }
  const nodes = [...adj.keys()].sort();
  const label = new Map<string, string>();
  for (const n of nodes) label.set(n, n);
  for (let iter = 0; iter < 30; iter += 1) {
    let changed = false;
    for (const n of nodes) {
      const counts = new Map<string, number>();
      for (const m of adj.get(n) ?? []) {
        const l = label.get(m)!;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      if (counts.size === 0) continue;
      // pick max count; tie -> lexically smallest label (determinism)
      let best = label.get(n)!;
      let bestC = -1;
      for (const [l, c] of [...counts.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
        if (c > bestC) { best = l; bestC = c; }
      }
      if (best !== label.get(n)) { label.set(n, best); changed = true; }
    }
    if (!changed) break;
  }
  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const l = label.get(n)!;
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l)!.push(n);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

// Longest internal-dependency chain depth per file (cycles guarded).
function dependencyDepth(depOut: Map<string, Set<string>>): Map<string, number> {
  const memo = new Map<string, number>();
  const stack = new Set<string>();
  const visit = (n: string): number => {
    if (memo.has(n)) return memo.get(n)!;
    if (stack.has(n)) return 0;
    stack.add(n);
    let d = 0;
    for (const m of depOut.get(n) ?? []) d = Math.max(d, 1 + visit(m));
    stack.delete(n);
    memo.set(n, d);
    return d;
  };
  for (const n of depOut.keys()) visit(n);
  return memo;
}

function parseArgs(argv: string[]) {
  const p: any = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) { p[k] = v; i += 1; } else p[k] = true;
  }
  // 出力先 (indexer cache) の決定: --out CLI 引数 > GRAPHRAG_INDEXED_GRAPH_PATH env > undefined (main で reject)
  // skill 配下 default は提供しない (利用先プロジェクトのキャッシュがスキルリポジトリに混入するのを避ける)
  const out = typeof p.out === "string" ? p.out : process.env.GRAPHRAG_INDEXED_GRAPH_PATH;

  return {
    root: typeof p.root === "string" ? p.root : process.cwd(),
    system: typeof p.system === "string" ? p.system : undefined,
    previous: typeof p.previous === "string" ? p.previous : undefined,
    vault: typeof p.vault === "string" ? p.vault : undefined,
    out: typeof out === "string" && out.length > 0 ? out : undefined
  };
}

// 再索引で「前回の本物 File summary を継ぐ」ための previous ソースを決める。
// v3 の正本は vault であり、本物の意味要約も summary_provisional フラグも vault 往復で
// 保たれる(authored=フラグ無し / 機械テンプレ=summary_provisional:true)。一方
// indexer cache (indexed-graph.json) の File summary は常に機械テンプレ(スタブ)で、
// しかも旧版が吐いた graph はフラグ自体を持たない。これを --previous に渡すと
// 「フラグ無し=本物」と誤認してスタブを継ぎ、再 author 済みの要約を作り直しで握り潰す。
// よって vault が在るなら vault import を previous にし、無いときだけ --previous へ退避する。
// 返り値の prev は id (= file:<sys>:<rel>) で照合される。vault の File ノードは同じ id 体系。
// trustSummaries=true は「この previous の summary を本物として継いでよい」= vault のときだけ。
// scaffold へ退避したときは false にし、change_status だけ使って summary は作り直させる。
// systemName: 指定すると、その system slug に属する File を持つ vault のみ採用する。
//   GRAPHRAG_VAULT_DIR が無関係な別 repo の dev vault を指していても、id 体系不一致で
//   誤って別 system の summary を継がないようにする安全ガード。
export function resolvePreviousGraph(args: { root: string; previous?: string; vault?: string; systemName?: string }): {
  previous: any;
  trustSummaries: boolean;
} {
  const root = path.resolve(args.root);
  const sysPrefix = args.systemName ? `file:${slug(args.systemName)}:` : undefined;
  const candidates = [
    args.vault,
    process.env.GRAPHRAG_VAULT_DIR,
    path.join(root, ".graphrag", "vault"),
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  for (const c of candidates) {
    const vaultDir = path.isAbsolute(c) ? c : path.resolve(root, c);
    if (!existsSync(vaultDir)) continue;
    try {
      const g = importVault(vaultDir);
      const fileNodes = Array.isArray(g?.nodes) ? g.nodes.filter((n: any) => n.type === "File") : [];
      // system slug が一致する File を1つも持たない vault は別 system のもの → 採用しない。
      if (sysPrefix && !fileNodes.some((n: any) => typeof n.id === "string" && n.id.startsWith(sysPrefix))) {
        console.error(`[index] vault ${vaultDir} は system '${args.systemName}' の File を持たない — スキップ`);
        continue;
      }
      if (fileNodes.length > 0) {
        const authored = fileNodes.filter(
          (n: any) => typeof n.summary === "string" && n.summary_provisional !== true
        ).length;
        console.error(`[index] reusing authored File summaries from vault: ${vaultDir} (authored=${authored})`);
        return { previous: g, trustSummaries: true };
      }
    } catch (e: any) {
      console.error(`[index] vault import failed (${vaultDir}): ${String(e?.message ?? e)} — falling back`);
    }
  }
  // vault が見つからない場合のみ --previous (graph.json) へ退避。summary は信用せず
  // (scaffold の summary は機械テンプレで、旧版 graph はフラグも持たないため)、
  // change_status / 削除検知だけに使う。全 File は作り直され provisional が立つ = 安全側。
  if (args.previous && existsSync(args.previous)) {
    console.error(
      `[index] no vault found; using --previous only for change detection. ` +
        `File summaries will be regenerated as provisional (authored summaries live in the vault, not in a graph.json scaffold).`
    );
    return { previous: JSON.parse(readFileSync(args.previous, "utf8")), trustSummaries: false };
  }
  return { previous: null, trustSummaries: false };
}

export async function main(argv: string[]) {
  const args = parseArgs(argv);
  if (!args.out) {
    console.error("Refusing to index: indexed-graph.json output path is not specified.");
    console.error("Pass --out <path> or set GRAPHRAG_INDEXED_GRAPH_PATH env.");
    console.error("(No default under the skill directory is provided — the indexer cache belongs to the consuming project.)");
    process.exitCode = 1;
    return;
  }
  const { previous, trustSummaries } = resolvePreviousGraph({ ...args, systemName: args.system });
  const graph = indexCodebase({ root: args.root, systemName: args.system, previous, trustPreviousSummaries: trustSummaries });
  const failures = validateGraph(graph);
  if (failures.length > 0) {
    console.error(`indexed graph failed schema validation:\n- ${failures.slice(0, 20).join("\n- ")}`);
    process.exitCode = 1;
    return;
  }
  const outPath = path.resolve(args.out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  const counts = graph.nodes.reduce((acc: any, n: any) => { acc[n.type] = (acc[n.type] ?? 0) + 1; return acc; }, {});
  console.log(`${outPath}\nnodes=${graph.nodes.length} edges=${graph.edges.length} ${JSON.stringify(counts)} deleted=${graph.stale_candidates.deleted_files.length}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
}

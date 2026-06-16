// Vein ヒントの意味的近接抽出 (embedding 経由)
//
// 目的: indexer の構造シグナル (cross_component_in_degree) は import で繋がる
// 縦串しか拾えない。「機能セット型 Vein」(認証/暗号化/自動更新 等、複数 Layer を
// 縦断する機能塊) や「共通概念型 Vein」(観測性/i18n/エラー処理 等、import で
// 繋がるとは限らない概念) を統一的に拾うため、各 File の embedding ベクトル間の
// cosine 距離でクラスタリングする。
//
// アルゴリズム:
//   1. graph.json と vector-index.json を読む
//   2. File ノードのみ対象、各々の embedding を取り出す
//   3. 全ペアの cosine similarity を計算
//   4. similarity ≥ threshold かつ異 Component 所属のペアを抽出
//      (= 縦に貫いている = Concern 候補)
//   5. Union-Find でクラスタリング (高類似度ペアの連結成分)
//   6. 各クラスタを Concern candidate として JSON 出力
//      (member_files / spanning_components / 代表テーマ語)
//
// 最終確定は LLM (carving-rules.md「Concern 候補の見つけ方」参照)。本コマンドは
// LLM に渡す candidate を機械的に提示するだけ。
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv: string[]) {
  const p: any = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") continue;
    if (!a?.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) { p[k] = v; i += 1; } else p[k] = true;
  }
  const graphPath = typeof p.graph === "string" ? p.graph : process.env.GRAPHRAG_GRAPH_JSON_PATH;
  const vectorPath = typeof p["vector-index"] === "string" ? p["vector-index"]
    : typeof p.vector === "string" ? p.vector
    : process.env.GRAPHRAG_VECTOR_INDEX_PATH;
  const out = typeof p.out === "string" ? p.out : process.env.GRAPHRAG_CONCERN_SUGGEST_OUT;
  // threshold は edge を張る最低 cosine similarity (緩いと giant component になる)
  const threshold = Number.isFinite(Number(p.threshold)) ? Number(p.threshold) : 0.85;
  // k-NN: 各 File は異 Component 内の最近接 k 個のみと edge を張る。
  // これで giant component を抑制 (全体的に embedding が近い場合の percolation 回避)。
  const kNN = Number.isFinite(Number(p.knn)) ? Number(p.knn) : 4;
  const minCluster = Number.isFinite(Number(p["min-cluster"])) ? Number(p["min-cluster"]) : 3;
  const minSpan = Number.isFinite(Number(p["min-span"])) ? Number(p["min-span"]) : 2;
  // provisional 要約 (機械テンプレ) が残る graph で走らせると言語/階層クラスタしか出ない。
  // 既定では拒否し、明示の --allow-provisional でのみ許す。
  const allowProvisional = p["allow-provisional"] === true || p["allow-provisional"] === "true";
  return { graphPath, vectorPath, out, threshold, kNN, minCluster, minSpan, allowProvisional };
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}
function norm(v: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += v[i] * v[i];
  return Math.sqrt(s);
}
function cosine(a: number[], b: number[], na: number, nb: number): number {
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

class UnionFind {
  parent: Map<string, string> = new Map();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    if (this.parent.get(x) !== x) this.parent.set(x, this.find(this.parent.get(x)!));
    return this.parent.get(x)!;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  components(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const x of this.parent.keys()) {
      const r = this.find(x);
      if (!out.has(r)) out.set(r, []);
      out.get(r)!.push(x);
    }
    return out;
  }
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  if (!args.graphPath) {
    console.error("Refusing to suggest: graph.json path not specified.");
    console.error("Pass --graph <path> or set GRAPHRAG_GRAPH_JSON_PATH env.");
    process.exit(1);
  }
  if (!args.vectorPath) {
    console.error("Refusing to suggest: vector-index.json path not specified.");
    console.error("Pass --vector-index <path> or set GRAPHRAG_VECTOR_INDEX_PATH env.");
    process.exit(1);
  }

  const graph = JSON.parse(fs.readFileSync(args.graphPath, "utf8"));
  const vector = JSON.parse(fs.readFileSync(args.vectorPath, "utf8"));

  // provisional 要約ガード: File 要約が機械テンプレ (summary_provisional) のまま残ると、
  // embedding が言語/構造語に支配され、クラスタが "typescript" / "components" 等に退化して
  // 縦串 (Vein) 抽出が無意味になる。既定では拒否し、本物要約に書き換えてから走らせる。
  const allFiles = graph.nodes.filter((n: any) => n.type === "File");
  const provisionalFiles = allFiles.filter((n: any) => n.summary_provisional === true);
  if (provisionalFiles.length > 0 && !args.allowProvisional) {
    console.error(
      `Refusing to suggest: ${provisionalFiles.length}/${allFiles.length} File ノードの要約が ` +
      `機械テンプレ (summary_provisional) のままです。`
    );
    console.error(
      "テンプレ要約だと embedding が言語・階層語で固まり、縦串 (Vein) 候補が無意味になります。"
    );
    console.error(
      "各 File を読んで本物の要約に書き換え summary_provisional を外してから再実行してください " +
      "(承知の上で走らせるなら --allow-provisional)。"
    );
    process.exit(1);
  }

  // File ノードと所属 Pocket を逆引き (旧 component: id の既存グラフにも後方互換で対応)
  const componentOfFile = new Map<string, string>();
  const fileNodes = new Map<string, any>();
  for (const n of graph.nodes) {
    if (n.type === "File") fileNodes.set(n.id, n);
  }
  for (const e of graph.edges) {
    if (e.type === "evidenced_by"
        && (e.from.startsWith("pocket:") || e.from.startsWith("component:"))
        && fileNodes.has(e.to)) {
      componentOfFile.set(e.to, e.from);
    }
  }

  // File embedding を取得
  const rows: any[] = Array.isArray(vector.rows) ? vector.rows : [];
  const embById = new Map<string, number[]>();
  const normById = new Map<string, number>();
  for (const r of rows) {
    if (!fileNodes.has(r.node_id)) continue; // File 以外は無視
    embById.set(r.node_id, r.vector);
    normById.set(r.node_id, norm(r.vector));
  }
  const ids = [...embById.keys()];
  console.error(`Files with embedding: ${ids.length}`);

  // 各 File について、異 Component の File との cosine similarity を計算し、
  // 上位 k 個 (similarity ≥ threshold を満たすもの) と edge を張る (k-NN graph)。
  // giant component を抑制し、本当に意味的に近接する縦串だけを拾う。
  const uf = new UnionFind();
  const edges: Array<{ a: string; b: string; sim: number }> = [];
  for (const a of ids) {
    const ca = componentOfFile.get(a);
    const sims: Array<{ b: string; sim: number }> = [];
    for (const b of ids) {
      if (a === b) continue;
      const cb = componentOfFile.get(b);
      if (ca && cb && ca === cb) continue; // 同 Component はスキップ
      const sim = cosine(embById.get(a)!, embById.get(b)!, normById.get(a)!, normById.get(b)!);
      if (sim < args.threshold) continue;
      sims.push({ b, sim });
    }
    sims.sort((x, y) => y.sim - x.sim);
    for (const { b, sim } of sims.slice(0, args.kNN)) {
      edges.push({ a, b, sim });
      uf.union(a, b);
    }
  }
  console.error(`k-NN edges (k=${args.kNN}, threshold=${args.threshold}, cross-Component): ${edges.length}`);

  // クラスタを抽出
  const components = uf.components();
  const candidates: any[] = [];
  for (const [, members] of components) {
    if (members.length < args.minCluster) continue;
    // 横断 Component 数
    const compSet = new Set<string>();
    for (const m of members) {
      const c = componentOfFile.get(m);
      if (c) compSet.add(c);
      else compSet.add("__orphan__");
    }
    const spanComps = [...compSet].filter(c => c !== "__orphan__");
    if (spanComps.length < args.minSpan) continue;

    // 代表テーマ語 (path / title / summary の n-gram から TF-IDF 上位)
    const themeWords = pickThemeWords(members.map(m => fileNodes.get(m)));

    candidates.push({
      member_count: members.length,
      spanning_components: spanComps.map(c => c.replace(/^(?:pocket|component):[^:]+:/, "")),
      theme_words: themeWords,
      members: members.map(m => {
        const f = fileNodes.get(m);
        return {
          path: f.path,
          title: f.title,
          summary: (f.summary || "").slice(0, 120),
          component: (componentOfFile.get(m) || "").replace(/^(?:pocket|component):[^:]+:/, "") || "(orphan)",
        };
      }),
    });
  }

  // クラスタを大きい順にソート
  candidates.sort((a, b) => b.member_count - a.member_count);

  const result = {
    graph_path: args.graphPath,
    vector_path: args.vectorPath,
    threshold: args.threshold,
    files_considered: ids.length,
    cross_component_pairs: edges.length,
    candidate_count: candidates.length,
    candidates,
  };

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
    console.error(`Wrote ${args.out}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

// 簡易テーマ語抽出: path / title / summary の token 頻度を全クラスタ内で集計し、
// クラスタ固有度 (TF-IDF 風) の高い token を返す
function pickThemeWords(nodes: any[]): string[] {
  const tokens = new Map<string, number>();
  for (const n of nodes) {
    if (!n) continue;
    const text = `${n.path || ""} ${n.title || ""} ${n.summary || ""}`;
    // 簡易トークン化: 日本語1文字単位は捨て、英単語 + カタカナ語 + 漢字2+
    const ascii = text.match(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g) || [];
    const kata = text.match(/[ァ-ヶー]{3,}/g) || [];
    const kanji = text.match(/[一-龥]{2,}/g) || [];
    const all = [...ascii.map(s => s.toLowerCase()), ...kata, ...kanji];
    const seen = new Set<string>();
    for (const t of all) {
      if (seen.has(t)) continue;
      seen.add(t);
      tokens.set(t, (tokens.get(t) || 0) + 1);
    }
  }
  // 全クラスタで共通の stop word (path 共通要素など) を弾く
  const stop = new Set([
    "ubuntu-wsl-app", "src", "tests", "unit", "ts", "tsx", "node_modules",
    "import", "export", "const", "function", "class", "interface", "return",
    "type", "string", "number", "boolean", "array", "true", "false",
    "テスト", "実装", "ファイル", "概要", "summary", "title", "path",
  ]);
  const ranked = [...tokens.entries()]
    .filter(([t]) => !stop.has(t) && t.length >= 3)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t]) => t);
  return ranked;
}

// Standalone entry (preserve backward compat for direct invocation)
if (process.argv[1] && process.argv[1].endsWith("suggest-vein-hints.ts")) {
  main();
}

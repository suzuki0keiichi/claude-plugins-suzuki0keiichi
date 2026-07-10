// carving 品質ゲート (carving-rules.md「carving 提出前チェックリスト」の自動化)
//
// 機械的に判定できる歪みを警告/エラーとして出力する。
// LLM レビューの前段。mutation apply 後に走らせて、警告ゼロを確認してから完了とする。
//
// 検査項目 (system vault):
//   0.  要約が機械テンプレ (summary_provisional) のまま残っていないか (ERROR)
//   0b. carve 未完 (candidate:true 残存 / "band N/M"・"(N files)"・"candidate cN" の
//       プレースホルダ title) が残っていないか (ERROR)。カスみたいな命名の確定を防ぐ。
//   1. Layer slug が意味語か (連番 band0/band1/... は警告)
//   2. role = documentation のファイルが Layer に居ないか (構造除外)
//   3. 全実装ファイルが Component に所属
//   4. 全実装ファイル + packaging が Layer に所属
//   5. Component と Concern のメンバー Jaccard > 0.5 は二重表現疑い
//   6. Concern の主 Component 占有率 > 70% は単一 Component 寄り疑い
//   7. cross_component_in_degree シグナルが全 File で空 (indexer 再 index + sync 必要)
//   8. 1 ファイルが ≧3 Concern に所属は単一動機原則違反疑い
//   C3. allowed-orphan の設定化: .graphrag/carving.json (literal path 免除) を統合し、
//       config 不正/stale を ERROR、builtin 重複と免除比率 >15% を WARN。免除会計を常時印字。
//   C1. knowledge-floor: Goal 0 件 / Constraint 0 件は WARN (知識軸が未シーディング)。
//   C1b. goal-island: Goal with 0 incoming has_premise edges → WARN (Goal disconnected from Decisions → code).
//   B2'. superseded-premise: 現役ノードが終端 state のノードへ has_premise している組は WARN。
//
// Check items (project vault, run additionally when --schema project is specified):
//   P1. Agreement exploring concentration: state=exploring with no responsible_for, ≥2 items → WARN.
//   P2. Agreement negotiating stagnation: Agreement with state=negotiating — "is it still active?" → WARN.
//   P3. Stakeholder overload: Stakeholder with ≥3 active Agreements → WARN.
//   P4. Resource gap: incomplete Task with 0 requires edges → WARN.
//   P5. Assumption orphan: Assumption not referenced by has_premise → WARN.
//   P6. Goal no-task: active Goal with no incoming achieves edge → WARN.
//   P7. Theme empty: Theme with 0 encompasses edges → WARN.
import fs from "node:fs";
import { canonicalType, DEFAULT_SCHEMA } from "./schema.ts";
import { isImplFileBinding } from "./binding-debt.ts";
import {
  loadCarvingConfig,
  resolveCarvingConfigPath,
  staleConfigEntries,
  type CarvingAllowedOrphan
} from "./carving-config.ts";

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
  return {
    graphPath: typeof p.graph === "string" ? p.graph : process.env.GRAPHRAG_GRAPH_JSON_PATH,
    vectorPath: typeof p["vector-index"] === "string" ? p["vector-index"] : process.env.GRAPHRAG_VECTOR_INDEX_PATH,
    jaccardThreshold: Number.isFinite(Number(p["jaccard-threshold"])) ? Number(p["jaccard-threshold"]) : 0.4,
    dominanceThreshold: Number.isFinite(Number(p["dominance-threshold"])) ? Number(p["dominance-threshold"]) : 0.7,
    duplicateThreshold: Number.isFinite(Number(p["duplicate-threshold"])) ? Number(p["duplicate-threshold"]) : 0.92,
    configPath: typeof p.config === "string" ? p.config : undefined,
    schema: typeof p.schema === "string" ? p.schema : process.env.GRAPHRAG_SCHEMA,
    json: Boolean(p.json),
  };
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}
function vectorNorm(v: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += v[i] * v[i];
  return Math.sqrt(s);
}
function cosineSim(a: number[], b: number[], na: number, nb: number): number {
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

type Severity = "ERROR" | "WARN" | "INFO";
interface Finding {
  severity: Severity;
  rule: string;
  message: string;
  details?: any;
}

// allowed-orphan の三層 (下から):
//   builtin — どのプロジェクトでも「構造的に Component に属さない」ものだけ (下記基準)。
//   role 免除 — 明確に非実装の閉集合 (documentation / generated) のみ。config/entrypoint 等の
//     role は role だけでは免除されず、builtin 汎用パターンに該当する場合のみ免除 (AND)。
//   config — プロジェクト固有の免除は .graphrag/carving.json に literal path + reason で明記。
//
// builtin に残す基準 (どれにも該当しないパターンは builtin に置かず config に逃がす):
//   a. composition root — 全部品を束ねる配線そのもので、どの部品の内側でもない
//   b. 横断 utility / 共有定義 — logger / utils / shared/types|constants のように全部品が依る土台
//   c. packaging — manifest / lock / ツール設定 / 環境変数 / 設定雛形。コードでなく梱包
//   d. 自動生成・静的 asset — 人が設計しない出力物
// 特定プロジェクト出自のパターン (windows-shell / winsw / *.utf8.bat / ui/index.css /
// plans/*.html / tests/setup-* / ui/utils/browser.ts) は REMOVED_BUILTIN_ORPHAN_PATTERNS に
// 移して免除から外した (carving-allow migrate が graph から config エントリ案を出す)。
export const BUILTIN_ORPHAN_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // a. composition root
  { name: "composition-root-services", pattern: /\/services\.ts$/ },
  { name: "composition-root-app", pattern: /\/App\.tsx$/ },
  { name: "composition-root-main", pattern: /\/main\.tsx$/ },
  { name: "composition-root-server-index", pattern: /\/server\/index\.ts$/ },
  // b. 横断 utility / 共有定義
  { name: "logger", pattern: /\/logger\.ts$/ },
  { name: "utils", pattern: /\/utils\.ts$/ },
  { name: "shared-types", pattern: /\/shared\/types\.ts$/ },
  { name: "shared-constants", pattern: /\/shared\/constants\.ts$/ },
  // c. packaging: build / test config 型定義・tooling 設定
  { name: "ambient-types", pattern: /\/vite-env\.d\.ts$/ },
  { name: "eslint-config", pattern: /\/eslint\.config\.(mjs|js|cjs)$/ },
  { name: "vite-config", pattern: /\/vite\.config\.[mc]?[jt]s$/ },
  { name: "vitest-config", pattern: /\/vitest\.config\.[mc]?[jt]s$/ },
  { name: "playwright-config", pattern: /\/playwright\.config\.[mc]?[jt]s$/ },
  { name: "prisma-config", pattern: /\/prisma\.config\.[mc]?[jt]s$/ },
  // c. packaging: ルート直下にも置かれる manifest / lock / workspace。先頭スラッシュ必須だと
  // repo ルートの package.json / tsconfig.base.json 等を取りこぼすため (^|\/) で両対応。
  { name: "tsconfig", pattern: /(^|\/)tsconfig(\.[a-z]+)?\.json$/ },
  { name: "package-manifest", pattern: /(^|\/)package\.json$/ },
  { name: "lockfile", pattern: /(^|\/)(pnpm-lock\.ya?ml|package-lock\.json|yarn\.lock)$/ },
  { name: "workspace-manifest", pattern: /(^|\/)pnpm-workspace\.ya?ml$/ },
  // c. packaging: 環境変数ファイル。命名規約のみ: .env / app.env / .env.<environment> /
  // app.env.example 等。末尾を環境名サフィックスに限定し、config.env.ts / data.env.json の
  // ような「.env を名前に含むコード/データ実体」を免除しない (網羅性ゲートの取りこぼし防止)。
  { name: "env-file", pattern: /(^|\/)[^/]*\.env(\.(example|sample|local|development|production|test|staging|template|defaults?))?$/i },
  // c. packaging: 設定の雛形 (family.example.json 等) のみ。実装サンプル (.example.ts/.js) は
  // コード実体なので免除せず Component 網羅性の対象に残す。
  { name: "config-example", pattern: /\.example\.(json|ya?ml|toml)$/ },
  { name: "claude-settings", pattern: /(^|\/)\.claude\/settings(\.[a-z]+)?\.json$/ },
  { name: "dockerfile", pattern: /\/Dockerfile$/ },
  { name: "dockerignore", pattern: /\.dockerignore$/ },
  { name: "gitignore", pattern: /\.gitignore$/ },
  { name: "gitattributes", pattern: /\.gitattributes$/ },
  // d. 自動生成 / 静的 asset / DB migration
  { name: "generated", pattern: /\/generated\// },
  { name: "public-assets", pattern: /\/public\/.*\.(svg|png|jpg|ico|webp)$/ },
  { name: "prisma-migrations", pattern: /\/prisma\/migrations\// },
  { name: "prisma-schema", pattern: /\/prisma\/schema\.prisma$/ },
];

// builtin から外した特定プロジェクト出自のパターン。免除には使わない。
// carving-allow migrate が graph 内の該当 File を config エントリ案に変換するために保持
// (移行等価性: 旧 builtin で免除されていたファイルを黙って ERROR に落とさず移行先を示す)。
export const REMOVED_BUILTIN_ORPHAN_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "ui-utils-browser", pattern: /\/ui\/utils\/browser\.ts$/ },
  { name: "theme-entry-css", pattern: /\/ui\/index\.css$/ },
  { name: "windows-shell-script", pattern: /^[^/]+\.(bat|sh)$/ },
  { name: "utf8-bat", pattern: /^[^/]+\.utf8\.bat$/ },
  { name: "plans-html", pattern: /^plans\/.*\.html$/ },
  { name: "winsw-service-xml", pattern: /\/winsw\/[^/]+\.xml$/ },
  { name: "tests-setup", pattern: /\/tests\/setup-[^/]+\.ts$/ },
];

/** builtin 免除に該当すればそのパターン名、しなければ null (免除会計の根拠表示用)。 */
export function builtinOrphanMatch(filePath: string): string | null {
  for (const b of BUILTIN_ORPHAN_PATTERNS) if (b.pattern.test(filePath)) return b.name;
  return null;
}

export function isAllowedOrphan(filePath: string): boolean {
  return builtinOrphanMatch(filePath) !== null;
}

// role だけで免除してよいのは明確に非実装の閉集合のみ。ここを広げると roleFor の判定変更で
// orphan 検出が黙って空になる (silent pass)。ui_component / api_route / entrypoint / config 等は
// 実装なので、builtin パターンか config の literal path に該当しない限り Component 所属を要求する。
const ROLE_ALONE_EXEMPT = new Set(["documentation", "generated"]);

// ─────────────────────────────────────────────────────────────────────────────
// Project vault checks (P1–P7)
// Receives graph and outEdges/inEdges, returns Finding[].
// Called from check-carving.ts main() only when schema === "project".
// ─────────────────────────────────────────────────────────────────────────────
export function runProjectChecks(
  graph: { nodes: any[]; edges: any[] },
  outEdges: Record<string, any[]>,
  inEdges: Record<string, any[]>,
): Finding[] {
  const findings: Finding[] = [];
  const nodeById = new Map<string, any>(graph.nodes.map((n: any) => [n.id, n]));

  // ─── P1: Agreement exploring concentration ─────────────────────────────────────────
  // Among state=exploring Agreements, those with no responsible_for edge from any Stakeholder
  // are considered "unassigned". If count ≥ 2, emit WARN.
  const exploringAgreements = graph.nodes.filter(
    (n: any) => n.type === "Agreement" && n.state === "exploring"
  );
  const exploringNoOwner: string[] = [];
  for (const ag of exploringAgreements) {
    const hasOwner = (inEdges[ag.id] ?? []).some((e: any) => e.type === "responsible_for");
    if (!hasOwner) exploringNoOwner.push(`[Agreement] ${String(ag.id).split(":").pop()} — ${(ag.title ?? "").slice(0, 60)}`);
  }
  if (exploringNoOwner.length >= 2) {
    findings.push({
      severity: "WARN",
      rule: "agreement-exploring-concentration",
      message: `${exploringNoOwner.length} Agreement(s) in state=exploring with no Stakeholder responsible_for. Exploration may be stalling without an owner. Add responsible_for edges or close the exploration.`,
      details: exploringNoOwner.slice(0, 20),
    });
  }

  // ─── P2: Agreement negotiating stagnation ──────────────────────────────────────
  // Agreements with state=negotiating should be checked: "is this still active?"
  // Timestamp tracking is not implemented, so all items are shown as WARN regardless of count.
  const negotiatingAgreements = graph.nodes.filter(
    (n: any) => n.type === "Agreement" && n.state === "negotiating"
  );
  if (negotiatingAgreements.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "agreement-negotiating-stagnation",
      message: `${negotiatingAgreements.length} Agreement(s) with state=negotiating. Check if they are still active (still negotiating / moved to signed / expired). All items listed because timestamp tracking is unavailable.`,
      details: negotiatingAgreements.slice(0, 20).map((n: any) => `[Agreement] ${String(n.id).split(":").pop()} — ${(n.title ?? "").slice(0, 60)}`),
    });
  }

  // ─── P3: Stakeholder overload ───────────────────────────────────────────────
  // Count Agreements with state=active that the Stakeholder is party_to.
  // Stakeholders with ≥ 3 such Agreements emit WARN.
  const stakeholders = graph.nodes.filter((n: any) => n.type === "Stakeholder");
  for (const sh of stakeholders) {
    const activeCount = (outEdges[sh.id] ?? []).filter((e: any) => {
      if (e.type !== "party_to") return false;
      const ag = nodeById.get(e.to);
      return ag && ag.state === "active";
    }).length;
    if (activeCount >= 3) {
      findings.push({
        severity: "WARN",
        rule: "stakeholder-overload",
        message: `Stakeholder '${String(sh.id).split(":").pop()}' is party_to ${activeCount} active Agreement(s) (≥3). Possible overload. Review ownership or split Agreements.`,
        details: [`[Stakeholder] ${String(sh.id).split(":").pop()} — active agreements: ${activeCount}`],
      });
    }
  }

  // ─── P4: Resource gap ────────────────────────────────────────────────────
  // Tasks not in completed/cancelled state with 0 requires edges.
  // Indicates "what resources does this task consume?" is undefined.
  const incompleteTasks = graph.nodes.filter(
    (n: any) => n.type === "Task" && n.state !== "completed" && n.state !== "cancelled"
  );
  const tasksNoResource: string[] = [];
  for (const t of incompleteTasks) {
    const hasRequires = (outEdges[t.id] ?? []).some((e: any) => e.type === "requires");
    if (!hasRequires) {
      tasksNoResource.push(`[Task] ${String(t.id).split(":").pop()} — ${(t.title ?? "").slice(0, 60)}`);
    }
  }
  if (tasksNoResource.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "task-resource-gap",
      message: `${tasksNoResource.length} incomplete Task(s) have no requires edge. Unclear what resources (people, time, budget, etc.) this task consumes. Create Resource nodes and connect via requires, or reconsider the Task if it consumes nothing.`,
      details: tasksNoResource.slice(0, 20),
    });
  }

  // ─── P5: Assumption orphan ───────────────────────────────────────────────
  // Assumptions not appearing on the to side of has_premise are "isolated premises".
  // If no one depends on them, they are deletion candidates or need has_premise edges added.
  const assumptions = graph.nodes.filter((n: any) => n.type === "Assumption");
  const orphanAssumptions: string[] = [];
  for (const as of assumptions) {
    const hasDependents = (inEdges[as.id] ?? []).some((e: any) => e.type === "has_premise");
    if (!hasDependents) {
      orphanAssumptions.push(`[Assumption] ${String(as.id).split(":").pop()} — ${(as.title ?? "").slice(0, 60)}`);
    }
  }
  if (orphanAssumptions.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "assumption-orphan",
      message: `${orphanAssumptions.length} isolated Assumption(s) (not referenced by has_premise). Add has_premise edges from Goals / Decisions / Tasks that depend on them, or delete if the premise is unnecessary.`,
      details: orphanAssumptions.slice(0, 20),
    });
  }

  // ─── P6: Goal no-task ─────────────────────────────────────────────────────
  // Active Goals with no incoming achieves edge (no Task assigned).
  // Indicates "no one is working toward this goal".
  const activeGoals = graph.nodes.filter(
    (n: any) => n.type === "Goal" && n.state === "active"
  );
  const goalsNoTask: string[] = [];
  for (const g of activeGoals) {
    const hasAchieves = (inEdges[g.id] ?? []).some((e: any) => e.type === "achieves");
    if (!hasAchieves) {
      goalsNoTask.push(`[Goal] ${String(g.id).split(":").pop()} — ${(g.title ?? "").slice(0, 60)}`);
    }
  }
  if (goalsNoTask.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "goal-no-task",
      message: `${goalsNoTask.length} active Goal(s) have no incoming achieves edge (no Task in progress). The Goal may be floating. Create a Task and connect via achieves, or change the Goal state to planned/abandoned.`,
      details: goalsNoTask.slice(0, 20),
    });
  }

  // ─── P7: Theme empty ────────────────────────────────────────────────────────
  // Themes with 0 encompasses edges are "empty cross-cutting themes".
  // If empty, they are deletion candidates or need encompasses edges added.
  const themes = graph.nodes.filter((n: any) => n.type === "Theme");
  const emptyThemes: string[] = [];
  for (const th of themes) {
    const hasEncompasses = (outEdges[th.id] ?? []).some((e: any) => e.type === "encompasses");
    if (!hasEncompasses) {
      emptyThemes.push(`[Theme] ${String(th.id).split(":").pop()} — ${(th.title ?? "").slice(0, 60)}`);
    }
  }
  if (emptyThemes.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "theme-empty",
      message: `${emptyThemes.length} Theme(s) have 0 encompasses edges. Empty themes do not function as cross-cutting views. Connect Goal / Decision / Risk / Task / Resource / Assumption via encompasses, or delete the theme.`,
      details: emptyThemes.slice(0, 20),
    });
  }

  return findings;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  if (!args.graphPath) {
    console.error("Refusing to check: graph.json path not specified.");
    console.error("Pass --graph <path> or set GRAPHRAG_GRAPH_JSON_PATH env.");
    process.exit(1);
  }
  const graph = JSON.parse(fs.readFileSync(args.graphPath, "utf8"));

  const findings: Finding[] = [];

  const files = graph.nodes.filter((n: any) => n.type === "File");
  // canonical (Component/Concern/Layer) と旧 alias (Pocket/Vein/Stratum) の両方を拾う。
  // 片方しか見ないと、indexer が canonical を吐くようになった graph でゲートが 0 件検出に
  // なり、網羅性チェックが「歪みゼロ」と誤って通る (silent pass) ため canonicalType で正規化。
  const components = graph.nodes.filter((n: any) => canonicalType(n.type) === "Component");
  const concerns = graph.nodes.filter((n: any) => canonicalType(n.type) === "Concern");
  const layers = graph.nodes.filter((n: any) => canonicalType(n.type) === "Layer");

  // ─────────────────────────────────────────────────────────────
  // (C3) carving.json (プロジェクト固有 allowed-orphan) の読み込みと検証
  // ─────────────────────────────────────────────────────────────
  const graphFilePaths = new Set<string>(files.map((f: any) => String(f.path ?? "")));
  const configPath = args.configPath ?? resolveCarvingConfigPath(args.graphPath);
  const loadedConfig = loadCarvingConfig(configPath);
  const configOrphans = new Map<string, CarvingAllowedOrphan>();
  if (loadedConfig.exists) {
    for (const err of loadedConfig.errors) {
      findings.push({
        severity: "ERROR",
        rule: "carving-config-invalid",
        message: `carving.json (${configPath}): ${err}`,
      });
    }
    if (loadedConfig.config) {
      const stale = staleConfigEntries(loadedConfig.config, graphFilePaths);
      if (stale.length > 0) {
        findings.push({
          severity: "ERROR",
          rule: "carving-config-stale",
          message: `${stale.length} carving.json exemption(s) reference a path not in the graph (stale-exemption). Don't let exemptions rot — clean them up: carving-allow remove --path <p>, or fix the path.`,
          details: stale.slice(0, 30),
        });
      }
      for (const entry of loadedConfig.config.allowed_orphans) {
        configOrphans.set(entry.path, entry);
        const dup = builtinOrphanMatch(entry.path);
        if (dup) {
          findings.push({
            severity: "WARN",
            rule: "config-duplicates-builtin",
            message: `carving.json exemption '${entry.path}' duplicates builtin:${dup}. The config entry is redundant (recommend removing it).`,
          });
        }
      }
    }
  }

  // 免除判定 + 会計の根拠種別。role 免除は非実装の閉集合のみ、それ以外は builtin → config の順。
  function exemptionFor(f: any): string | null {
    if (ROLE_ALONE_EXEMPT.has(f.role)) return `role:${f.role}`;
    const builtin = builtinOrphanMatch(String(f.path ?? ""));
    if (builtin) return `builtin:${builtin}`;
    if (configOrphans.has(String(f.path ?? ""))) return `config:${f.path}`;
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // (0) 要約が機械テンプレ (summary_provisional) のまま残っていないか
  // ─────────────────────────────────────────────────────────────
  // index-codebase が出す summary は「構成要素のサマリ」(File なら symbol/import、
  // Component/Layer candidate なら束ねた File 群) の機械テンプレであって「意味」ではない。
  // LLM が意味に書き換えるまで残る provisional は retrieval/concern-hint の品質を直接
  // 劣化させる (embedding が構成要素語に支配され縦串が言語/階層クラスタに退化)。空でない
  // =完了に見えるので、File も Component/Layer candidate も対称にゲートで明示的に弾く。
  // 免除: role 閉集合 (documentation/generated) と builtin-orphan パターンに該当する File
  // (lockfile / generated / tool 設定 等) は、そもそも embedding から除外され (vector.ts の
  // nodeVectorText)、Component 網羅性ゲートでも免除される「非実装」なので、意味要約の
  // 書き換えを ERROR で強制しない。件数は INFO で別勘定にして正直に見せる。
  // source / ui_component / api_route / entrypoint 等の File と Component/Layer 候補は
  // 従来どおり ERROR。
  const provisionalAll = graph.nodes.filter((n: any) => n.summary_provisional === true);
  const isProvisionalExempt = (n: any) =>
    n.type === "File" &&
    (ROLE_ALONE_EXEMPT.has(n.role) || builtinOrphanMatch(String(n.path ?? "")) !== null);
  const provisionalExempt = provisionalAll.filter(isProvisionalExempt);
  const provisionalNodes = provisionalAll.filter((n: any) => !isProvisionalExempt(n));
  if (provisionalNodes.length > 0) {
    const byType: Record<string, number> = {};
    for (const n of provisionalNodes) byType[n.type] = (byType[n.type] || 0) + 1;
    findings.push({
      severity: "ERROR",
      rule: "summary-provisional",
      message: `Summaries still machine templates (summary_provisional): ${provisionalNodes.length} [${Object.entries(byType).map(([t, c]) => `${t}:${c}`).join(", ")}]. Rewrite each node's "constituent summary" into "meaning" (what it does / what for / which concern) and clear summary_provisional. Left as templates, concern-hint degrades into language/layer clusters.`,
      details: provisionalNodes.slice(0, 30).map((n: any) => n.path || n.id),
    });
  }
  if (provisionalExempt.length > 0) {
    findings.push({
      severity: "INFO",
      rule: "summary-provisional-exempt",
      message: `summary_provisional but exempt (role closed-set / builtin-orphan File): ${provisionalExempt.length}. Lockfiles, generated, and tool config are already excluded from embeddings, so a meaningful summary is not required (rewrite optional).`,
      details: provisionalExempt.slice(0, 30).map((n: any) => n.path || n.id),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (0b) carve 未完: candidate:true のまま / プレースホルダ命名が残っていないか
  // ─────────────────────────────────────────────────────────────
  // indexer が出す Component/Layer 候補は candidate:true + 機械プレースホルダ命名
  // ("Layer band 0/3 (41 files)" / "Component candidate c1" 等)。概念化パスで意味命名し
  // candidate:false にするのが carve。candidate が残る = 未 carve = 機械名が居座る。
  // summary_provisional だけに頼ると、旧 indexer 製 (フラグ未導入) の candidate を取り
  // 逃すため、candidate フラグ自体と命名パターンの両方を ERROR で弾く (format 非依存)。
  const crosscut = [...components, ...concerns, ...layers];
  const uncarved = crosscut.filter((n: any) => n.candidate === true);
  if (uncarved.length > 0) {
    const byType: Record<string, number> = {};
    for (const n of uncarved) byType[canonicalType(n.type)] = (byType[canonicalType(n.type)] || 0) + 1;
    findings.push({
      severity: "ERROR",
      rule: "candidate-uncarved",
      message: `Uncarved candidates remain (candidate:true): ${uncarved.length} [${Object.entries(byType).map(([t, c]) => `${t}:${c}`).join(", ")}]. Give each candidate a meaningful title/summary, set candidate:false, and delete judgment_input (do not finalize with machine placeholder names).`,
      details: uncarved.slice(0, 30).map((n: any) => `${n.id} (${n.title})`),
    });
  }
  // 命名パターン: candidate フラグが落ちていても、title に機械プレースホルダの痕跡
  // (band N/M, "(NN files)", "candidate cN", "(NN ファイル)") が残るものを弾く。
  // indexer の実プレースホルダ: "Layer band 0/3 (41 files)" / "Component candidate c1 (N files)"。
  // candidate は `c` 接頭辞付き連番に限定し、"candidate 5 selection" のような正当名を誤爆しない。
  const PLACEHOLDER_TITLE = /(band\s*\d+\s*\/\s*\d+)|(\(\s*\d+\s*(files?|ファイル)\s*\))|(candidate\s+c\d+)/i;
  const placeholderTitled = crosscut.filter((n: any) => PLACEHOLDER_TITLE.test(String(n.title ?? "")));
  if (placeholderTitled.length > 0) {
    findings.push({
      severity: "ERROR",
      rule: "placeholder-title",
      message: `Machine placeholder names remain in title: ${placeholderTitled.length}. "band N/M" / "(N files)" / "candidate cN" describe constituent members, not meaning. Replace with a meaningful name for what that layer/component/concern is responsible for (carving-rules.md "Meaningful naming required").`,
      details: placeholderTitled.slice(0, 30).map((n: any) => `${n.id} (${n.title})`),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (1) Layer slug が意味語か (連番 band0/band1/... 検出)
  // ─────────────────────────────────────────────────────────────
  for (const l of layers) {
    const slug = (l.id || "").split(":").pop() || "";
    if (/^band\d+$/.test(slug)) {
      findings.push({
        severity: "WARN",
        rule: "meaningful-slug",
        message: `Layer slug is sequential: ${slug} (rename to a meaningful term; carving-rules.md "Meaningful naming required" applies, same as Component)`,
      });
    }
  }
  for (const c of components) {
    const slug = (c.id || "").split(":").pop() || "";
    if (/^c\d+$/.test(slug)) {
      findings.push({
        severity: "WARN",
        rule: "meaningful-slug",
        message: `Component slug is sequential: ${slug}`,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // (2) role = documentation のファイルが Layer に居ないか (構造除外)
  // ─────────────────────────────────────────────────────────────
  const outEdges: Record<string, any[]> = {};
  const inEdges: Record<string, any[]> = {};
  for (const e of graph.edges) {
    (outEdges[e.from] = outEdges[e.from] || []).push(e);
    (inEdges[e.to] = inEdges[e.to] || []).push(e);
  }
  const fileById = new Map<string, any>(files.map((f: any) => [f.id, f]));

  const docInLayer: string[] = [];
  for (const l of layers) {
    for (const e of outEdges[l.id] || []) {
      if (e.type !== "evidenced_by") continue;
      const f = fileById.get(e.to);
      if (f && f.role === "documentation") docInLayer.push(`${l.id.split(":").pop()} ← ${f.path}`);
    }
  }
  if (docInLayer.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "layer-no-doc",
      message: `role=documentation File(s) belong to a Layer (${docInLayer.length}). A Layer marks position in the runtime-dependency pyramid, so exclude docs and treat them as documented_by sources for Decision/OK instead.`,
      details: docInLayer.slice(0, 20),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (3) 全実装ファイルが Component に所属 (免除 = role 閉集合 / builtin / config の三層)
  // ─────────────────────────────────────────────────────────────
  const componentMembers = new Map<string, Set<string>>();
  for (const c of components) {
    const s = new Set<string>();
    for (const e of outEdges[c.id] || []) {
      if (e.type === "evidenced_by") s.add(e.to);
    }
    componentMembers.set(c.id, s);
  }
  const allComponentFiles = new Set<string>();
  for (const s of componentMembers.values()) for (const x of s) allComponentFiles.add(x);

  // 旧実装は role ∈ {source,test,config} だけを検査対象にしていたため、roleFor が
  // ui_component / api_route / entrypoint と判定したファイルが Component 未所属でも素通りした
  // (silent pass)。全 File を対象にし、免除は exemptionFor の三層だけに限定する。
  // exemptions = Component 未所属で実際に免除が行使されたもの (免除会計の本体)。
  const exemptions: { path: string; basis: string }[] = [];
  const compOrphans: any[] = [];
  for (const f of files) {
    if (allComponentFiles.has(f.id)) continue;
    const basis = exemptionFor(f);
    if (basis) {
      exemptions.push({ path: f.path, basis });
      continue;
    }
    compOrphans.push(f.path);
  }
  if (compOrphans.length > 0) {
    findings.push({
      severity: "ERROR",
      rule: "component-coverage",
      message: `Implementation files not in any Component: ${compOrphans.length} (after automatic allowed-orphan detection). Violates carving-rules.md coverage regression gate.`,
      details: compOrphans.slice(0, 30),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (4) 全実装ファイル + packaging が Layer に所属
  // ─────────────────────────────────────────────────────────────
  const layerMembers = new Map<string, Set<string>>();
  for (const l of layers) {
    const s = new Set<string>();
    for (const e of outEdges[l.id] || []) {
      if (e.type === "evidenced_by") s.add(e.to);
    }
    layerMembers.set(l.id, s);
  }
  const allLayerFiles = new Set<string>();
  for (const s of layerMembers.values()) for (const x of s) allLayerFiles.add(x);

  const layerOrphans: any[] = [];
  for (const f of files) {
    if (allLayerFiles.has(f.id)) continue;
    // (3) と同じ三層免除 (documentation/generated は role 閉集合、generated/ は builtin が拾う)
    if (exemptionFor(f)) continue;
    // ビルド対象でない成果物も除外
    if (/\/dist\//.test(f.path || "")) continue;
    if (/\/node_modules\//.test(f.path || "")) continue;
    layerOrphans.push(f.path);
  }
  if (layerOrphans.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "layer-coverage",
      message: `Implementation files not in any Layer: ${layerOrphans.length} (after excluding allowed-orphan / documentation / generated).`,
      details: layerOrphans.slice(0, 30),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (5) Component と Concern のメンバー Jaccard
  // ─────────────────────────────────────────────────────────────
  const concernMembers = new Map<string, Set<string>>();
  for (const c of concerns) {
    const s = new Set<string>();
    for (const e of outEdges[c.id] || []) {
      if (e.type === "evidenced_by") s.add(e.to);
    }
    concernMembers.set(c.id, s);
  }
  function jaccard(a: Set<string>, b: Set<string>): number {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    const uni = a.size + b.size - inter;
    return uni === 0 ? 0 : inter / uni;
  }
  // テストファイルは Component と Concern の両方に含まれて Jaccard を薄める要因。
  // 「実装ファイル基準」で比較するため除外する。
  const isImplFile = (fid: string) => {
    const f = fileById.get(fid);
    return f && f.role !== "test";
  };
  function implFiles(s: Set<string>): Set<string> {
    return new Set([...s].filter(isImplFile));
  }
  for (const co of concerns) {
    const cm = implFiles(concernMembers.get(co.id)!);
    if (cm.size === 0) continue;
    for (const comp of components) {
      const pm = implFiles(componentMembers.get(comp.id)!);
      const j = jaccard(cm, pm);
      if (j >= args.jaccardThreshold) {
        findings.push({
          severity: "WARN",
          rule: "concern-component-duplicate",
          message: `High Jaccard overlap between Concern and Component (implementation files): ${co.id.split(":").pop()} ∩ ${comp.id.split(":").pop()} = ${j.toFixed(2)} (≥${args.jaccardThreshold}). Suspected double representation. Withdraw the Concern or narrow it to a different motive.`,
        });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // (6) Concern の主 Component 占有率
  // ─────────────────────────────────────────────────────────────
  // ファイル → Component 逆引き
  const compOfFile = new Map<string, string>();
  for (const [cid, members] of componentMembers) {
    for (const fid of members) compOfFile.set(fid, cid);
  }
  for (const co of concerns) {
    const cm = concernMembers.get(co.id)!;
    if (cm.size < 3) continue; // 小すぎは別問題
    const distrib: Record<string, number> = {};
    for (const fid of cm) {
      const comp = compOfFile.get(fid);
      if (comp) distrib[comp] = (distrib[comp] || 0) + 1;
    }
    const total = Object.values(distrib).reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    const sorted = Object.entries(distrib).sort((a, b) => b[1] - a[1]);
    const dominant = sorted[0];
    const ratio = dominant[1] / total;
    if (ratio > args.dominanceThreshold) {
      findings.push({
        severity: "WARN",
        rule: "concern-component-dominance",
        message: `Concern '${co.id.split(":").pop()}' is ${(ratio * 100).toFixed(0)}% contained in a single Component '${dominant[0].split(":").pop()}' (>${(args.dominanceThreshold * 100).toFixed(0)}%). The crosscut condition holds formally but is effectively single-Component. Consider splitting or withdrawing.`,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // (7) cross_component_in_degree シグナルが全 File で空
  // ─────────────────────────────────────────────────────────────
  const hasSignal = files.some((f: any) => typeof f.cross_component_in_degree === "number");
  if (!hasSignal) {
    findings.push({
      severity: "INFO",
      rule: "indexer-signal-missing",
      message: `cross_component_in_degree signal is empty on all Files. Without re-indexing and merging it into File nodes via a signal-only mutation, it cannot drive vertical detection of Concern candidates.`,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (X) Decision/OK/Risk の実装ファイル紐付け不在 (knowledge-impl-binding-missing)
  // ─────────────────────────────────────────────────────────────
  // isImplFileBinding は binding-debt.ts の単一定義を使う (gate #9 / binding_debt と同値)。
  const knowledgeTypes = new Set(["Decision", "OperationalKnowledge", "Risk"]);
  const knowledgeNodes = files.length > 0 ? graph.nodes.filter((n: any) => knowledgeTypes.has(n.type)) : [];
  const noImplBinding: string[] = [];
  for (const k of knowledgeNodes) {
    const oe = outEdges[k.id] || [];
    const hasPolicy = oe.some((e: any) => e.type === "sets_policy_for" && isImplFileBinding(e.to));
    const hasImplDoc = oe.some((e: any) => e.type === "documented_by" && isImplFileBinding(e.to));
    if (!hasPolicy && !hasImplDoc) {
      noImplBinding.push(`[${k.type}] ${k.id.split(":").pop()} - ${(k.title || "").slice(0, 60)}`);
    }
  }
  if (noImplBinding.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "knowledge-impl-binding-missing",
      message: `${noImplBinding.length} Decision / OperationalKnowledge / Risk node(s) have no sets_policy_for or documented_by binding to an implementation file. When linked only via knowhow / plans / design-decisions docs, "which code this decision/insight drives" is not traceable in the graph. Extract candidates with pnpm graph:edge:suggest-policy and consider a mutation.`,
      details: noImplBinding.slice(0, 30)
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (Z) 横断ノードへの方針/リスクエッジの次数集中 (crosscut-policy-hub)
  // sets_policy_for / risks_in が横断構造 (Layer/Concern/Component) を宛先に取れる
  // 自由度の乱用ガード。一点への収束はミニ System 化 (雑な「全体」宛の再発) の
  // 兆候として機械検出できる。正当に方針が集まる部品もありうるので ERROR にしない。
  // ─────────────────────────────────────────────────────────────
  const POLICY_HUB_THRESHOLD = 8;
  const crosscutIds = new Set([...components, ...concerns, ...layers].map((n: any) => n.id));
  const policyHubs: string[] = [];
  for (const id of crosscutIds) {
    const policyIn = (inEdges[id] || []).filter(
      (e: any) => e.type === "sets_policy_for" || e.type === "risks_in"
    ).length;
    if (policyIn >= POLICY_HUB_THRESHOLD) {
      policyHubs.push(`${id} ← sets_policy_for/risks_in ${policyIn} edge(s)`);
    }
  }
  if (policyHubs.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "crosscut-policy-hub",
      message: `Policy/risk edges converge on crosscut nodes, ${POLICY_HUB_THRESHOLD}+ each (${policyHubs.length}). Suspected sloppy "whole-system" targeting (mini-System). Review whether each edge sits at "the lowest altitude it can honestly sit at", and push those that can go to a narrower target (File / another Component) down.`,
      details: policyHubs.slice(0, 20),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (Y) embedding 距離で表記揺れ重複疑い (node-duplicate-suspect)
  // vector-index が指定されていれば実行。同型ノード間で similarity >= threshold のペアを抽出
  // ─────────────────────────────────────────────────────────────
  if (args.vectorPath) {
    let vector: any;
    try {
      vector = JSON.parse(fs.readFileSync(args.vectorPath, "utf8"));
    } catch {
      findings.push({
        severity: "INFO",
        rule: "vector-index-unavailable",
        message: `Could not read vector-index (path: ${args.vectorPath}). Skipping the node-duplicate-suspect rule.`
      });
    }
    if (vector) {
      const rows: any[] = Array.isArray(vector.rows) ? vector.rows : [];
      const embById = new Map<string, number[]>();
      const normById = new Map<string, number>();
      for (const r of rows) {
        embById.set(r.node_id, r.vector);
        normById.set(r.node_id, vectorNorm(r.vector));
      }
      // 同型ノード間 pair-wise similarity。対象型は書き込み時重複ゲートと単一正本
      // (schema categories.duplicateCheck) — 監査対象がゲートとズレると
      // 「書けたのに後で別基準」になるため。
      const checkTypes = DEFAULT_SCHEMA.categories.duplicateCheck;
      const duplicates: string[] = [];
      for (const tp of checkTypes) {
        const sameType = graph.nodes.filter((n: any) => canonicalType(n.type) === tp);
        for (let i = 0; i < sameType.length; i += 1) {
          const a = sameType[i];
          const aEmb = embById.get(a.id);
          const aNorm = normById.get(a.id);
          if (!aEmb || !aNorm) continue;
          for (let j = i + 1; j < sameType.length; j += 1) {
            const b = sameType[j];
            const bEmb = embById.get(b.id);
            const bNorm = normById.get(b.id);
            if (!bEmb || !bNorm) continue;
            const sim = cosineSim(aEmb, bEmb, aNorm, bNorm);
            if (sim >= args.duplicateThreshold) {
              duplicates.push(`[${tp}] ${a.id.split(":").pop()} ⇄ ${b.id.split(":").pop()} = sim ${sim.toFixed(3)}`);
            }
          }
        }
      }
      if (duplicates.length > 0) {
        findings.push({
          severity: "WARN",
          rule: "node-duplicate-suspect",
          message: `${duplicates.length} node pair(s) suspected of notation-variance duplication by embedding distance (similarity >= ${args.duplicateThreshold}). Detects same-concept different-naming after a worktree merge (e.g. 'auto-update' vs 'auto-updater'). After LLM confirmation, merge by deleting one and rewiring its edges.`,
          details: duplicates.slice(0, 20)
        });
      }
    }
  } else {
    findings.push({
      severity: "INFO",
      rule: "vector-index-not-provided",
      message: `--vector-index not given (or GRAPHRAG_VECTOR_INDEX_PATH unset). Skipping the node-duplicate-suspect rule. Pass a vector-index to detect notation-variance duplicates.`
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (8) 1 ファイルが ≧3 Concern に所属 (動機混在疑い)
  // ─────────────────────────────────────────────────────────────
  const concernOfFile = new Map<string, string[]>();
  for (const [cid, members] of concernMembers) {
    for (const fid of members) {
      if (!concernOfFile.has(fid)) concernOfFile.set(fid, []);
      concernOfFile.get(fid)!.push(cid);
    }
  }
  const tripleConcerns: any[] = [];
  for (const [fid, cs] of concernOfFile) {
    if (cs.length >= 3) {
      const f = fileById.get(fid);
      tripleConcerns.push(`${f?.path || fid} → ${cs.map((c: string) => c.split(":").pop()).join(", ")}`);
    }
  }
  if (tripleConcerns.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "multi-concern-membership",
      message: `Files belonging to ≥3 Concerns: ${tripleConcerns.length}. By the single-motive principle, review whether each Concern is truly a distinct motive.`,
      details: tripleConcerns.slice(0, 20),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (C3) 免除会計 (常時印字) + 免除比率 WARN
  // ─────────────────────────────────────────────────────────────
  // 比率の分母 = 実装 File (role 閉集合免除を除く全 File)。分子 = builtin/config で
  // 実際に免除されたもの (role 免除は定義上「実装でない」ので分子にも入れない)。
  const roleCounts: Record<string, number> = {};
  for (const f of files) {
    const r = String(f.role ?? "unknown");
    roleCounts[r] = (roleCounts[r] || 0) + 1;
  }
  const implFileTotal = files.filter((f: any) => !ROLE_ALONE_EXEMPT.has(f.role)).length;
  const patternExemptions = exemptions.filter((e) => !e.basis.startsWith("role:"));
  const configExemptCount = exemptions.filter((e) => e.basis.startsWith("config:")).length;
  const exemptRatio = implFileTotal === 0 ? 0 : patternExemptions.length / implFileTotal;
  const accounting = {
    roles: roleCounts,
    impl_file_total: implFileTotal,
    exemptions,
    config_path: loadedConfig.exists ? configPath : null,
    config_entries: configOrphans.size,
    config_exempt_count: configExemptCount,
    exempt_ratio: Number(exemptRatio.toFixed(4)),
  };
  if (exemptRatio > 0.15) {
    findings.push({
      severity: "WARN",
      rule: "exemption-ratio-high",
      message: `allowed-orphan exemptions cover ${(exemptRatio * 100).toFixed(1)}% of implementation Files (${patternExemptions.length}/${implFileTotal}, >15%). Take stock of whether exemptions are hollowing out the coverage gate, and put whatever can belong to a Component into one.`,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (C1) knowledge-floor: 知識軸の床 (Goal / Constraint が 1 件も無い)
  // ─────────────────────────────────────────────────────────────
  const goalCount = graph.nodes.filter((n: any) => canonicalType(n.type) === "Goal").length;
  const constraintCount = graph.nodes.filter((n: any) => canonicalType(n.type) === "Constraint").length;
  if (goalCount === 0) {
    findings.push({
      severity: "WARN",
      rule: "knowledge-floor-goal-missing",
      message: `0 Goals. The design-review scope-creep / roadmap lens is disabled. Run knowledge-axis seeding in the conceptual pass.`,
    });
  }
  if (constraintCount === 0) {
    findings.push({
      severity: "WARN",
      rule: "knowledge-floor-constraint-missing",
      message: `0 Constraints. The design-review scope-creep / roadmap lens is disabled. Run knowledge-axis seeding in the conceptual pass.`,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (C1b) Goal island: Goal with no incoming has_premise from Decision/OK.
  // Without this bridge, Goal is disconnected from the code (Decision →sets_policy_for→ File).
  // Common in newly carved vaults where Decisions haven't been extracted yet.
  // ─────────────────────────────────────────────────────────────
  const goals = graph.nodes.filter((n: any) => canonicalType(n.type) === "Goal");
  const premiseEdgesToGoal = new Set(
    graph.edges
      .filter((e: any) => e.type === "has_premise")
      .map((e: any) => e.to)
  );
  for (const g of goals) {
    if (!premiseEdgesToGoal.has(g.id)) {
      findings.push({
        severity: "WARN",
        rule: "goal-island",
        message: `Goal "${g.title ?? g.id}" has no incoming has_premise edge — no Decision references this Goal. Bridge it to Decisions to connect Goal→code.`,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // (B2') superseded-premise: 死んだ前提の検出
  // 終端 state でない (= 現役の) ノードが、終端 state のノードへ has_premise している組。
  // hard reject せず可視化: 前提の張り替え/依存側の見直しは LLM・人間の判断に委ねる。
  // ─────────────────────────────────────────────────────────────
  const TERMINAL_STATES = new Set(["superseded", "abandoned", "closed"]);
  const nodeById = new Map<string, any>(graph.nodes.map((n: any) => [n.id, n]));
  const deadPremises: string[] = [];
  for (const e of graph.edges) {
    if (e.type !== "has_premise") continue;
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to) continue;
    if (TERMINAL_STATES.has(String(from.state))) continue;
    if (!TERMINAL_STATES.has(String(to.state))) continue;
    deadPremises.push(`${e.from} -has_premise-> ${e.to} (premise state: ${to.state})`);
  }
  if (deadPremises.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "superseded-premise",
      message: `Live nodes depend on premises in a terminal state (superseded/abandoned/closed): ${deadPremises.length}. The premise is dead. Find the successor via reverse refines and either rewire the premise to it or reconsider the dependent side.`,
      details: deadPremises.slice(0, 30),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // superseded-no-successor: state:superseded なのに後継からの refines が 1 本も無い
  // superseded は「後継に置き換えられた」の宣言なので、refines 逆引き (後継 → 旧) が
  // 無いと「何に置き換えられたのか」が graph 上から辿れない (supersede レシピの片肺)。
  // ─────────────────────────────────────────────────────────────
  const supersededNoSuccessor: string[] = [];
  for (const n of graph.nodes) {
    if (String(n.state) !== "superseded") continue;
    const hasSuccessor = (inEdges[n.id] || []).some((e: any) => e.type === "refines");
    if (!hasSuccessor) {
      supersededNoSuccessor.push(`[${n.type}] ${String(n.id).split(":").pop()} - ${(n.title || "").slice(0, 60)}`);
    }
  }
  if (supersededNoSuccessor.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "superseded-no-successor",
      message: `${supersededNoSuccessor.length} node(s) are state:superseded but have 0 incoming refines from a successor. "What replaced it" is not traceable. Add a refines edge from the successor node, or reconsider the state if there is no successor.`,
      details: supersededNoSuccessor.slice(0, 30),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (#9 拡張) constraint-binding-missing: Constraint で constrains エッジが 0 本のもの
  // Constraint が constrains で宛先ノードに繋がっていないと、レビュー逆引き
  // (「どのノードにこの制約が掛かるか」を辿るパス) が ACK 帯に出ない盲点になる。
  // ─────────────────────────────────────────────────────────────
  const constraintNodes = graph.nodes.filter((n: any) => canonicalType(n.type) === "Constraint");
  const constraintUnbound: string[] = [];
  for (const c of constraintNodes) {
    const hasConstrains = (outEdges[c.id] || []).some((e: any) => e.type === "constrains");
    if (!hasConstrains) {
      constraintUnbound.push(`[Constraint] ${c.id.split(":").pop()} - ${(c.title || "").slice(0, 60)}`);
    }
  }
  if (constraintUnbound.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "constraint-binding-missing",
      message: `${constraintUnbound.length} Constraint(s) have 0 constrains edges. An unbound Constraint does not surface in review's reverse lookup (a blind spot in the ACK band). Name the target Decision / File / OperationalKnowledge via constrains.`,
      details: constraintUnbound.slice(0, 30),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // temporary-relation-remaining: temporary_relation_candidate エッジの残存
  // 型付けされていない仮マーカー。放置されるとグラフの信頼性が下がる。
  // ─────────────────────────────────────────────────────────────
  const tempEdges = graph.edges.filter((e: any) => e.type === "temporary_relation_candidate");
  if (tempEdges.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "temporary-relation-remaining",
      message: `${tempEdges.length} temporary_relation_candidate edge(s) remain. Left as provisional markers, typed relations go missing. Inspect each pair and promote to a proper edge type (refines / has_premise / supersedes, etc.), or delete if there is no relation.`,
      details: tempEdges.slice(0, 20).map((e: any) => `${e.from} → ${e.to}`),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // knowledge-description-missing: 知識 6 型で description 欠落
  // summary だけでは embedding の意味担体が薄く、ask の精度が落ちる。
  // 対象型: Decision / RejectedOption / Constraint / Goal / Risk / OperationalKnowledge
  // ─────────────────────────────────────────────────────────────
  const KNOWLEDGE_DESC_TYPES = new Set([
    "Decision", "RejectedOption", "Constraint", "Goal", "Risk", "OperationalKnowledge",
  ]);
  const descMissingNodes: string[] = [];
  for (const n of graph.nodes) {
    if (!KNOWLEDGE_DESC_TYPES.has(String(n.type))) continue;
    const desc = n.description;
    if (desc === undefined || desc === null || String(desc).trim() === "") {
      descMissingNodes.push(`[${n.type}] ${String(n.id ?? "").split(":").pop()} - ${(String(n.title ?? "")).slice(0, 60)}`);
    }
  }
  if (descMissingNodes.length > 0) {
    findings.push({
      severity: "WARN",
      rule: "knowledge-description-missing",
      message: `${descMissingNodes.length} knowledge node(s) missing description (Decision / RejectedOption / Constraint / Goal / Risk / OperationalKnowledge). With only summary, the embedding carries little meaning, which directly hurts ask precision. Write background, rationale, and concrete examples into each node's description.`,
      details: descMissingNodes.slice(0, 30),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Project vault 専用チェック (--schema project の場合のみ実行)
  // ─────────────────────────────────────────────────────────────
  if (args.schema === "project") {
    const projectFindings = runProjectChecks(graph, outEdges, inEdges);
    findings.push(...projectFindings);
  }

  // ─────────────────────────────────────────────────────────────
  // 出力
  // ─────────────────────────────────────────────────────────────
  const summary = {
    total: findings.length,
    errors: findings.filter(f => f.severity === "ERROR").length,
    warnings: findings.filter(f => f.severity === "WARN").length,
    infos: findings.filter(f => f.severity === "INFO").length,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, accounting, findings }, null, 2));
  } else {
    const schemaLabel = args.schema ? ` [schema: ${args.schema}]` : "";
    console.log(`=== Carving check on ${args.graphPath}${schemaLabel} ===`);
    console.log(`nodes: ${graph.nodes.length} | files: ${files.length} | components: ${components.length} | concerns: ${concerns.length} | layers: ${layers.length}`);
    console.log();
    // 免除会計 (常時印字): 免除がゼロでも「ゼロである」ことを見せる
    console.log(`--- allowed-orphan accounting ---`);
    console.log(`Files by role: ${Object.entries(roleCounts).map(([r, c]) => `${r}:${c}`).join(", ") || "(no files)"}`);
    console.log(`Exemptions: ${exemptions.length} (${configExemptCount} from config) | builtin/config exemption ratio over ${implFileTotal} implementation Files: ${(exemptRatio * 100).toFixed(1)}%`);
    console.log(`carving.json: ${loadedConfig.exists ? `${configPath} (${configOrphans.size} entries)` : "none"}`);
    for (const e of exemptions.slice(0, 20)) console.log(`  - ${e.path} (${e.basis})`);
    if (exemptions.length > 20) console.log(`  ... and ${exemptions.length - 20} more`);
    console.log();
    for (const f of findings) {
      console.log(`[${f.severity}] ${f.rule}`);
      console.log(`  ${f.message}`);
      if (f.details) {
        const arr = Array.isArray(f.details) ? f.details : [String(f.details)];
        for (const d of arr.slice(0, 10)) console.log(`    - ${d}`);
        if (arr.length > 10) console.log(`    ... and ${arr.length - 10} more`);
      }
      console.log();
    }
    console.log(`=== summary: ${summary.errors} ERROR / ${summary.warnings} WARN / ${summary.infos} INFO ===`);
  }

  // ERROR があれば exit 1 (CI で fail させたい時用)
  if (summary.errors > 0) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith("check-carving.ts")) { main(); }

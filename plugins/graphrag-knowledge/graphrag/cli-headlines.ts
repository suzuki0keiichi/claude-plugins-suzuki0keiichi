/**
 * Headline verb dispatch.
 * Called from cli.ts as `dispatchHeadline(verb, argv)`.
 *
 * Implementation scope:
 * - parseFlagsArgv: lightweight arg parser
 * - typed-add 5: add-decision / add-ok / add-risk / add-investigation / add-rejected-option
 * - ask: automatic escalation (Task 8)
 * - carve: index→suggest→check chain (Task 9)
 * - commit-mutation: apply plan via vault writer (OCC/commit/index)
 * - inspect: env / artifacts status check
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { applyMutationToVault } from "./mutate-vault.ts";
import {
  detectVaultIsolation, assertVaultWriteAllowed, reportVaultResolution, getVaultDirSource,
  stateDirForVault, stateDirUnder, discoverStateDir,
  cacheDirUnder, cacheDirForVault, consumerCacheDirForVault,
  type VaultMode
} from "./cli-env.ts";
import { loadMutationPlan } from "./mutation-core.ts";
import {
  buildAddDecisionPlan,
  buildAddOkPlan,
  buildAddRiskPlan,
  buildAddConstraintPlan,
  buildAddGoalPlan,
  buildAddInvestigationPlan,
  buildAddRejectedOptionPlan
} from "./cli-typed-add.ts";
import {
  buildAddStakeholderPlan,
  buildAddResourcePlan,
  buildAddMilestonePlan,
  buildAddAssumptionPlan,
  buildAddAgreementPlan,
  buildAddTaskPlan,
  buildAddSourcePlan,
  buildAddThemePlan
} from "./cli-typed-add-project.ts";
import { buildGraphBrief } from "./brief.ts";
import { buildEvidencePacket } from "./evidence-packet.ts";
import { formatAskMarkdown } from "./ask-format.ts";
import { evidenceStaleNoteForNode, readEvidenceChangesByPath, refuteEvidenceChangeViaGit } from "./lane-log.ts";
import { isEchoAlias } from "./delta-check.ts";
import { bumpCallCount, recordAskHits, resolveAskStateDir } from "./cli-ask-state.ts";
import { buildWorldHints, resolveWorldDir, worldCachePath, WORLD_FILE } from "./world.ts";
import { augmentMatchesWithXRefResolutions } from "./xref-resolver.ts";
import { loadRequiredVectorIndex, prepareVectorSearch, loadGraph, vaultVectorIndexReadPath } from "./retrieval.ts";
import { loadLexicalIndex } from "./lexical-index.ts";
import { embedForIndex } from "./vector.ts";
import { countBindingDebt } from "./binding-debt.ts";
import { importVault } from "./import-vault.ts";
import { resolveSchema } from "./schema-registry.ts";
import { indexCodebase, resolvePreviousGraph } from "./index-codebase.ts";
import { buildAreaMap } from "./crosscut-map.ts";
import { enforcementDebt } from "./constraint-check.ts";
import { buildAndWriteVectorIndex } from "./build-vector-index.ts";
import { main as runConcernHint } from "./suggest-concern-hints.ts";
import { main as runEdgeSuggestPolicy } from "./suggest-policy-edges.ts";
import { main as runCarvingCheck } from "./check-carving.ts";
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";

/**
 * Lightweight arg parser.
 * --flag value | --flag=value | --flag (= true) | positional (= accumulated in _positional)
 * Repeated --flag → converted to array
 */
export function parseFlagsArgv(argv: string[]): Record<string, any> {
  const out: Record<string, any> = { _positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      out._positional.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    let key: string, value: any;
    if (eq >= 0) {
      key = tok.slice(2, eq);
      value = tok.slice(eq + 1);
    } else {
      key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        value = true;
      } else {
        value = next;
        i++;
      }
    }
    if (out[key] === undefined) {
      out[key] = value;
    } else if (Array.isArray(out[key])) {
      out[key].push(value);
    } else {
      out[key] = [out[key], value];
    }
  }
  return out;
}

/**
 * Converts --flag on|off to boolean. Unspecified (undefined) returns undefined as-is
 * (= defers to default behavior); only "off" returns false; "on" or other values return true.
 */
export function parseOnOff(value: any): boolean | undefined {
  if (value === undefined) return undefined;
  const s = String(value).trim().toLowerCase();
  if (s === "off" || s === "false") return false;
  return true;
}

function requireFlag(flags: Record<string, any>, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return v;
}

function asEvidenceArray(flags: Record<string, any>): string[] | undefined {
  const v = flags.evidence;
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * E8: typed-add --evidence / --enforced-by が指す File ノードが vault に無いときの摩擦解消。
 * 参照 path が repo 上に実在する場合に限り、最小の File ノード
 * {op:create, id, type:"File", path, title} を plan に自動追加する (typo ガード:
 * ディスクに無い path は「そう」と明示して失敗させる)。対象は plan の documented_by /
 * enforced_by エッジ (typed-add の evidence / enforcer 経路) の宛先 `file:` id のみ。
 * 戻り値 = 自動追加した File (verb 出力・stderr で可視化する)。
 */
const FILE_TARGET_EDGE_FLAGS: Record<string, string> = {
  documented_by: "--evidence",
  enforced_by: "--enforced-by"
};

export function ensureEvidenceFileNodes(
  plan: any,
  vaultDir: string,
  deps: { loadGraph?: () => any; repoRoot?: string } = {}
): { id: string; path: string }[] {
  const flagByTargetId = new Map<string, string>();
  for (const e of plan.edges ?? []) {
    if (
      (e.op ?? "create") === "create" &&
      typeof e.type === "string" &&
      FILE_TARGET_EDGE_FLAGS[e.type] !== undefined &&
      typeof e.to === "string" &&
      e.to.startsWith("file:")
    ) {
      if (!flagByTargetId.has(e.to)) flagByTargetId.set(e.to, FILE_TARGET_EDGE_FLAGS[e.type]);
    }
  }
  if (flagByTargetId.size === 0) return [];
  const planNodeIds = new Set((plan.nodes ?? []).map((n: any) => n.id));
  const candidates = [...flagByTargetId.keys()].filter((id) => !planNodeIds.has(id));
  if (candidates.length === 0) return [];
  const graph = deps.loadGraph ? deps.loadGraph() : importVault(vaultDir);
  const existingIds = new Set((graph.nodes ?? []).map((n: any) => n.id));
  // File の path は repo root 相対 (indexer 規約)。repo root は vault を保持する
  // `.graphrag` の親 (既定 <root>/.graphrag/vault と sibling <root>/vault の両レイアウトで root)。
  const repoRoot = deps.repoRoot ?? path.dirname(stateDirForVault(vaultDir));
  const created: { id: string; path: string }[] = [];
  for (const id of candidates) {
    if (existingIds.has(id)) continue;
    // id 規約 `file:<system>:<path>` (path は `:` を含まない前提だが slice で安全に復元)。
    const relPath = id.split(":").slice(2).join(":");
    if (!relPath || !existsSync(path.join(repoRoot, relPath))) {
      throw new Error(
        `${flagByTargetId.get(id)} ${id}: File node does not exist in the vault, and path "${relPath}" does not exist on disk ` +
          `(repo root: ${repoRoot}). Fix the path if it is a typo; if it genuinely refers to something outside ` +
          `this repo, create the File node manually via commit-mutation.`
      );
    }
    const node = { op: "create", id, type: "File", path: relPath, title: path.basename(relPath) };
    plan.nodes = [...(plan.nodes ?? []), node];
    created.push({ id, path: relPath });
  }
  return created;
}

// ── alias 所有権プローブ (issue #22) ─────────────────────────────────────────
//
// authority echo の語彙指紋 (aliases) は「自リポジトリが所有する語彙」だけが機能する
// (登記済み教訓: 例示語彙や汎用語を指紋にすると正当利用のたびに echo り、読み手が
// 「echo は無視してよい」を学習して導線ごと死ぬ — 精度経済)。実運用 1 ヶ月の実測では
// echo 9 発火中 8 が汎用シンボル (execFile / tar.gz / fileType 型) 由来の偽陽性だった。
//
// 「これはライブラリ名か」という意味判断はしない。代わりに決定的な所有権テスト:
// 登録しようとした echo 対象 alias が、この plan の evidence 家の外の既存ファイルに
// 既に広く出現している (= 語彙が既にリポジトリ中で共有されている) なら、それは登録した
// 瞬間から鳴り続ける指紋なので警告する。非ブロッキング (警告のみ — issue #22 の裁定)。
// git 不在・grep 失敗は無音 skip (プローブの失敗で書き込みを落とさない)。
const ALIAS_PROBE_FILE_THRESHOLD = 3;

// プローブの grep 対象はコードリポジトリ。候補は cwd の git toplevel と
// dirname(stateDirForVault(vault)) の2つだが、どちらも構成次第で vault リポジトリを
// 指し得る (external vault の中で CLI を叩いた場合など — その場合 grep は .md しか
// 当たらず、プローブは無音で空振りする偽陰性になる)。そこで plan 自身が参照する
// file:<system>:<path> の実在で候補を自己検証し、evidence の実体を持つ候補だけを使う。
// どの候補にも実体が無ければ null (間違ったリポジトリを黙って grep しない)。
export function codeRepoRootForProbe(vaultDir: string, plan: any): string | null {
  const candidates: string[] = [];
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    if (top.length > 0) candidates.push(top);
  } catch {
    /* git 外 — vault 由来の候補のみ */
  }
  const vaultRoot = path.dirname(stateDirForVault(vaultDir));
  if (!candidates.includes(vaultRoot)) candidates.push(vaultRoot);

  const refPaths = new Set<string>();
  for (const e of plan.edges ?? []) {
    if (typeof e?.to === "string" && e.to.startsWith("file:")) {
      const p = e.to.split(":").slice(2).join(":");
      if (p.length > 0) refPaths.add(p);
    }
  }
  for (const n of plan.nodes ?? []) {
    if (n?.type === "File" && typeof n.path === "string" && n.path.length > 0) refPaths.add(n.path);
  }
  if (refPaths.size === 0) return candidates[0] ?? null; // 検証材料なし — 最有力候補で行く
  for (const c of candidates) {
    for (const p of refPaths) {
      if (existsSync(path.join(c, p))) return c;
    }
  }
  return null;
}

// alias 所有権プローブの発注 + 報告 (typed-add / commit-mutation 共通)。
// 警告があれば {warnings} を返し stderr にも 1 行出す。失敗・root 不明は undefined (無音)。
function aliasProbeReport(plan: any, vaultDir: string): { warnings: ReturnType<typeof probeAliasOwnership> } | undefined {
  try {
    const root = codeRepoRootForProbe(vaultDir, plan);
    if (!root) return undefined;
    const warnings = probeAliasOwnership(plan, root);
    if (warnings.length === 0) return undefined;
    process.stderr.write(
      `[graphrag] WARN: ${warnings.length} alias(es) look like shared/generic vocabulary — ` +
      `they will echo on every legitimate use. See alias_probe in output.\n`
    );
    return { warnings };
  } catch {
    return undefined; // プローブ失敗は無音 (書き込みは確定済み)
  }
}

export function probeAliasOwnership(
  plan: any,
  repoRoot: string,
  deps: { grepFiles?: (root: string, token: string) => string[] } = {}
): { alias: string; node_id: string; files: number; sample: string[]; message: string }[] {
  const grepFiles =
    deps.grepFiles ??
    ((root: string, token: string): string[] => {
      try {
        const out = execFileSync(
          "git",
          ["-C", root, "grep", "-l", "--fixed-strings", "--word-regexp", token, "--", "."],
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
        );
        return out.split("\n").filter(Boolean);
      } catch {
        return []; // no match (exit 1) / git 不在 — どちらも「出現なし」扱い
      }
    });

  const warnings: { alias: string; node_id: string; files: number; sample: string[]; message: string }[] = [];
  for (const node of plan.nodes ?? []) {
    if ((node.op ?? "create") !== "create") continue;
    const aliases = Array.isArray(node.aliases) ? node.aliases : [];
    if (aliases.length === 0) continue;
    // この node の家 = plan 内で node → file:... へ張られたエッジの path 群。
    const homes = new Set<string>(
      (plan.edges ?? [])
        .filter((e: any) => e.from === node.id && typeof e.to === "string" && e.to.startsWith("file:"))
        .map((e: any) => e.to.split(":").slice(2).join(":"))
        .filter((p: string) => p.length > 0)
    );
    for (const alias of aliases) {
      if (typeof alias !== "string" || !isEchoAlias(alias)) continue;
      // echo と同じ走査対象に合わせる (.md / .graphrag は echo が見ないので数えない)。
      const files = grepFiles(repoRoot, alias).filter(
        (p) => !homes.has(p) && !p.endsWith(".md") && !p.split("/").includes(".graphrag")
      );
      if (files.length < ALIAS_PROBE_FILE_THRESHOLD) continue;
      warnings.push({
        alias,
        node_id: String(node.id),
        files: files.length,
        sample: files.slice(0, 5),
        message:
          `alias "${alias}" already appears in ${files.length} repo file(s) OUTSIDE this node's evidence home — ` +
          `if this vocabulary is not OWNED by this authority (library/runtime/general API names are the usual ` +
          `culprits), it will fire an authority echo on every future commit touching it and train readers to ` +
          `ignore echoes (crying wolf). Keep aliases to vocabulary this node owns; if unintended, drop it via ` +
          `{"op":"update","id":"${node.id}","updates":{"aliases":[...without it]}}.`
      });
    }
  }
  return warnings;
}

async function applyPlanAndReport(plan: any, f: Record<string, any>): Promise<void> {
  // v3: typed-add goes through vault writer (not FalkorDB). Vault is the single source of truth.
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) {
    throw new Error("typed-add requires a vault: GRAPHRAG_VAULT_DIR env not set (must be provided via .env)");
  }

  // vault isolation check: 外部 vault でローカル mode が無い or readonly なら書き込みを拒否
  // (単一ゲート assertVaultWriteAllowed。commit-mutation / vault-build と共通)。
  const isolation = assertVaultWriteAllowed({ vaultDir });
  // どの vault にどの根拠で書くのかを毎回可視化する (stderr 1 行 + JSON 同梱)。
  const vaultResolution = reportVaultResolution(vaultDir);

  const schema = resolveSchema(vaultDir);
  const dupAck = dupAckFlag(f);
  if (dupAck) plan.duplicate_ack = dupAck;
  // E8: --evidence の File ノードが vault に無ければ、ディスク実在を確認して自動作成する。
  const fileAutoCreated = ensureEvidenceFileNodes(plan, vaultDir);
  if (fileAutoCreated.length > 0) {
    process.stderr.write(
      `[graphrag] auto-created File node(s) for --evidence: ${fileAutoCreated.map((c) => c.id).join(", ")}\n`
    );
  }
  const result = await applyMutationToVault({ plan, vaultDir, schema, baseSha: baseShaFlag(f), reason: plan.reason });

  const output: any = { applied: true, plan_reason: plan.reason, ...vaultResolution, result };
  // alias 所有権プローブ (issue #22, 非ブロッキング): echo 指紋になる alias が既に
  // リポジトリ中に広く出現していれば警告を同梱する。stderr にも 1 行 (見落とし防止)。
  const probe = aliasProbeReport(plan, vaultDir);
  if (probe) output.alias_probe = probe;
  if (fileAutoCreated.length > 0) {
    output.file_auto_created = fileAutoCreated;
  }
  if (isolation.vault_external) {
    output.vault_isolation = isolation;
  }
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function baseShaFlag(f: Record<string, any>): string | undefined {
  return typeof f["base-sha"] === "string" ? f["base-sha"] : undefined;
}

/**
 * --dup-ack <id[,id...]> (repeatable) → approves duplicate gate (injected into plan's duplicate_ack).
 * Accepts both comma-separated and repeated flag syntax.
 */
export function dupAckFlag(f: Record<string, any>): string[] | undefined {
  const v = f["dup-ack"];
  if (v === undefined) return undefined;
  const values = Array.isArray(v) ? v : [v];
  const ids = values
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length > 0 ? ids : undefined;
}

/**
 * Common parser accepting both comma-separated and repeated flag forms for id lists.
 * Absorbs both --aliases "a,b" and --constrains <id> --constrains <id> forms.
 * Returns undefined (not empty array) when unspecified (consistent with plan builder "omit if unspecified").
 */
function csvFlag(f: Record<string, any>, name: string): string[] | undefined {
  const v = f[name];
  if (v === undefined) return undefined;
  const values = Array.isArray(v) ? v : [v];
  const ids = values
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length > 0 ? ids : undefined;
}

function strFlag(f: Record<string, any>, name: string): string | undefined {
  return typeof f[name] === "string" ? f[name] : undefined;
}

async function runAddDecision(argv: string[]) {
  const f = parseFlagsArgv(argv);
  const plan = buildAddDecisionPlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    evidence: asEvidenceArray(f),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases"),
    // E1 add-decision 追加フラグ
    setsPolicyFor: csvFlag(f, "sets-policy-for"),
    premise: csvFlag(f, "premise"),
    reducesRisk: csvFlag(f, "reduces-risk"),
    refines: strFlag(f, "refines"),
    fromInvestigation: strFlag(f, "from-investigation")
  });
  await applyPlanAndReport(plan, f);
}

async function runAddOk(argv: string[]) {
  const f = parseFlagsArgv(argv);
  const plan = buildAddOkPlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    evidence: asEvidenceArray(f),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases"),
    // E1 add-ok 追加フラグ
    premise: csvFlag(f, "premise"),
    reducesRisk: csvFlag(f, "reduces-risk"),
    refines: strFlag(f, "refines")
  });
  await applyPlanAndReport(plan, f);
}

async function runAddRisk(argv: string[]) {
  const f = parseFlagsArgv(argv);
  const plan = buildAddRiskPlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    evidence: asEvidenceArray(f),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases"),
    // E1 add-risk 追加フラグ
    risksIn: csvFlag(f, "risks-in")
  });
  await applyPlanAndReport(plan, f);
}

async function runAddConstraint(argv: string[]) {
  const f = parseFlagsArgv(argv);
  // 値なしの --unenforceable (true) は理由の欠落 — 黙って空扱いにせず具体的に案内する。
  if (f.unenforceable === true) {
    throw new Error(
      '--unenforceable requires a reason: --unenforceable "<why no mechanical check can express this>" ' +
        "(the reason is recorded as enforcement_reason and shown whenever constraint-check lists the constraint as unguarded)."
    );
  }
  // enforcement contract は system プリセット限定 (project/principal vault の Constraint は外部条件)。
  // vault 未解決なら厳格側 (system) に倒す — apply 時にどのみち vault 必須で止まる。
  const vaultDirForSchema = process.env.GRAPHRAG_VAULT_DIR;
  const schemaPreset = vaultDirForSchema ? resolveSchema(vaultDirForSchema).id : "system";
  // E2 add-constraint: --constrains 必須 ≥1 (builder が空で throw)。
  // Constraint は documented_by 不可・evidence 不要 (契約) → evidence は渡さない。
  // enforcement contract: --enforced-by (機械的消費者) か --unenforceable (明示宣言) のどちらかが必須。
  const plan = buildAddConstraintPlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases"),
    constrains: csvFlag(f, "constrains") ?? [],
    enforcedBy: csvFlag(f, "enforced-by"),
    unenforceable: strFlag(f, "unenforceable"),
    premise: csvFlag(f, "premise"),
    schemaPreset
  });
  await applyPlanAndReport(plan, f);
}

async function runAddGoal(argv: string[]) {
  const f = parseFlagsArgv(argv);
  // E2 add-goal: --state は任意 (既定 state なし)。指定時のみ builder が語彙検証。
  // --evidence も任意 (他 verb と違い必須にしない): 予約作業 (planned) を場所に宿らせる
  // documented_by。張ると delta-check がその場所を触った commit で見出しを浮上させる。
  const plan = buildAddGoalPlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    evidence: asEvidenceArray(f),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases"),
    refines: strFlag(f, "refines"),
    derivedFrom: strFlag(f, "derived-from"),
    state: strFlag(f, "state")
  });
  await applyPlanAndReport(plan, f);
}

async function runAddInvestigation(argv: string[]) {
  const f = parseFlagsArgv(argv);
  let rawContent = requireFlag(f, "raw-content");
  // file:<path> 接頭辞でファイル読み込み (large raw_content の取り回しに)
  if (rawContent.startsWith("file:")) {
    const filePath = rawContent.slice("file:".length);
    rawContent = readFileSync(filePath, "utf8");
  }
  const plan = buildAddInvestigationPlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    rawContent,
    state: strFlag(f, "state"),
    evidence: asEvidenceArray(f),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases")
  });
  await applyPlanAndReport(plan, f);
}

/**
 * Pure function to determine whether to escalate to the next stage from brief results.
 * - high confidence + results found → no escalation needed
 * - low / none / zero results → escalate
 */
export function shouldEscalate(stageOutcome: { match_confidence?: string; result_count?: number }): boolean {
  const conf = stageOutcome.match_confidence ?? "none";
  const count = stageOutcome.result_count ?? 0;
  if (conf === "high" && count > 0) return false;
  return true;
}

export async function runAsk(argv: string[]) {
  const f = parseFlagsArgv(argv);
  // --lexical-only は値を取らない boolean フラグだが、parseFlagsArgv は「次の非フラグ
  // トークンを値に取る」ため `ask --lexical-only "質問"` (障害時の主要な打ち方) で質問が
  // フラグ値に飲まれ、escape hatch が無言で無効になる。文字列が来ていたら positional へ戻す。
  if (typeof f["lexical-only"] === "string") {
    (f._positional as string[]).unshift(f["lexical-only"]);
    f["lexical-only"] = true;
  }
  const positional = f._positional as string[];
  const question = positional[0];
  if (!question) throw new Error('ask "<question>" requires a positional question argument');
  const limit = typeof f.limit === "string" ? Number(f.limit) : 3;
  const neighbors = typeof f.neighbors === "string" ? Number(f.neighbors) : 1;

  // R6 --gist "<one-line expected answer>" (optional): embed question and gist separately, pass both as queryVectors
  // (semantic = max cosine with each vector). Query prefix is applied to both (embedForIndex).
  const gist = typeof f.gist === "string" && f.gist.trim() !== "" ? f.gist : undefined;
  // R5 --graph-rerank on|off (default off — hub-heavy net-negative observed in real vault. See R5 comment in retrieval.ts).
  const graphRerank = parseOnOff(f["graph-rerank"]);
  // --lexical-only (issue #24): embedding endpoint 障害時の明示 escape hatch。
  // 「semantic 非交渉・無言 fallback 禁止」(retrieval.ts) は守る — これは fallback ではなく
  // 呼び手が明示した degrade で、出力に DEGRADED を焼き込む。
  const lexicalOnly = f["lexical-only"] === true;
  // --format md|json (issue #24): LLM がそのまま読める markdown ダイジェスト。既定は JSON。
  const outputFormat = typeof f.format === "string" ? f.format : "json";
  if (outputFormat !== "json" && outputFormat !== "md") {
    throw new Error(`ask --format accepts "json" (default) or "md", got: ${outputFormat}`);
  }

  // v3: vault is the single source of truth. Resolve vault via --vault flag > GRAPHRAG_VAULT_DIR env,
  // and pass explicitly to read operations (brief/evidence) rather than relying on env.
  // vault を「最初に」解決し、無ければ state (ask-state 等) に一切触れる前に大声で止まる。
  // 以前は先に bumpCallCount が state dir を掘っており、vault 未解決の cwd に
  // ゴミ .graphrag を量産していた。
  const vaultDir = (typeof f.vault === "string" ? f.vault : undefined) ?? process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) {
    throw new Error(
      "ask requires a vault: pass --vault <dir> or set GRAPHRAG_VAULT_DIR " +
      "(auto-discovered from an ancestor .graphrag/vault). No state is written without a vault."
    );
  }

  // --call-number auto-incremented (manual LLM assignment removed → excessive detection runs structurally)
  // ask-state は機械ローカルなので cache/ に置く (E1)。readonly mode の外部 vault では
  // 外部側に書かず、消費側ローカルの cache/external/<hash>/ へ (E3)。
  // 置き場所を解決できない場合は永続化を skip する (ディレクトリを勝手に掘らない)。
  const isolation = detectVaultIsolation(process.cwd(), vaultDir);
  const askStateDir = resolveAskStateDir(vaultDir, isolation.raw_mode);
  const callNumber = askStateDir ? bumpCallCount(question, askStateDir) : 1;

  // Pre-share retrieval inputs across stages: load graph + vector index once and
  // embed the query once, then hand them to both brief and evidence (the old code
  // pre-shared only when world/--gist was set, so every escalation re-ran
  // loadGraph + loadRequiredVectorIndex and re-embedded the same question).
  // On index/embedding failure fall back to the normal path: brief will fail
  // loudly for the same reason.
  // When --gist is specified, pass both question and gist as 2 R6 queryVectors.
  const worldDir = resolveWorldDir(typeof f.world === "string" ? f.world : undefined);
  const graphData = await loadGraph(vaultDir);
  // issue #33: 永続転置 index を 1 回だけ読み、brief / evidence の両段で共有する
  // (loadLexicalIndex は指紋不一致/破損なら再計算+再永続化し、失敗時は null =
  //  searchGraph の従来経路のまま)。
  const sharedLexicalIndex = await loadLexicalIndex(vaultDir, graphData);
  let sharedVectorIndex: any = null;
  let sharedQueryVector: number[] | null = null;
  let sharedQueryVectors: number[][] | null = null;
  try {
    if (lexicalOnly) throw new Error("lexical-only: skip vector index");
    // issue #34: 読み込み済み graph を渡す — 鮮度判定は graph/index の内容突合
    // (vault の mtime walk なし)。stale 再 build も同じ graph から行う。
    sharedVectorIndex = await loadRequiredVectorIndex(vaultDir, undefined, { graph: graphData });
    if (gist) {
      // 質問と gist を index の prefix_policy に従って query 接頭辞付きで埋め込む。
      const qv = await embedForIndex(sharedVectorIndex, question, "query");
      const gv = await embedForIndex(sharedVectorIndex, gist, "query");
      sharedQueryVectors = [qv, gv];
      sharedQueryVector = qv; // world ヒント等の単一ベクトル経路には質問側を渡す
    } else {
      sharedQueryVector = (await prepareVectorSearch(question, { vectorIndex: sharedVectorIndex })).queryVector;
    }
  } catch {
    sharedVectorIndex = null;
    sharedQueryVector = null;
    sharedQueryVectors = null;
  }

  const stages: any[] = [];
  let finalStage: "brief" | "evidence" = "brief";

  // Stage 1: brief (query mode)
  const briefOut: any = await buildGraphBrief({
    mode: "query",
    query: question,
    graph: vaultDir,
    graphData,
    limit,
    callNumber,
    lexicalIndex: sharedLexicalIndex,
    vectorIndex: sharedVectorIndex ?? undefined,
    queryVector: sharedQueryVector ?? undefined,
    queryVectors: sharedQueryVectors ?? undefined,
    graphRerank,
    ...(lexicalOnly ? { useVector: false } : {})
  });
  stages.push({ stage: "brief", output: briefOut });

  // E4 ask-trail: brief の top matches (≤3) を ask-trail に記録する。
  // 後続の書き込み時提案 (premise_candidates) が直近ヒットを引くための副産物。
  // 記録の失敗で ask 本体を落とさない。
  try {
    const topIds = ((briefOut?.query?.matches ?? []) as any[])
      .map((m) => m?.node?.id)
      .filter((id): id is string => typeof id === "string")
      .slice(0, 3);
    if (topIds.length > 0 && askStateDir) recordAskHits(question, topIds, askStateDir);
  } catch {
    // ask-trail 記録は非致命。失敗しても brief 出力はそのまま返す。
  }

  const briefOutcome = {
    match_confidence: briefOut?.query?.match_confidence,
    result_count: (briefOut?.query?.matches ?? []).length
  };

  // evidence 段の limit: --limit 明示があればそれ、無ければ evidence 既定の 8
  // (brief 既定の 3 より広く掘る)。
  const evidenceLimit = typeof f.limit === "string" ? Number(f.limit) : 8;
  let evidenceOut: any = null;
  if (shouldEscalate(briefOutcome)) {
    // Stage 2: evidence (内部で search も走る = retrieval ladder の "search" は
    // evidence に包含される)。evidence packet は direct_evidence (=ranked search
    // matches) と graph_context (=neighbors expansion) の両方を返す。
    // direct_evidence が空なら本当に無いと言える。
    // 旧実装は final_stage に到達不能な "search" 分岐を持っていた (両分岐とも
    // "evidence" 代入) — 段は brief | evidence の 2 値に単純化した。
    finalStage = "evidence";
    evidenceOut = await buildEvidencePacket({
      request: question,
      vault: vaultDir,
      limit: evidenceLimit,
      neighbors,
      types: [],
      // brief と同じ graph / 索引 / query embedding を共有する (再読込・再 embed しない)。
      graphData,
      lexicalIndex: sharedLexicalIndex,
      vectorIndex: sharedVectorIndex ?? undefined,
      queryVectors: sharedQueryVectors ?? (sharedQueryVector ? [sharedQueryVector] : undefined),
      ...(lexicalOnly ? { useVector: false } : {})
    });
    stages.push({ stage: "evidence", output: evidenceOut });
  }

  // world ヒント: 問いと各 vault の自己紹介 (写し) を突き合わせ「vault X にも知識が
  // ありそう」と添える。ヒント機構の失敗で ask 本体を落とさない (エラーは結果に正直に出す)。
  let worldHints: any = undefined;
  if (worldDir) {
    try {
      worldHints = await buildWorldHints(question, {
        worldDir,
        currentVaultDir: vaultDir,
        queryVector: sharedQueryVector,
        queryModel: sharedVectorIndex?.provider_options?.model ?? null,
        limit: 3
      });
    } catch (error) {
      worldHints = {
        world_dir: worldDir,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  const askSchema = vaultDir ? resolveSchema(vaultDir) : undefined;

  // Stage 3 cross-vault ref resolution: when worldDir is configured, attempt to
  // resolve any vault: prefixed `to` fields found in the brief matches' relations.
  // Non-throwing: failures are noted inline, ask output is never dropped.
  if (worldDir) {
    try {
      if (briefOut?.query?.matches) {
        briefOut.query.matches = augmentMatchesWithXRefResolutions(briefOut.query.matches, worldDir);
      }
      for (const stage of stages) {
        if (stage?.output?.direct_evidence) {
          stage.output.direct_evidence = augmentMatchesWithXRefResolutions(stage.output.direct_evidence, worldDir);
        }
      }
    } catch {
      // xref resolution is non-fatal — never surface as an error in ask output
    }
  }

  // next_action_hint は「最終段」の結果で決める。旧実装は brief の結果だけを見て
  // いたので、evidence 段で十分な証拠が出ても「別キーワードを試せ」と言い続けていた。
  const lastOutcome = evidenceOut
    ? {
        match_confidence: evidenceOut.match_confidence,
        result_count: (evidenceOut.direct_evidence ?? []).length
      }
    : briefOutcome;

  // ① area_map: 今回触る領域の登記済み横断構造 (Component/Layer/Concern) を毎回同乗させる。
  // 「設計で必ず参考にする」を新トリガーで作るのは無理 (発火しないトリガーは無いのと同じ) —
  // 発火実績のある ask に地図を載せ、見ない方が難しい状態にする。失敗しても ask 本体は落とさない。
  let areaMap: any = undefined;
  try {
    areaMap = buildAreaMap(graphData, collectAskScopeIds(briefOut, evidenceOut));
  } catch (error) {
    areaMap = { error: error instanceof Error ? error.message : String(error) };
  }

  // enforcement contract 導入前の vault への移行導線: 未ガード Constraint があれば
  // ask に同乗して知らせる (stocktake_hint と同じ流儀 — 発火実績のあるトリガーに載せる)。
  let enforcementDebtOut: any = undefined;
  if (askSchema?.id === "system") {
    try {
      const debt = enforcementDebt(graphData);
      if (debt.unguarded > 0) {
        enforcementDebtOut = {
          unguarded_constraints: debt.unguarded,
          constraints_total: debt.total,
          hint:
            `${debt.unguarded} Constraint(s) in this vault have no mechanical consumer — nothing fails when they are ` +
            "violated (likely written before the enforcement contract). Run `constraint-check` for per-constraint " +
            'prescriptions: wire the check that fails on violation via enforced_by, or declare enforcement:"none" with a reason.'
        };
      }
    } catch {
      // 同乗情報の失敗で ask 本体を落とさない
    }
  }

  // evidence 鮮度注記 (issue #21): 配達するノードの evidence ファイルが、そのノードの
  // 最終検証時点 (generated_at) より後に commit lane で変更を観測されていれば ⚠ を添える。
  // 検知は台帳 (lane-log) 参照のみでほぼ無料。再抽出はしない — 読み手に正本確認の
  // 判断材料を渡すのが目的 (機械は提示のみ、意味判断はしない)。失敗しても ask は落とさない。
  try {
    const askCacheDir = cacheDirForVault(vaultDir);
    const changesByPath = readEvidenceChangesByPath(askCacheDir);
    if (changesByPath.size > 0) {
      const nodesById = new Map((graphData.nodes ?? []).map((n: any) => [n.id, n]));
      // 猶予窓 (同一セッションの「書き戻し→commit」順序反転を偽 ⚠ にしない) は env で調整可。
      const graceHours = Number(process.env.GRAPHRAG_EVIDENCE_STALE_GRACE_HOURS);
      const graceMs = Number.isFinite(graceHours) && graceHours >= 0 ? graceHours * 3600_000 : undefined;
      // git 裏取り用の code repo root (revert / 未コミット断念で消えた変更の台帳残骸を落とす)。
      let askRepoRoot: string | null = null;
      try {
        askRepoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"]
        }).trim() || null;
      } catch {
        askRepoRoot = null; // git 外 — 裏取りなし (注記は残す側に倒れる)
      }
      const attach = (m: any) => {
        const id = m?.node?.id;
        if (typeof id !== "string") return m;
        const staleNote = evidenceStaleNoteForNode(id, graphData, changesByPath, nodesById, { graceMs });
        if (!staleNote) return m;
        const survivingPaths = askRepoRoot
          ? staleNote.paths.filter((p) => !refuteEvidenceChangeViaGit(askRepoRoot!, p.path, staleNote.verified_at))
          : staleNote.paths;
        if (survivingPaths.length === 0) return m;
        return { ...m, evidence_stale: { ...staleNote, paths: survivingPaths } };
      };
      if (briefOut?.query?.matches) briefOut.query.matches = briefOut.query.matches.map(attach);
      for (const stage of stages) {
        if (stage?.output?.direct_evidence) {
          stage.output.direct_evidence = stage.output.direct_evidence.map(attach);
        }
      }
    }
  } catch {
    // 鮮度注記は同乗情報 — 失敗で ask 本体を落とさない
  }

  const payload = {
    question,
    call_number: callNumber,
    final_stage: finalStage,
    // 明示 degrade の焼き込み (issue #24): --lexical-only の結果は「semantic 検索を
    // 通っていない」ことを読み手が見落とせない形で出力に刻む (無言 fallback の禁止と両立)。
    ...(lexicalOnly
      ? {
          retrieval_mode: {
            semantic: false,
            reason: "--lexical-only",
            warning:
              "DEGRADED: keyword/alias/ngram matching only — semantic recall is OFF. Absence of hits is weak " +
              "evidence in this mode; re-run without --lexical-only once the embedding endpoint is back."
          }
        }
      : {}),
    area_map: areaMap,
    ...(enforcementDebtOut !== undefined ? { enforcement_debt: enforcementDebtOut } : {}),
    next_action_hint: shouldEscalate(lastOutcome)
      ? "Try one different keyword → if still empty, switch to reading code/docs directly (the launcher increments --call-number structurally — do not over-trust the excessive signal)"
      : `${finalStage} result is sufficient — proceed to judgment from here`,
    ...(askSchema?.llmReference ? { schema_summary: { id: askSchema.id, reference: askSchema.llmReference } } : {}),
    ...(worldHints !== undefined ? { world_hints: worldHints } : {}),
    stages
  };
  process.stdout.write(
    outputFormat === "md" ? formatAskMarkdown(payload) : JSON.stringify(payload, null, 2) + "\n"
  );
}

async function runCommitMutation(argv: string[]) {
  const f = parseFlagsArgv(argv);
  const planPath = (f._positional as string[])[0];
  if (!planPath) throw new Error("commit-mutation <plan.json> requires plan path");

  // v3: applied via vault writer (FalkorDB-export / vault-build / carving-check are retired).
  // lock → OCC → import → normalize/validate → writeVaultDelta → index(non-fatal) → git commit
  // are all handled by applyMutationToVault.
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) throw new Error("commit-mutation: GRAPHRAG_VAULT_DIR env not set (must be provided via .env)");

  // typed-add と同じ単一ゲート: readonly / 外部 vault のローカル mode 未設定は書かせない。
  assertVaultWriteAllowed({ vaultDir });
  const vaultResolution = reportVaultResolution(vaultDir);

  const schema = resolveSchema(vaultDir);
  const plan = await loadMutationPlan(planPath);
  const baseSha = typeof f["base-sha"] === "string" ? f["base-sha"] : undefined;
  const result = await applyMutationToVault({ plan, vaultDir, schema, baseSha, reason: plan.reason });

  // 属性名 typo の警告は JSON に同梱するだけでなく stderr にも 1 行出す
  // (パイプ先で summary が切り詰められても気付けるように)。
  if (result.attribute_check?.status === "warn") {
    process.stderr.write(
      `[graphrag] WARN: ${result.attribute_check.warnings.length} unknown attribute name(s) written — see attribute_check in output for the repair plan\n`
    );
  }

  // alias 所有権プローブ (issue #22, 非ブロッキング) — typed-add と同じ扱い。
  const aliasProbe = aliasProbeReport(plan, vaultDir);

  process.stdout.write(JSON.stringify({
    plan_path: planPath,
    plan_reason: plan.reason,
    ...vaultResolution,
    ...(aliasProbe ? { alias_probe: aliasProbe } : {}),
    summary: {
      applied: result.applied,
      ...(result.idempotent_replay ? { idempotent_replay: result.idempotent_replay } : {}),
      ...(result.note ? { note: result.note } : {}),
      changed_nodes: result.changed_nodes,
      cascaded_edge_ids: result.cascaded_edge_ids,
      head: result.head,
      duplicate_check: result.duplicate_check,
      attribute_check: result.attribute_check,
      index_status: result.index_status
    }
  }, null, 2) + "\n");
}

async function runCarve(argv: string[]) {
  const f = parseFlagsArgv(argv);
  const root = requireFlag(f, "root");
  const system = requireFlag(f, "system");
  const previous = typeof f.previous === "string" ? f.previous : undefined;
  const vault = typeof f.vault === "string" ? f.vault : undefined;
  // carve の成果物 (indexed-graph.json / vector-index.json) は機械ローカルな再生成物
  // なので、索引対象 root の .graphrag/cache/ に置く規約 (E1)。cwd 依存だと
  // サブディレクトリ実行で散らばる。
  const stateDir = process.env.GRAPHRAG_STATE_DIR ?? stateDirUnder(root);
  const cacheDir = cacheDirUnder(stateDir);

  process.stderr.write(`[carve] stage 1/3: index (root=${root}, system=${system})\n`);
  // Use the same vault-trust path as the standalone index verb. Previous genuine File summaries come from the canonical vault
  // only; scaffold (--previous) is for change_status only. Without this,
  // every carve would reset all File summaries to provisional, overwriting re-authored summaries.
  const { previous: previousGraph, trustSummaries } = resolvePreviousGraph({ root, previous, vault, systemName: system });
  const indexed: any = indexCodebase({ root, systemName: system, previous: previousGraph, trustPreviousSummaries: trustSummaries });
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const indexOutPath = path.join(cacheDir, "indexed-graph.json");
  writeFileSync(indexOutPath, JSON.stringify(indexed, null, 2));
  process.stderr.write(`[carve]   → wrote ${indexOutPath} (${indexed.nodes?.length ?? 0} nodes, ${indexed.edges?.length ?? 0} edges)\n`);

  // E4: GRAPHRAG_VECTOR_INDEX_PATH は「vault 索引」専用の env であり、carve は読まない。
  // 単一値を共用すると carve のコードグラフ索引が vault の embedding を黙って潰す。
  // carve の索引は常に stage-local (対象 root の cache/) に置く。
  //
  // 読みは cache/ (新) → legacy (.graphrag 直下、E1 移行前) の順にフォールバックする
  // (retrieval.vaultVectorIndexReadPath と同じパターン)。これが無いと、E1 で
  // cache/ に移る前に作った vector-index.json がアップグレード後に無視され、
  // コードベース全体の再 embed を強制していた。書き込み (再構築) は常に新パス。
  const vectorIndexWritePath = path.join(cacheDir, "vector-index.json");
  const legacyVectorIndexPath = path.join(stateDir, "vector-index.json");
  let vectorIndexPath = preferExisting(vectorIndexWritePath, legacyVectorIndexPath);

  // If no vector index, auto-build from index output and proceed to suggest steps
  // (avoids the manual round-trip of "carve → vector-index → carve again" even on first run).
  // Unreachable embedding endpoint remains non-fatal: skip suggest steps and note it.
  let vectorIndexReady = existsSync(vectorIndexPath);
  let vectorIndexSkipNote: string | null = null;
  if (!vectorIndexReady) {
    process.stderr.write(`[carve] vector index not found at ${vectorIndexPath} → attempting auto-build\n`);
    try {
      await buildAndWriteVectorIndex({ out: vectorIndexWritePath }, { graphObject: indexed });
      vectorIndexPath = vectorIndexWritePath;
      vectorIndexReady = true;
      process.stderr.write(`[carve]   → built ${vectorIndexPath}\n`);
    } catch (error) {
      vectorIndexSkipNote = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[carve]   → auto-build FAILED (embedding endpoint unreachable, etc.): ${vectorIndexSkipNote}\n`);
    }
  }

  if (vectorIndexReady) {
    process.stderr.write(`[carve] stage 2/3: concern-hint + edge-suggest-policy (vector index: ${vectorIndexPath})\n`);
    process.stderr.write(`--- concern-hint output ---\n`);
    runConcernHint(["--graph", indexOutPath, "--vector-index", vectorIndexPath]);
    process.stderr.write(`--- edge-suggest-policy output ---\n`);
    runEdgeSuggestPolicy(["--graph", indexOutPath, "--vector-index", vectorIndexPath, "--missing-only"]);
  } else {
    process.stderr.write(`[carve] stage 2/3: SKIPPED (vector index unavailable: ${vectorIndexSkipNote ?? "not found"}). `);
    process.stderr.write(`Stand up an embedding endpoint, then re-run carve to get through concern-hint + policy edge suggestions.\n`);
  }

  process.stderr.write(`[carve] stage 3/3: carving-check\n`);
  process.stderr.write(`--- carving-check output ---\n`);
  const checkArgs = ["--graph", indexOutPath];
  if (vectorIndexReady) checkArgs.push("--vector-index", vectorIndexPath);
  runCarvingCheck(checkArgs);

  process.stderr.write(`\n[carve] done. next:\n`);
  process.stderr.write(`  1. Review concern-hint + policy edge candidates and assemble a mutation plan (LLM)\n`);
  process.stderr.write(`  2. Apply to the vault with node graphrag/cli.ts commit-mutation <plan.json> (OCC/validate/index/git commit)\n`);
  process.stderr.write(`  3. If needed, re-run carve and drive carving-check errors to zero before calling it done\n`);
}

async function runAddRejectedOption(argv: string[]) {
  const f = parseFlagsArgv(argv);
  const plan = buildAddRejectedOptionPlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    rejectedInFavorOf: requireFlag(f, "rejected-in-favor-of"),
    evidence: asEvidenceArray(f),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases")
  });
  await applyPlanAndReport(plan, f);
}

// binding_debt: 定義は binding-debt.ts に一本化 (check-carving gate #9 + Constraint 拡張、
// mutate-vault の suggestions.binding_debt と同値)。既存の import 先互換のため再 export。
export { countBindingDebt };

function inspectFileInfo(p?: string) {
  if (!p) return null;
  if (!existsSync(p)) return { path: p, exists: false };
  const s = statSync(p);
  return {
    path: p,
    exists: true,
    size: s.size,
    mtime: s.mtime.toISOString(),
    type: s.isDirectory() ? "directory" : "file"
  };
}

// 新パスが在ればそれ、無ければ legacy が在れば legacy、どちらも無ければ新パス。
// inspect が「実際に読まれる場所」を正直に報告するための小道具。
function preferExisting(newPath: string, legacyPath: string): string {
  if (existsSync(newPath)) return newPath;
  if (existsSync(legacyPath)) return legacyPath;
  return newPath;
}

async function runInspect(_argv: string[]) {
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  const graphJsonPath = process.env.GRAPHRAG_GRAPH_JSON_PATH;
  // 実際の read/write が使う解決順で報告する: env 明示 > vault 隣の cache 既定
  // (legacy fallback 込み)。以前は graph_json の隣しか見ず、zero-config で常に null を
  // 返す「嘘」になっていた (retrieval.defaultVectorIndexPath と乖離)。
  const vectorIndexPath = process.env.GRAPHRAG_VECTOR_INDEX_PATH
    ?? (vaultDir ? vaultVectorIndexReadPath(vaultDir) : undefined);
  const worldDir = resolveWorldDir();

  // state dir / cache の解決 (実際の verb と同じ規約)。どこにも無ければ null を正直に返す。
  const stateDir = process.env.GRAPHRAG_STATE_DIR
    ?? (vaultDir ? stateDirForVault(vaultDir) : discoverStateDir());
  const cacheDir = stateDir ? cacheDirUnder(stateDir) : null;
  const askStatePath = cacheDir && stateDir
    ? preferExisting(path.join(cacheDir, "ask-state.json"), path.join(stateDir, "ask-state.json"))
    : undefined;
  const indexedGraphPath = cacheDir && stateDir
    ? preferExisting(path.join(cacheDir, "indexed-graph.json"), path.join(stateDir, "indexed-graph.json"))
    : undefined;

  // indexed-graph.json が vault HEAD より古いか (安価に分かる範囲で)。
  // vault の最終 commit 時刻と成果物 mtime の比較。判定不能は null で正直に返す。
  let indexedGraphInfo: any = inspectFileInfo(indexedGraphPath);
  if (indexedGraphInfo?.exists && vaultDir) {
    try {
      const headEpoch = Number(execFileSync("git", ["-C", vaultDir, "log", "-1", "--format=%ct"], {
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]
      }).trim());
      if (Number.isFinite(headEpoch)) {
        indexedGraphInfo = {
          ...indexedGraphInfo,
          stale_vs_vault_head: statSync(indexedGraphPath!).mtimeMs < headEpoch * 1000
        };
      }
    } catch { /* vault が git でない等 → 判定なし */ }
  }

  // binding_debt: if vault is readable, output the count of knowledge nodes without bindings as a single integer.
  // Absent vault / read failure is non-fatal: output null + reason honestly (never drop inspect).
  // enforcement_debt (登記層): 未ガード Constraint 数を同枠で報告 (system スキーマのみ)。
  let bindingDebt: { count: number | null; reason?: string };
  let enforcementDebtInfo: { unguarded: number | null; total?: number; reason?: string };
  if (!vaultDir) {
    bindingDebt = { count: null, reason: "GRAPHRAG_VAULT_DIR not set" };
    enforcementDebtInfo = { unguarded: null, reason: "GRAPHRAG_VAULT_DIR not set" };
  } else {
    try {
      const graph = await loadGraph(vaultDir);
      bindingDebt = { count: countBindingDebt(graph) };
      const schemaId = resolveSchema(vaultDir).id;
      if (schemaId === "system") {
        const debt = enforcementDebt(graph);
        enforcementDebtInfo = { unguarded: debt.unguarded, total: debt.total };
      } else {
        enforcementDebtInfo = { unguarded: null, reason: `schema ${schemaId} — enforcement is a system-vault concept` };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      bindingDebt = { count: null, reason };
      enforcementDebtInfo = { unguarded: null, reason };
    }
  }

  process.stdout.write(JSON.stringify({
    env: {
      GRAPHRAG_VAULT_DIR: vaultDir ?? null,
      GRAPHRAG_VAULT_MODE: process.env.GRAPHRAG_VAULT_MODE ?? null,
      GRAPHRAG_GRAPH_JSON_PATH: graphJsonPath ?? null,
      GRAPHRAG_VECTOR_INDEX_PATH: process.env.GRAPHRAG_VECTOR_INDEX_PATH ?? null,
      GRAPHRAG_EMBEDDING_ENDPOINT: process.env.GRAPHRAG_EMBEDDING_ENDPOINT ?? null,
      GRAPHRAG_VECTOR_PROVIDER: process.env.GRAPHRAG_VECTOR_PROVIDER ?? null,
      GRAPHRAG_WORLD_DIR: worldDir ?? null
    },
    // GRAPHRAG_VAULT_DIR をどの層が決めたか (shell env / walk-up .env / cwd .env /
    // auto-discovery / home fallback)。runCli を経ない直接呼び出しでは null。
    vault_dir_source: getVaultDirSource(),
    state_dir: stateDir ?? null,
    artifacts: {
      vault: inspectFileInfo(vaultDir),
      graph_json: inspectFileInfo(graphJsonPath),
      vector_index: inspectFileInfo(vectorIndexPath),
      ask_state: inspectFileInfo(askStatePath),
      indexed_graph: indexedGraphInfo,
      world: inspectFileInfo(worldDir ? path.join(worldDir, WORLD_FILE) : undefined),
      world_cache: inspectFileInfo(worldDir ? worldCachePath(worldDir) : undefined)
    },
    vault_isolation: detectVaultIsolation(),
    binding_debt: bindingDebt,
    enforcement_debt: enforcementDebtInfo
  }, null, 2) + "\n");
}

// Schema guard for project-family (project / principal) typed-add commands.
// Emits a clear error if the vault is not in the family.
function requireProjectFamilySchema(): string {
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) {
    throw new Error("project typed-add requires a vault: GRAPHRAG_VAULT_DIR env not set (required in .env)");
  }
  const schema = resolveSchema(vaultDir);
  if (schema.id !== "project" && schema.id !== "principal") {
    throw new Error(
      `This command is only for project/principal vaults (schema: ${schema.id}). ` +
      `Set schema: project (or principal) in VAULT.md.`
    );
  }
  return schema.id;
}

// Task / Milestone are time-bounded types: project preset only.
// principal (perpetual) rejects them with a routing hint — the vessel's side of 型別ルーティング.
function requireTimeboxedTypesAllowed(commandLabel: string): void {
  const schemaId = requireProjectFamilySchema();
  if (schemaId === "principal") {
    throw new Error(
      `${commandLabel}: Task/Milestone are not part of the principal preset (perpetual vault). ` +
      `Time-bounded work belongs in a project vault — route this item to the nearest child project vault; ` +
      `principal keeps only the judgment layer (Decision/Constraint/OK/Risk/Goal/Agreement...).`
    );
  }
}

async function runAddStakeholder(argv: string[]) {
  requireProjectFamilySchema();
  const f = parseFlagsArgv(argv);
  const plan = buildAddStakeholderPlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases"),
    responsibleFor: csvFlag(f, "responsible-for"),
    concernedWith: csvFlag(f, "concerned-with")
  });
  await applyPlanAndReport(plan, f);
}

async function runAddResource(argv: string[]) {
  requireProjectFamilySchema();
  const f = parseFlagsArgv(argv);
  const plan = buildAddResourcePlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases"),
    category: strFlag(f, "category") as any
  });
  await applyPlanAndReport(plan, f);
}

async function runAddMilestone(argv: string[]) {
  requireTimeboxedTypesAllowed("add-milestone");
  const f = parseFlagsArgv(argv);
  const plan = buildAddMilestonePlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases"),
    state: strFlag(f, "state"),
    dependsOn: csvFlag(f, "depends-on")
  });
  await applyPlanAndReport(plan, f);
}

async function runAddAssumption(argv: string[]) {
  requireProjectFamilySchema();
  const f = parseFlagsArgv(argv);
  const certainty = requireFlag(f, "certainty");
  const plan = buildAddAssumptionPlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases"),
    certainty: certainty as any,
    premise: csvFlag(f, "premise")
  });
  await applyPlanAndReport(plan, f);
}

async function runAddAgreement(argv: string[]) {
  requireProjectFamilySchema();
  const f = parseFlagsArgv(argv);
  const plan = buildAddAgreementPlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases"),
    state: strFlag(f, "state"),
    partyTo: csvFlag(f, "party-to"),
    documentedBy: strFlag(f, "documented-by")
  });
  await applyPlanAndReport(plan, f);
}

async function runAddTask(argv: string[]) {
  requireTimeboxedTypesAllowed("add-task");
  const f = parseFlagsArgv(argv);
  const plan = buildAddTaskPlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases"),
    evidence: asEvidenceArray(f),
    state: strFlag(f, "state"),
    achieves: csvFlag(f, "achieves"),
    requires: csvFlag(f, "requires"),
    dependsOn: csvFlag(f, "depends-on")
  });
  await applyPlanAndReport(plan, f);
}

async function runAddSource(argv: string[]) {
  requireProjectFamilySchema();
  const f = parseFlagsArgv(argv);
  const plan = buildAddSourcePlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases"),
    sourceKind: strFlag(f, "source-kind") as any
  });
  await applyPlanAndReport(plan, f);
}

async function runAddTheme(argv: string[]) {
  requireProjectFamilySchema();
  const f = parseFlagsArgv(argv);
  const plan = buildAddThemePlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases"),
    encompasses: csvFlag(f, "encompasses")
  });
  await applyPlanAndReport(plan, f);
}

/**
 * ask の各段出力からヒットしたノード id を防御的に収集する (area_map の scope)。
 * 対象: brief matches / evidence direct_evidence の本体と、その relations に載る隣接
 * ノード、および evidence graph_context の nodes 表 (id キーの表であって配列ではない —
 * evidence-packet.ts buildGraphContext の形状)。
 */
export function collectAskScopeIds(briefOut: any, evidenceOut: any): string[] {
  const ids = new Set<string>();
  const take = (entry: any) => {
    const id = entry?.node?.id;
    if (typeof id === "string") ids.add(id);
    const rels = entry?.relations;
    if (!Array.isArray(rels)) return;
    for (const rel of rels) {
      // relations は隣接ノードを node 埋め込みか裸の id のどちらかで持つ
      const rid = rel?.node?.id ?? rel?.id;
      if (typeof rid === "string") ids.add(rid);
    }
  };
  const matches = briefOut?.query?.matches;
  if (Array.isArray(matches)) for (const m of matches) take(m);
  const direct = evidenceOut?.direct_evidence;
  if (Array.isArray(direct)) for (const ev of direct) take(ev);
  const contextNodes = evidenceOut?.graph_context?.nodes;
  if (contextNodes && typeof contextNodes === "object" && !Array.isArray(contextNodes)) {
    for (const id of Object.keys(contextNodes)) ids.add(id);
  }
  return [...ids];
}

export async function dispatchHeadline(verb: string, argv: string[]): Promise<void> {
  switch (verb) {
    case "add-decision": return runAddDecision(argv);
    case "add-ok": return runAddOk(argv);
    case "add-risk": return runAddRisk(argv);
    case "add-constraint": return runAddConstraint(argv);
    case "add-goal": return runAddGoal(argv);
    case "add-investigation": return runAddInvestigation(argv);
    case "add-rejected-option": return runAddRejectedOption(argv);
    case "add-stakeholder": return runAddStakeholder(argv);
    case "add-resource": return runAddResource(argv);
    case "add-milestone": return runAddMilestone(argv);
    case "add-assumption": return runAddAssumption(argv);
    case "add-agreement": return runAddAgreement(argv);
    case "add-task": return runAddTask(argv);
    case "add-source": return runAddSource(argv);
    case "add-theme": return runAddTheme(argv);
    case "ask": return runAsk(argv);
    case "carve": return runCarve(argv);
    case "commit-mutation": return runCommitMutation(argv);
    case "inspect": return runInspect(argv);
    case "checkpoint-mark": {
      // one-shot 復元マーカー (graphrag-checkpoint skill 用)。実装は checkpoint-marker.ts。
      const mod = await import("./checkpoint-marker.ts");
      return mod.runCheckpointMark(argv);
    }
    default: throw new Error(`headline verb '${verb}' not in dispatch`);
  }
}

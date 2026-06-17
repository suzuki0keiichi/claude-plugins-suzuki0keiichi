/**
 * Headline verb dispatch.
 * cli.ts から `dispatchHeadline(verb, argv)` で呼ばれる。
 *
 * 実装範囲:
 * - parseFlagsArgv: 軽量 arg parser
 * - typed-add 5: add-decision / add-ok / add-risk / add-investigation / add-rejected-option
 * - ask: 自動段上げ (Task 8)
 * - carve: index→suggest→check 連鎖 (Task 9)
 * - commit-mutation: vault writer 経由で plan を適用 (OCC/commit/索引)
 * - inspect: env / artifacts 状態確認
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { applyMutationToVault } from "./mutate-vault.ts";
import { detectVaultIsolation } from "./cli-env.ts";
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
import { buildGraphBrief } from "./brief.ts";
import { buildEvidencePacket } from "./evidence-packet.ts";
import { bumpCallCount } from "./cli-ask-state.ts";
import { buildWorldHints, resolveWorldDir, worldCachePath, WORLD_FILE } from "./world.ts";
import { loadRequiredVectorIndex, prepareVectorSearch, loadGraph } from "./retrieval.ts";
import { embedForIndex } from "./vector.ts";
import { recordAskHits } from "./cli-ask-state.ts";
import { canonicalType } from "./schema.ts";
import { indexCodebase, resolvePreviousGraph } from "./index-codebase.ts";
import { buildAndWriteVectorIndex } from "./build-vector-index.ts";
import { main as runConcernSuggest } from "./suggest-concerns.ts";
import { main as runEdgeSuggestPolicy } from "./suggest-policy-edges.ts";
import { main as runCarvingCheck } from "./check-carving.ts";
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";

/**
 * 軽量 arg parser。
 * --flag value | --flag=value | --flag (= true) | positional (= _positional に蓄積)
 * 同じ --flag が複数回 → 配列化
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
 * --flag on|off を boolean に変換。未指定 (undefined) はそのまま undefined を返し
 * (= 既定挙動に任せる)、"off" のみ false、"on"/その他は true。
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

async function applyPlanAndReport(plan: any, f: Record<string, any>): Promise<void> {
  // v3: typed-add は vault writer 経由 (FalkorDB 非経由)。vault が単一正本。
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) {
    throw new Error("typed-add requires a vault: GRAPHRAG_VAULT_DIR env not set (.env で必須指定)");
  }

  // vault isolation check: 外部 vault でローカル mode が無い or readonly なら書き込みを拒否
  const isolation = detectVaultIsolation();
  if (isolation.mode === "readonly") {
    throw new Error(
      `Vault is in readonly mode (GRAPHRAG_VAULT_MODE=readonly). ` +
      `Writes are blocked. To allow writes, set GRAPHRAG_VAULT_MODE=direct in .graphrag/.env.`
    );
  }
  if (isolation.vault_external && isolation.mode === null) {
    const cwdEnvPath = path.join(process.cwd(), ".graphrag", ".env");
    throw new Error(
      `Vault is external (${process.env.GRAPHRAG_VAULT_DIR}) but this directory has no local GRAPHRAG_VAULT_MODE. ` +
      (isolation.mode_source === "inherited"
        ? `(A parent directory has a mode setting, but each worktree needs its own decision.) `
        : ``) +
      `Refusing to write — ask the user which mode to use, then set it in ${cwdEnvPath}:\n` +
      `  GRAPHRAG_VAULT_MODE=readonly   — read only, block all writes\n` +
      `  GRAPHRAG_VAULT_MODE=direct     — write to the shared vault as-is\n` +
      `  GRAPHRAG_VAULT_MODE=worktree   — create a vault worktree for isolated writes (run vault-worktree --name <name> first)`
    );
  }

  const dupAck = dupAckFlag(f);
  if (dupAck) plan.duplicate_ack = dupAck;
  const result = await applyMutationToVault({ plan, vaultDir, baseSha: baseShaFlag(f), reason: plan.reason });

  const output: any = { applied: true, plan_reason: plan.reason, result };
  if (isolation.vault_external) {
    output.vault_isolation = isolation;
  }
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function baseShaFlag(f: Record<string, any>): string | undefined {
  return typeof f["base-sha"] === "string" ? f["base-sha"] : undefined;
}

/**
 * --dup-ack <id[,id...]> (反復可) → 重複ゲートの承認 (plan の duplicate_ack に注入)。
 * カンマ区切りと反復指定の両方を許す。
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
 * カンマ区切り + 反復指定の両方を許して id 列を取り出す共通パーサ。
 * --aliases "a,b" や --constrains <id> --constrains <id> の両形を吸収する。
 * 未指定なら undefined (空配列ではなく) を返す (plan builder の「未指定なら載せない」と整合)。
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
  // E2 add-constraint: --constrains 必須 ≥1 (builder が空で throw)。
  // Constraint は documented_by 不可・evidence 不要 (契約) → evidence は渡さない。
  const plan = buildAddConstraintPlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
    description: strFlag(f, "description"),
    reason: strFlag(f, "reason"),
    aliases: csvFlag(f, "aliases"),
    constrains: csvFlag(f, "constrains") ?? []
  });
  await applyPlanAndReport(plan, f);
}

async function runAddGoal(argv: string[]) {
  const f = parseFlagsArgv(argv);
  // E2 add-goal: --state は任意 (既定 state なし)。指定時のみ builder が語彙検証。
  const plan = buildAddGoalPlan({
    system: requireFlag(f, "system"),
    slug: requireFlag(f, "slug"),
    title: requireFlag(f, "title"),
    summary: requireFlag(f, "summary"),
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
 * brief stage の結果から「次の段に上げるべきか」を判定する pure 関数。
 * - high confidence + 結果あり → 段上げ不要
 * - low / none / 結果ゼロ → 段上げ
 */
export function shouldEscalate(stageOutcome: { match_confidence?: string; result_count?: number }): boolean {
  const conf = stageOutcome.match_confidence ?? "none";
  const count = stageOutcome.result_count ?? 0;
  if (conf === "high" && count > 0) return false;
  return true;
}

export async function runAsk(argv: string[]) {
  const f = parseFlagsArgv(argv);
  const positional = f._positional as string[];
  const question = positional[0];
  if (!question) throw new Error('ask "<question>" requires a positional question argument');
  const limit = typeof f.limit === "string" ? Number(f.limit) : 3;
  const neighbors = typeof f.neighbors === "string" ? Number(f.neighbors) : 1;

  // R6 --gist "<想定答えの一行>" (任意): 質問と gist を別々に埋め込み両方を queryVectors で渡す
  // (semantic = 各 vector との cosine の max)。query 接頭辞は両方に付く (embedForIndex)。
  const gist = typeof f.gist === "string" && f.gist.trim() !== "" ? f.gist : undefined;
  // R5 --graph-rerank on|off (既定 off — 実 vault 実測で hub 偏重 net-negative。retrieval.ts の R5 コメント参照)。
  const graphRerank = parseOnOff(f["graph-rerank"]);

  // --call-number 自動加算 (LLM 手動付与廃止 → excessive 検出が構造的に走る)
  const stateDir = process.env.GRAPHRAG_STATE_DIR ?? path.join(process.cwd(), ".graphrag");
  const callNumber = bumpCallCount(question, stateDir);

  // v3: vault が単一正本。--vault フラグ > GRAPHRAG_VAULT_DIR env で vault を解決し、
  // 読み込み系 (brief/evidence) に明示的に渡す (env 任せにしない)。
  const vaultDir = (typeof f.vault === "string" ? f.vault : undefined) ?? process.env.GRAPHRAG_VAULT_DIR;

  // world (住所録) が構成されている時、または --gist 指定時はクエリ embedding を
  // brief と共用するため、ここで索引読み込み+embed を先に行う
  // (失敗時は従来経路に任せる: brief 側が同じ理由で大声で落ちる)。
  // --gist 指定時は質問と gist の 2 ベクトルを R6 queryVectors として brief へ渡す。
  const worldDir = resolveWorldDir(typeof f.world === "string" ? f.world : undefined);
  let sharedVectorIndex: any = null;
  let sharedQueryVector: number[] | null = null;
  let sharedQueryVectors: number[][] | null = null;
  if ((worldDir || gist) && vaultDir) {
    try {
      sharedVectorIndex = await loadRequiredVectorIndex(vaultDir);
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
  }

  const stages: any[] = [];
  let finalStage: "brief" | "search" | "evidence" = "brief";

  // Stage 1: brief (query mode)
  const briefOut: any = await buildGraphBrief({
    mode: "query",
    query: question,
    graph: vaultDir,
    limit,
    callNumber,
    vectorIndex: sharedVectorIndex ?? undefined,
    queryVector: sharedQueryVector ?? undefined,
    queryVectors: sharedQueryVectors ?? undefined,
    graphRerank
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
    if (topIds.length > 0) recordAskHits(question, topIds, stateDir);
  } catch {
    // ask-trail 記録は非致命。失敗しても brief 出力はそのまま返す。
  }

  const briefOutcome = {
    match_confidence: briefOut?.query?.match_confidence,
    result_count: (briefOut?.query?.matches ?? []).length
  };

  if (shouldEscalate(briefOutcome)) {
    // Stage 2: evidence (内部で search も走る = retrieval ladder の "search" と
    // "evidence" は機能的に近い)。evidence packet は direct_evidence (=ranked search
    // matches) と graph_context (=neighbors expansion) の両方を返す。
    // ※ "search" primitive を別段として呼ぶ意味は ladder 上限の段階表示のみ。
    // evidence packet で direct_evidence が空なら本当に無いと言える。
    finalStage = "search";
    const evidenceOut: any = await buildEvidencePacket({
      request: question,
      vault: vaultDir,
      limit: 8,
      neighbors,
      types: []
    });
    stages.push({ stage: "evidence", output: evidenceOut });
    if ((evidenceOut?.direct_evidence ?? []).length === 0) {
      finalStage = "evidence"; // ここまで空なら "evidence まで掘ったが空" の最終段
    } else {
      finalStage = "evidence";
    }
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

  process.stdout.write(JSON.stringify({
    question,
    call_number: callNumber,
    final_stage: finalStage,
    next_action_hint: shouldEscalate(briefOutcome)
      ? "別キーワードを 1 度試す → それでも空ならコード/doc 直読みに切り替える (excessive 検出は launcher が --call-number を構造的に加算しているので過信せず)"
      : "brief 結果で十分。LLM はここから判断を進めてよい",
    ...(worldHints !== undefined ? { world_hints: worldHints } : {}),
    stages
  }, null, 2) + "\n");
}

async function runCommitMutation(argv: string[]) {
  const f = parseFlagsArgv(argv);
  const planPath = (f._positional as string[])[0];
  if (!planPath) throw new Error("commit-mutation <plan.json> requires plan path");

  // v3: vault writer 経由で適用 (FalkorDB-export / vault-build / carving-check は撤廃)。
  // lock → OCC → import → normalize/validate → writeVaultDelta → 索引(非致命) → git commit
  // を applyMutationToVault がまとめて行う。
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) throw new Error("commit-mutation: GRAPHRAG_VAULT_DIR env not set (.env で必須指定)");

  const plan = await loadMutationPlan(planPath);
  const baseSha = typeof f["base-sha"] === "string" ? f["base-sha"] : undefined;
  const result = await applyMutationToVault({ plan, vaultDir, baseSha, reason: plan.reason });

  process.stdout.write(JSON.stringify({
    plan_path: planPath,
    plan_reason: plan.reason,
    summary: {
      applied: result.applied,
      changed_nodes: result.changed_nodes,
      cascaded_edge_ids: result.cascaded_edge_ids,
      head: result.head,
      duplicate_check: result.duplicate_check,
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
  const stateDir = process.env.GRAPHRAG_STATE_DIR ?? path.join(process.cwd(), ".graphrag");

  process.stderr.write(`[carve] stage 1/3: index (root=${root}, system=${system})\n`);
  // index 単独 verb と同じ vault-trust 経路を通す。前回の本物 File summary は正本 vault
  // からのみ継ぎ、scaffold(--previous)は change_status 専用にする。これを通さないと
  // carve のたびに全 File summary が provisional に戻り、再 author 済み要約を握り潰す。
  const { previous: previousGraph, trustSummaries } = resolvePreviousGraph({ root, previous, vault, systemName: system });
  const indexed: any = indexCodebase({ root, systemName: system, previous: previousGraph, trustPreviousSummaries: trustSummaries });
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const indexOutPath = path.join(stateDir, "indexed-graph.json");
  writeFileSync(indexOutPath, JSON.stringify(indexed, null, 2));
  process.stderr.write(`[carve]   → wrote ${indexOutPath} (${indexed.nodes?.length ?? 0} nodes, ${indexed.edges?.length ?? 0} edges)\n`);

  const vectorIndexPath = process.env.GRAPHRAG_VECTOR_INDEX_PATH ?? path.join(stateDir, "vector-index.json");

  // vector index 不在なら index 段の成果から自動構築して suggest 系へ進む
  // (初回でも「carve → vector-index → もう一度 carve」の手動往復を不要にする)。
  // embedding endpoint 不達は従来どおり非致命: suggest 系を skip し注記を出す。
  let vectorIndexReady = existsSync(vectorIndexPath);
  let vectorIndexSkipNote: string | null = null;
  if (!vectorIndexReady) {
    process.stderr.write(`[carve] vector index not found at ${vectorIndexPath} → 自動構築を試みる\n`);
    try {
      await buildAndWriteVectorIndex({ out: vectorIndexPath }, { graphObject: indexed });
      vectorIndexReady = true;
      process.stderr.write(`[carve]   → built ${vectorIndexPath}\n`);
    } catch (error) {
      vectorIndexSkipNote = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[carve]   → 自動構築 FAILED (embedding endpoint 不達 等): ${vectorIndexSkipNote}\n`);
    }
  }

  if (vectorIndexReady) {
    process.stderr.write(`[carve] stage 2/3: concern-suggest + edge-suggest-policy (vector index: ${vectorIndexPath})\n`);
    process.stderr.write(`--- concern-suggest output ---\n`);
    runConcernSuggest(["--graph", indexOutPath, "--vector-index", vectorIndexPath]);
    process.stderr.write(`--- edge-suggest-policy output ---\n`);
    runEdgeSuggestPolicy(["--graph", indexOutPath, "--vector-index", vectorIndexPath, "--missing-only"]);
  } else {
    process.stderr.write(`[carve] stage 2/3: SKIPPED (vector index unavailable: ${vectorIndexSkipNote ?? "not found"}). `);
    process.stderr.write(`embedding endpoint を立ててから carve を再実行すると concern + policy edge suggestions まで通る。\n`);
  }

  process.stderr.write(`[carve] stage 3/3: carving-check\n`);
  process.stderr.write(`--- carving-check output ---\n`);
  const checkArgs = ["--graph", indexOutPath];
  if (vectorIndexReady) checkArgs.push("--vector-index", vectorIndexPath);
  runCarvingCheck(checkArgs);

  process.stderr.write(`\n[carve] done. next:\n`);
  process.stderr.write(`  1. concern + policy edge 候補を見て mutation plan を組み立てる (LLM)\n`);
  process.stderr.write(`  2. node graphrag/cli.ts commit-mutation <plan.json> で vault に適用 (OCC/validate/索引/git commit)\n`);
  process.stderr.write(`  3. 必要なら carve を再実行して carving-check の error をゼロにしてから完了とする\n`);
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

// binding_debt: bind 無し knowledge ノード総数。定義は mutate-vault.ts の countBindingDebt
// および check-carving gate #9 (knowledge-impl-binding-missing) + 拡張
// (constraint-binding-missing) と一致させる。Decision/OK/Risk は実装ファイルへの
// sets_policy_for / documented_by が無ければ debt、Constraint は constrains が 0 本なら debt。
function isImplFileBinding(toId: string): boolean {
  return toId.startsWith("file:") && !/docs\/knowhow\/|plans\/|docs\/design-decisions\//.test(toId);
}
export function countBindingDebt(graph: { nodes?: any[]; edges?: any[] }): number {
  const outEdges = new Map<string, any[]>();
  for (const e of graph.edges ?? []) {
    const arr = outEdges.get(e.from) ?? [];
    arr.push(e);
    outEdges.set(e.from, arr);
  }
  let debt = 0;
  for (const n of graph.nodes ?? []) {
    const t = canonicalType(n.type);
    const oe = outEdges.get(n.id) ?? [];
    if (t === "Decision" || t === "OperationalKnowledge" || t === "Risk") {
      const hasPolicy = oe.some((e) => e.type === "sets_policy_for" && isImplFileBinding(e.to));
      const hasImplDoc = oe.some((e) => e.type === "documented_by" && isImplFileBinding(e.to));
      if (!hasPolicy && !hasImplDoc) debt += 1;
    } else if (t === "Constraint") {
      if (!oe.some((e) => e.type === "constrains")) debt += 1;
    }
  }
  return debt;
}

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

async function runInspect(_argv: string[]) {
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  const graphJsonPath = process.env.GRAPHRAG_GRAPH_JSON_PATH;
  const vectorIndexPath = process.env.GRAPHRAG_VECTOR_INDEX_PATH
    ?? (graphJsonPath ? path.join(path.dirname(graphJsonPath), "vector-index.json") : undefined);
  const worldDir = resolveWorldDir();

  // binding_debt: vault が読めれば bind 無し knowledge ノード数を 1 整数で出す。
  // vault 不在 / 読み込み失敗は非致命: null + reason で正直に出す (inspect を落とさない)。
  let bindingDebt: { count: number | null; reason?: string };
  if (!vaultDir) {
    bindingDebt = { count: null, reason: "GRAPHRAG_VAULT_DIR 未設定" };
  } else {
    try {
      const graph = await loadGraph(vaultDir);
      bindingDebt = { count: countBindingDebt(graph) };
    } catch (error) {
      bindingDebt = { count: null, reason: error instanceof Error ? error.message : String(error) };
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
    artifacts: {
      vault: inspectFileInfo(vaultDir),
      graph_json: inspectFileInfo(graphJsonPath),
      vector_index: inspectFileInfo(vectorIndexPath),
      world: inspectFileInfo(worldDir ? path.join(worldDir, WORLD_FILE) : undefined),
      world_cache: inspectFileInfo(worldDir ? worldCachePath(worldDir) : undefined)
    },
    vault_isolation: detectVaultIsolation(),
    binding_debt: bindingDebt
  }, null, 2) + "\n");
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
    case "ask": return runAsk(argv);
    case "carve": return runCarve(argv);
    case "commit-mutation": return runCommitMutation(argv);
    case "inspect": return runInspect(argv);
    default: throw new Error(`headline verb '${verb}' not in dispatch`);
  }
}

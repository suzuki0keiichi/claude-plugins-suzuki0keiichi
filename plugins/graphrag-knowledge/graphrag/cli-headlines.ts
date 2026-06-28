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
import { applyMutationToVault } from "./mutate-vault.ts";
import { detectVaultIsolation, stateDirForVault, stateDirUnder, discoverStateDir } from "./cli-env.ts";
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
import { bumpCallCount } from "./cli-ask-state.ts";
import { buildWorldHints, resolveWorldDir, worldCachePath, WORLD_FILE } from "./world.ts";
import { augmentMatchesWithXRefResolutions } from "./xref-resolver.ts";
import { loadRequiredVectorIndex, prepareVectorSearch, loadGraph } from "./retrieval.ts";
import { embedForIndex } from "./vector.ts";
import { recordAskHits } from "./cli-ask-state.ts";
import { canonicalType, type SchemaDefinition } from "./schema.ts";
import { resolveSchema } from "./schema-registry.ts";
import { indexCodebase, resolvePreviousGraph } from "./index-codebase.ts";
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

async function applyPlanAndReport(plan: any, f: Record<string, any>): Promise<void> {
  // v3: typed-add goes through vault writer (not FalkorDB). Vault is the single source of truth.
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

  const schema = resolveSchema(vaultDir);
  const dupAck = dupAckFlag(f);
  if (dupAck) plan.duplicate_ack = dupAck;
  const result = await applyMutationToVault({ plan, vaultDir, schema, baseSha: baseShaFlag(f), reason: plan.reason });

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

  // v3: vault is the single source of truth. Resolve vault via --vault flag > GRAPHRAG_VAULT_DIR env,
  // and pass explicitly to read operations (brief/evidence) rather than relying on env.
  const vaultDir = (typeof f.vault === "string" ? f.vault : undefined) ?? process.env.GRAPHRAG_VAULT_DIR;

  // --call-number auto-incremented (manual LLM assignment removed → excessive detection runs structurally)
  // call-count は vault を保持する .graphrag に集約する。vault が解決できないときだけ
  // cwd から walk-up して既存 .graphrag を辿る (vault 内実行でも .graphrag/vault/.graphrag を掘らない)。
  const stateDir = process.env.GRAPHRAG_STATE_DIR
    ?? (vaultDir ? stateDirForVault(vaultDir) : discoverStateDir());
  const callNumber = bumpCallCount(question, stateDir);

  // When world (directory) is configured or --gist is specified, load and embed query
  // ahead of time to share with brief
  // (on failure, fall back to the normal path: brief will fail loudly for the same reason).
  // When --gist is specified, pass both question and gist as 2 R6 queryVectors to brief.
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

  process.stdout.write(JSON.stringify({
    question,
    call_number: callNumber,
    final_stage: finalStage,
    next_action_hint: shouldEscalate(briefOutcome)
      ? "別キーワードを 1 度試す → それでも空ならコード/doc 直読みに切り替える (excessive 検出は launcher が --call-number を構造的に加算しているので過信せず)"
      : "brief 結果で十分。LLM はここから判断を進めてよい",
    ...(askSchema?.llmReference ? { schema_summary: { id: askSchema.id, reference: askSchema.llmReference } } : {}),
    ...(worldHints !== undefined ? { world_hints: worldHints } : {}),
    stages
  }, null, 2) + "\n");
}

async function runCommitMutation(argv: string[]) {
  const f = parseFlagsArgv(argv);
  const planPath = (f._positional as string[])[0];
  if (!planPath) throw new Error("commit-mutation <plan.json> requires plan path");

  // v3: applied via vault writer (FalkorDB-export / vault-build / carving-check are retired).
  // lock → OCC → import → normalize/validate → writeVaultDelta → index(non-fatal) → git commit
  // are all handled by applyMutationToVault.
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) throw new Error("commit-mutation: GRAPHRAG_VAULT_DIR env not set (.env で必須指定)");

  const schema = resolveSchema(vaultDir);
  const plan = await loadMutationPlan(planPath);
  const baseSha = typeof f["base-sha"] === "string" ? f["base-sha"] : undefined;
  const result = await applyMutationToVault({ plan, vaultDir, schema, baseSha, reason: plan.reason });

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
  // carve の成果物 (indexed-graph.json 等) は索引対象 root の .graphrag に置く規約
  // (<root>/.graphrag/indexed-graph.json)。cwd 依存だとサブディレクトリ実行で散らばる。
  const stateDir = process.env.GRAPHRAG_STATE_DIR ?? stateDirUnder(root);

  process.stderr.write(`[carve] stage 1/3: index (root=${root}, system=${system})\n`);
  // Use the same vault-trust path as the standalone index verb. Previous genuine File summaries come from the canonical vault
  // only; scaffold (--previous) is for change_status only. Without this,
  // every carve would reset all File summaries to provisional, overwriting re-authored summaries.
  const { previous: previousGraph, trustSummaries } = resolvePreviousGraph({ root, previous, vault, systemName: system });
  const indexed: any = indexCodebase({ root, systemName: system, previous: previousGraph, trustPreviousSummaries: trustSummaries });
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const indexOutPath = path.join(stateDir, "indexed-graph.json");
  writeFileSync(indexOutPath, JSON.stringify(indexed, null, 2));
  process.stderr.write(`[carve]   → wrote ${indexOutPath} (${indexed.nodes?.length ?? 0} nodes, ${indexed.edges?.length ?? 0} edges)\n`);

  const vectorIndexPath = process.env.GRAPHRAG_VECTOR_INDEX_PATH ?? path.join(stateDir, "vector-index.json");

  // If no vector index, auto-build from index output and proceed to suggest steps
  // (avoids the manual round-trip of "carve → vector-index → carve again" even on first run).
  // Unreachable embedding endpoint remains non-fatal: skip suggest steps and note it.
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
    process.stderr.write(`[carve] stage 2/3: concern-hint + edge-suggest-policy (vector index: ${vectorIndexPath})\n`);
    process.stderr.write(`--- concern-hint output ---\n`);
    runConcernHint(["--graph", indexOutPath, "--vector-index", vectorIndexPath]);
    process.stderr.write(`--- edge-suggest-policy output ---\n`);
    runEdgeSuggestPolicy(["--graph", indexOutPath, "--vector-index", vectorIndexPath, "--missing-only"]);
  } else {
    process.stderr.write(`[carve] stage 2/3: SKIPPED (vector index unavailable: ${vectorIndexSkipNote ?? "not found"}). `);
    process.stderr.write(`embedding endpoint を立ててから carve を再実行すると concern-hint + policy edge suggestions まで通る。\n`);
  }

  process.stderr.write(`[carve] stage 3/3: carving-check\n`);
  process.stderr.write(`--- carving-check output ---\n`);
  const checkArgs = ["--graph", indexOutPath];
  if (vectorIndexReady) checkArgs.push("--vector-index", vectorIndexPath);
  runCarvingCheck(checkArgs);

  process.stderr.write(`\n[carve] done. next:\n`);
  process.stderr.write(`  1. concern-hint + policy edge 候補を見て mutation plan を組み立てる (LLM)\n`);
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

// binding_debt: total count of knowledge nodes without bindings. Definition matches countBindingDebt in mutate-vault.ts
// and check-carving gate #9 (knowledge-impl-binding-missing) + extension
// (constraint-binding-missing). Decision/OK/Risk must have
// sets_policy_for / documented_by to impl files, or it's debt. Constraint is debt if 0 constrains edges.
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

  // binding_debt: if vault is readable, output the count of knowledge nodes without bindings as a single integer.
  // Absent vault / read failure is non-fatal: output null + reason honestly (never drop inspect).
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

// Schema guard for project vault-only commands.
// Emits a clear error if the vault is not the project preset.
function requireProjectSchema(): void {
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) {
    throw new Error("project typed-add requires a vault: GRAPHRAG_VAULT_DIR env not set (required in .env)");
  }
  const schema = resolveSchema(vaultDir);
  if (schema.id !== "project") {
    throw new Error(
      `This command is only for project vaults (schema: ${schema.id}). ` +
      `Set schema: project in VAULT.md.`
    );
  }
}

async function runAddStakeholder(argv: string[]) {
  requireProjectSchema();
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
  requireProjectSchema();
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
  requireProjectSchema();
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
  requireProjectSchema();
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
  requireProjectSchema();
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
  requireProjectSchema();
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
  requireProjectSchema();
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
  requireProjectSchema();
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
    default: throw new Error(`headline verb '${verb}' not in dispatch`);
  }
}

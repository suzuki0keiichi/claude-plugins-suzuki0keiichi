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
import { bumpCallCount, resolveAskStateDir } from "./cli-ask-state.ts";
import { buildWorldHints, resolveWorldDir, worldCachePath, WORLD_FILE } from "./world.ts";
import { augmentMatchesWithXRefResolutions } from "./xref-resolver.ts";
import { loadRequiredVectorIndex, prepareVectorSearch, loadGraph, vaultVectorIndexReadPath } from "./retrieval.ts";
import { embedForIndex } from "./vector.ts";
import { recordAskHits } from "./cli-ask-state.ts";
import { countBindingDebt } from "./binding-debt.ts";
import { importVault } from "./import-vault.ts";
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

/**
 * E8: typed-add --evidence が指す File ノードが vault に無いときの摩擦解消。
 * 参照 path が repo 上に実在する場合に限り、最小の File ノード
 * {op:create, id, type:"File", path, title} を plan に自動追加する (typo ガード:
 * ディスクに無い path は「そう」と明示して失敗させる)。対象は plan の documented_by
 * エッジ (typed-add の evidence 経路) の宛先 `file:` id のみ。
 * 戻り値 = 自動追加した File (verb 出力・stderr で可視化する)。
 */
export function ensureEvidenceFileNodes(
  plan: any,
  vaultDir: string,
  deps: { loadGraph?: () => any; repoRoot?: string } = {}
): { id: string; path: string }[] {
  const fileTargetIds: string[] = (plan.edges ?? [])
    .filter(
      (e: any) =>
        (e.op ?? "create") === "create" &&
        e.type === "documented_by" &&
        typeof e.to === "string" &&
        e.to.startsWith("file:")
    )
    .map((e: any) => e.to);
  if (fileTargetIds.length === 0) return [];
  const planNodeIds = new Set((plan.nodes ?? []).map((n: any) => n.id));
  const candidates = [...new Set(fileTargetIds)].filter((id) => !planNodeIds.has(id));
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
        `--evidence ${id}: File node does not exist in the vault, and path "${relPath}" does not exist on disk ` +
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

async function applyPlanAndReport(plan: any, f: Record<string, any>): Promise<void> {
  // v3: typed-add goes through vault writer (not FalkorDB). Vault is the single source of truth.
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) {
    throw new Error("typed-add requires a vault: GRAPHRAG_VAULT_DIR env not set (.env で必須指定)");
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
  let sharedVectorIndex: any = null;
  let sharedQueryVector: number[] | null = null;
  let sharedQueryVectors: number[][] | null = null;
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
      vectorIndex: sharedVectorIndex ?? undefined,
      queryVectors: sharedQueryVectors ?? (sharedQueryVector ? [sharedQueryVector] : undefined)
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

  process.stdout.write(JSON.stringify({
    question,
    call_number: callNumber,
    final_stage: finalStage,
    next_action_hint: shouldEscalate(lastOutcome)
      ? "別キーワードを 1 度試す → それでも空ならコード/doc 直読みに切り替える (excessive 検出は launcher が --call-number を構造的に加算しているので過信せず)"
      : `${finalStage} 結果で十分。LLM はここから判断を進めてよい`,
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

  // typed-add と同じ単一ゲート: readonly / 外部 vault のローカル mode 未設定は書かせない。
  assertVaultWriteAllowed({ vaultDir });
  const vaultResolution = reportVaultResolution(vaultDir);

  const schema = resolveSchema(vaultDir);
  const plan = await loadMutationPlan(planPath);
  const baseSha = typeof f["base-sha"] === "string" ? f["base-sha"] : undefined;
  const result = await applyMutationToVault({ plan, vaultDir, schema, baseSha, reason: plan.reason });

  process.stdout.write(JSON.stringify({
    plan_path: planPath,
    plan_reason: plan.reason,
    ...vaultResolution,
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
    process.stderr.write(`[carve] vector index not found at ${vectorIndexPath} → 自動構築を試みる\n`);
    try {
      await buildAndWriteVectorIndex({ out: vectorIndexWritePath }, { graphObject: indexed });
      vectorIndexPath = vectorIndexWritePath;
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

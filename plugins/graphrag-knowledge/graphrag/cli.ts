#!/usr/bin/env -S node --experimental-strip-types
import { discoverAndLoadGraphragEnv, loadDotEnvFromCwd, discoverVaultDir } from "./cli-env.ts";
import { pathToFileURL } from "node:url";

const PRIMITIVE_VERBS = [
  "brief", "search", "evidence", "index", "vector-index",
  "vault-build", "vault-import",
  "concern-suggest", "edge-suggest-policy", "carving-check",
  "branch-merge", "world-refresh",
  "carving-allow", "harvest-history", "staleness-check"
] as const;

const HEADLINE_VERBS = [
  "ask", "carve", "commit-mutation",
  "add-decision", "add-ok", "add-risk", "add-constraint", "add-goal",
  "add-investigation", "add-rejected-option",
  "inspect"
] as const;

type PrimitiveVerb = typeof PRIMITIVE_VERBS[number];
type HeadlineVerb = typeof HEADLINE_VERBS[number];

export function isPrimitiveVerb(v: string): v is PrimitiveVerb {
  return (PRIMITIVE_VERBS as readonly string[]).includes(v);
}

export function isHeadlineVerb(v: string): v is HeadlineVerb {
  return (HEADLINE_VERBS as readonly string[]).includes(v);
}

export function listKnownVerbs(): string[] {
  return [...PRIMITIVE_VERBS, ...HEADLINE_VERBS];
}

/**
 * primitive verb → 対応 .ts ファイル (graphrag/ 配下) のマッピング。
 * 各 .ts は `export async function main(argv: string[])` または同等の同期版を露出している
 * (export 名が main でない verb は exportName で指定する)。
 */
const PRIMITIVE_FILE_MAP: Record<PrimitiveVerb, { file: string; exportName?: string }> = {
  "brief": { file: "./brief.ts" },
  "search": { file: "./search.ts" },
  "evidence": { file: "./evidence-packet.ts" },
  "index": { file: "./index-codebase.ts" },
  "vector-index": { file: "./build-vector-index.ts" },
  "vault-build": { file: "./build-vault.ts" },
  "vault-import": { file: "./import-vault.ts" },
  "concern-suggest": { file: "./suggest-concerns.ts" },
  "edge-suggest-policy": { file: "./suggest-policy-edges.ts" },
  "carving-check": { file: "./check-carving.ts" },
  "branch-merge": { file: "./branch-merge.ts" },
  "world-refresh": { file: "./world.ts" },
  "carving-allow": { file: "./cli-carving-allow.ts", exportName: "runCarvingAllow" },
  "harvest-history": { file: "./harvest-history.ts", exportName: "runHarvestHistory" },
  "staleness-check": { file: "./staleness-check.ts", exportName: "runStalenessCheck" }
};

async function dispatchPrimitive(verb: PrimitiveVerb, argv: string[]) {
  const { file, exportName } = PRIMITIVE_FILE_MAP[verb];
  const mod = await import(file);
  const entry = mod[exportName ?? "main"];
  if (typeof entry !== "function") {
    throw new Error(`primitive ${verb} (${file}) does not export ${exportName ?? "main"}(argv).`);
  }
  await entry(argv);
}

async function dispatchHeadline(verb: HeadlineVerb, argv: string[]) {
  const mod = await import("./cli-headlines.ts");
  await mod.dispatchHeadline(verb, argv);
}

export async function runCli(argv: string[]) {
  // 共通 init: env を 1 度読む (verb 個別の env 上書きは CLI flag のみ)。
  // 優先順位: shell env > .graphrag/.env (walk-up) > cwd .env > .graphrag/vault auto-discovery。
  // .graphrag/.env は worktree・サブディレクトリからでも親を拾えるよう walk-up する。
  discoverAndLoadGraphragEnv();
  loadDotEnvFromCwd();
  // GRAPHRAG_VAULT_DIR がまだ未設定なら、cwd 上方向の `.graphrag/vault` を発見して焼く。
  discoverVaultDir();

  const [verb, ...rest] = argv;
  if (!verb || verb === "--help" || verb === "-h" || verb === "help") {
    printHelp();
    process.exit(verb ? 0 : 2);
  }
  if (isPrimitiveVerb(verb)) {
    await dispatchPrimitive(verb, rest);
    return;
  }
  if (isHeadlineVerb(verb)) {
    await dispatchHeadline(verb, rest);
    return;
  }
  process.stderr.write(`unknown verb: ${verb}\n`);
  printHelp();
  process.exit(2);
}

function printHelp() {
  process.stderr.write(`usage: node graphrag/cli.ts <verb> [args]

headline verbs (連鎖、1 コマンドで複数段):
  ${HEADLINE_VERBS.join(" / ")}

primitive verbs (段別、細粒度制御):
  ${PRIMITIVE_VERBS.join(" / ")}

詳細は SKILL.md / references/cli-primitives.md を参照。
`);
}

function isMainModule(url: string) {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
if (isMainModule(import.meta.url)) {
  await runCli(process.argv.slice(2));
}

#!/usr/bin/env -S node --experimental-strip-types
import {
  discoverAndLoadGraphragEnv, loadDotEnvFromCwd, discoverVaultDir, loadHomeGraphragEnv,
  bindClosestVaultDir, noteVaultDirSource, parseVaultFlag, bindCliVaultDir, normalizeVaultArgv
} from "./cli-env.ts";
import { pathToFileURL } from "node:url";

const PRIMITIVE_VERBS = [
  "brief", "search", "evidence", "grep", "show", "index", "vector-index",
  "vault-build", "vault-import",
  "concern-hint", "edge-suggest-policy", "carving-check",
  "branch-merge", "world-refresh", "world-join",
  "carving-allow", "harvest-history", "staleness-check",
  "xref-check", "fsck", "stocktake", "constraint-check", "frame-check", "delta-check",
  "rail-prompt", "rail-touch", "rail-read", "embedder-setup"
] as const;

const HEADLINE_VERBS = [
  "ask", "carve", "commit-mutation",
  "add-decision", "add-ok", "add-risk", "add-constraint", "add-goal",
  "add-investigation", "add-rejected-option",
  "add-stakeholder", "add-resource", "add-milestone", "add-assumption",
  "add-agreement", "add-task", "add-source", "add-theme",
  "inspect", "checkpoint-mark"
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
  "grep": { file: "./node-grep.ts", exportName: "runNodeGrep" },
  "show": { file: "./node-grep.ts", exportName: "runNodeShow" },
  "index": { file: "./index-codebase.ts" },
  "vector-index": { file: "./build-vector-index.ts" },
  "vault-build": { file: "./build-vault.ts" },
  "vault-import": { file: "./import-vault.ts" },
  "concern-hint": { file: "./suggest-concern-hints.ts" },
  "edge-suggest-policy": { file: "./suggest-policy-edges.ts" },
  "carving-check": { file: "./check-carving.ts" },
  "branch-merge": { file: "./branch-merge.ts" },
  "world-refresh": { file: "./world.ts" },
  "world-join": { file: "./world-join.ts" },
  "carving-allow": { file: "./cli-carving-allow.ts", exportName: "runCarvingAllow" },
  "harvest-history": { file: "./harvest-history.ts", exportName: "runHarvestHistory" },
  "staleness-check": { file: "./staleness-check.ts", exportName: "runStalenessCheck" },
  "xref-check": { file: "./xref-check.ts", exportName: "runXRefCheck" },
  "fsck": { file: "./fsck.ts", exportName: "runFsck" },
  "stocktake": { file: "./stocktake.ts", exportName: "runStocktake" },
  "constraint-check": { file: "./constraint-check.ts", exportName: "runConstraintCheck" },
  "frame-check": { file: "./frame-check.ts", exportName: "runFrameCheck" },
  "delta-check": { file: "./delta-check.ts", exportName: "runDeltaCheck" },
  "rail-prompt": { file: "./rail-prompt.ts", exportName: "runRailPrompt" },
  "rail-touch": { file: "./rail-touch.ts", exportName: "runRailTouch" },
  "rail-read": { file: "./rail-read.ts", exportName: "runRailRead" },
  "embedder-setup": { file: "./embedder-setup.ts", exportName: "runEmbedderSetup" }
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

// vault (や world) を位置引数で受け、--vault を知らない verb。flag を残すと値が位置引数に
// 化けるので除き、GRAPHRAG_VAULT_DIR 経由で渡す。
const POSITIONAL_VAULT_VERBS = new Set(["vault-import", "vault-build", "world-refresh"]);

export async function runCli(argv: string[]) {
  // `--vault` は verb を問わず dispatch 前にここで一度だけ解決し、最優先で焼く
  // (verb ごとの読み漏れで既定 vault へ黙って書く事故 = issue #44 を構造的に塞ぐ)。
  // verb へは正規化した `--vault <abs>` だけを渡し、verb 側の再解析と解釈を一致させる。
  const vaultFlag = parseVaultFlag(argv.slice(1));
  if (vaultFlag.error) {
    process.stderr.write(`${vaultFlag.error}\n`);
    process.exit(2);
  }
  const restoreVault = vaultFlag.vaultDir ? bindCliVaultDir(vaultFlag.vaultDir) : null;
  if (vaultFlag.vaultDir) {
    const [verb, ...rest] = argv;
    argv = [verb, ...normalizeVaultArgv(rest, vaultFlag.vaultDir, POSITIONAL_VAULT_VERBS.has(verb))];
  }
  try {
    await runCliWithEnv(argv);
  } finally {
    restoreVault?.();
  }
}

async function runCliWithEnv(argv: string[]) {
  // 共通 init: env を 1 度読む (verb 個別の env 上書きは CLI flag のみ)。
  // 優先順位 (high→low): --vault > shell env > .graphrag/.env (walk-up) > cwd .env
  //   > .graphrag/vault auto-discovery > ~/.graphrag/.env (環境ごとのグローバル fallback)。
  // applyDotEnv は first-wins なので、ローカル→グローバルの順で読むとローカルが勝つ。
  // .graphrag/.env は worktree・サブディレクトリからでも親を拾えるよう walk-up する。
  // 各段の直後に noteVaultDirSource で「どの層が GRAPHRAG_VAULT_DIR を決めたか」を記録する
  // (書き込み verb が毎回 `[graphrag] vault: <path> (source: <layer>)` を可視化するため)。
  noteVaultDirSource("shell-env");
  discoverAndLoadGraphragEnv();
  noteVaultDirSource("graphrag-env");
  // E2 closest-wins: 最も近い `.graphrag` root が vault/ を持ち .env が GRAPHRAG_VAULT_DIR を
  // 書いていないなら、cwd `.env` の stale な値に負ける前にその vault を確定する。
  bindClosestVaultDir();
  noteVaultDirSource("auto-discovered");
  loadDotEnvFromCwd();
  noteVaultDirSource("cwd-env");
  // GRAPHRAG_VAULT_DIR がまだ未設定なら、cwd 上方向の `.graphrag/vault` を発見して焼く。
  discoverVaultDir();
  noteVaultDirSource("auto-discovered");
  // 最後に ~/.graphrag/.env を読む。embedding API サーバ位置など、vault ごとではなく
  // 環境ごとに決まる値を 1 箇所に集約するためのグローバル fallback (最下位優先度)。
  loadHomeGraphragEnv();
  noteVaultDirSource("home-env");

  const [verb, ...rest] = argv;
  if (!verb || verb === "--help" || verb === "-h" || verb === "help") {
    printHelp();
    process.exit(verb ? 0 : 2);
  }
  const VERB_ALIASES: Record<string, string> = { "vein-hint": "concern-hint" };
  const resolved = VERB_ALIASES[verb] ?? verb;
  if (isPrimitiveVerb(resolved)) {
    await dispatchPrimitive(resolved, rest);
    return;
  }
  if (isHeadlineVerb(resolved)) {
    await dispatchHeadline(resolved, rest);
    return;
  }
  process.stderr.write(`unknown verb: ${verb}\n`);
  printHelp();
  process.exit(2);
}

function printHelp() {
  process.stderr.write(`usage: graphrag <verb> [args]

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

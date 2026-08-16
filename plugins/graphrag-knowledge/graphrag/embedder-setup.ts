// embedder-setup verb: 同梱デフォルト embedding の 1 マシン 1 回セットアップ。
// graphrag:see decision:graphrag-skill-dev:npm-default-embedding-e5-small
//
// これが「インストールが走る唯一のタイミング」。読み経路 (ask/carve) は決して
// 自動インストールに落ちず、embeddingUnavailableError がこの verb への導線を出すだけ。
// やることを全部この場に前倒しする: 依存導入 (pnpm 限定・frozen-lockfile・スクリプト
// 遮断は同梱 pnpm-workspace.yaml の allowBuilds 全 false で宣言済み) → モデルの
// プリフェッチ → warmup 埋め込み → 日英 sanity。成功 = 以後オフラインで即動く。
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { LOCAL_EMBEDDING_MODEL, embedderHomeDir, embedLocalText, localEmbedderStatus } from "./embedder-local.ts";

const BUNDLE_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

function bundleDir(): string {
  return fileURLToPath(new URL("../embedder/", import.meta.url));
}

// pnpm 限定 (サプライチェーン方針)。見つからなくても他のパッケージマネージャには
// 決して落ちない。Windows は pnpm.cmd 解決のため shell 経由で起動する。
function assertPnpmAvailable(): string {
  const probe = spawnSync("pnpm", ["--version"], {
    shell: process.platform === "win32",
    encoding: "utf8"
  });
  const version = probe.status === 0 ? String(probe.stdout).trim() : null;
  if (!version) {
    throw new Error(
      [
        "pnpm not found. embedder-setup installs dependencies with pnpm ONLY (never any other package manager).",
        "Install pnpm first:",
        "  - corepack enable && corepack prepare pnpm@latest --activate  (bundled with Node)",
        "  - or the standalone installer: https://pnpm.io/installation"
      ].join("\n")
    );
  }
  const major = Number(version.split(".")[0]);
  if (Number.isFinite(major) && major < 10) {
    throw new Error(
      `pnpm ${version} is too old: v10+ is required (dependency lifecycle scripts blocked by default). Update pnpm first.`
    );
  }
  return version;
}

export async function runEmbedderSetup(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(
      "usage: embedder-setup\n" +
      `Installs the bundled in-process embedding (${LOCAL_EMBEDDING_MODEL}) into ${embedderHomeDir()}.\n` +
      "One-time per machine. pnpm required. Downloads ~500MB total (deps + model), then works offline.\n"
    );
    return;
  }

  const pnpmVersion = assertPnpmAvailable();
  const source = bundleDir();
  for (const file of BUNDLE_FILES) {
    if (!existsSync(path.join(source, file))) {
      throw new Error(`Bundled embedder file missing from plugin: ${path.join(source, file)}`);
    }
  }

  const target = embedderHomeDir();
  mkdirSync(target, { recursive: true });
  for (const file of BUNDLE_FILES) {
    copyFileSync(path.join(source, file), path.join(target, file));
  }
  process.stderr.write(`[embedder-setup] pnpm ${pnpmVersion} / installing dependencies into ${target} ...\n`);

  const install = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: target,
    shell: process.platform === "win32",
    stdio: ["ignore", "inherit", "inherit"]
  });
  if (install.status !== 0) {
    throw new Error(
      `pnpm install failed (exit ${install.status}). Fix the error above and rerun embedder-setup. ` +
      "Build scripts stay blocked by design (pnpm-workspace.yaml allowBuilds: all false) — do not approve them."
    );
  }

  // モデルのプリフェッチ + warmup。ここで済ませておかないと「setup 成功後の最初の
  // ask がダウンロードで数分固まる/オフラインで死ぬ」という驚きが後ろに残る。
  process.stderr.write(`[embedder-setup] prefetching model ${LOCAL_EMBEDDING_MODEL} (~144MB on first run) ...\n`);
  const t0 = Date.now();
  const probes = {
    ja: {
      query: "query: サプライチェーン攻撃への対策",
      related: "passage: パッケージレジストリの install script を悪用した攻撃が増えている",
      unrelated: "passage: 今日の昼食はカレーライスにした"
    },
    en: {
      query: "query: defending against software supply chain attacks",
      related: "passage: package registry install scripts are increasingly abused to distribute malware",
      unrelated: "passage: I had curry and rice for lunch today"
    }
  };
  const cosine = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const sanity: Record<string, { related: number; unrelated: number }> = {};
  let dims = 0;
  let sane = true;
  for (const [lang, probe] of Object.entries(probes)) {
    const [q, related, unrelated] = await Promise.all([
      embedLocalText(LOCAL_EMBEDDING_MODEL, probe.query),
      embedLocalText(LOCAL_EMBEDDING_MODEL, probe.related),
      embedLocalText(LOCAL_EMBEDDING_MODEL, probe.unrelated)
    ]);
    dims = q.length;
    const scores = {
      related: Number(cosine(q, related).toFixed(4)),
      unrelated: Number(cosine(q, unrelated).toFixed(4))
    };
    sanity[lang] = scores;
    if (scores.related <= scores.unrelated) sane = false;
  }
  if (!sane) {
    throw new Error(
      `embedder-setup sanity check failed (related <= unrelated cosine): ${JSON.stringify(sanity)}. ` +
      "Native inference is broken on this machine — do not use this installation; report the platform and this output."
    );
  }

  const status = localEmbedderStatus();
  console.log(JSON.stringify({
    status: "ok",
    dir: status.dir,
    model: LOCAL_EMBEDDING_MODEL,
    dims,
    pnpm: pnpmVersion,
    warmup_ms: Date.now() - t0,
    sanity,
    note: "Done. ask/carve now fall back to this in-process embedding when no endpoint is configured or detected. Works offline from here on."
  }, null, 2));
}

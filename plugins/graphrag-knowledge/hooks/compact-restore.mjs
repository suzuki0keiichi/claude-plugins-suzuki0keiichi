#!/usr/bin/env node
// Compact / Clear 復元フック (SessionStart)。
// 直前の checkpoint = active Investigation の作業状態 (work_state) とそこから生んだ
// 恒久知識 (linked_knowledge) を `brief --mode resume` で取り出し additionalContext に注入する。
// 発火は 2 つの source:
//   - compact: 常に復元 (auto-compact を含む。盲目的要約に curated な checkpoint を重ねる保険)。
//   - clear:   直前 checkpoint が「新鮮」なとき (generated_at が FRESH_WINDOW_MS 以内) だけ復元。
//              古い checkpoint は白紙のまま — 無関係な作業のための /clear を邪魔しない。
//              (checkpoint → clear → 盲目的要約ゼロの綺麗な再開、という狙いのワークフロー用)
// startup / resume では何もしない。
// 三段で無害化する: (1) .graphrag が walk-up で見つからなければ即 no-op (CLI も起動しない)、
// (2) GRAPHRAG_COMPACT_RESTORE=off で明示 opt-out、(3) 配布 scope で届く範囲自体を絞れる。
// 依存ゼロの素 node — plugin 配布先に node_modules を要求しないため。
// どんな失敗でもセッション開始をブロックしない (何も出さず正常終了)。

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(PLUGIN_ROOT, "graphrag", "cli.ts");

// clear で復元を許す「新鮮さ」の窓。checkpoint 直後の /clear だけを拾う。
const FRESH_WINDOW_MS = 10 * 60 * 1000; // 10 分

// cwd から上方向に .graphrag (vault/ か .env を持つもの) を探す。最初の一致で止める。
// 見つからなければ null (= 非 graphrag リポジトリ → 何もしない)。
function findGraphragDir(startDir) {
  let dir = startDir;
  while (true) {
    const dot = path.join(dir, ".graphrag");
    if (existsSync(path.join(dot, "vault")) || existsSync(path.join(dot, ".env"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// 明示 opt-out: プロセス env、または vault 側 .graphrag/.env に GRAPHRAG_COMPACT_RESTORE=off。
function isOptedOut(anchorDir) {
  if (/^off$/i.test(process.env.GRAPHRAG_COMPACT_RESTORE ?? "")) return true;
  const envPath = path.join(anchorDir, ".graphrag", ".env");
  try {
    if (existsSync(envPath)) {
      const text = readFileSync(envPath, "utf8");
      if (/^\s*GRAPHRAG_COMPACT_RESTORE\s*=\s*off\s*$/im.test(text)) return true;
    }
  } catch {
    // .env が読めなくても opt-out 扱いにはしない
  }
  return false;
}

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);

  // compact と clear だけ扱う。startup / resume では何もしない。
  const source = input?.source;
  if (source !== "compact" && source !== "clear") return;

  const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const anchorDir = findGraphragDir(cwd);
  if (!anchorDir) return; // 非 graphrag リポジトリ — 透明
  if (isOptedOut(anchorDir)) return; // 明示 opt-out

  // resume は vector index 不要 (query mode のみ必要) なので embedding 不達でも動く。
  const stdout = execFileSync(
    process.execPath,
    ["--experimental-strip-types", CLI, "brief", "--mode", "resume"],
    { cwd: anchorDir, encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }
  );

  const brief = JSON.parse(stdout);
  const primary = brief?.active?.primary ?? null;
  const legacyNote = brief?.active?.legacy_note ?? null;

  // 復元すべき active Investigation も legacy 注記も無ければ、注入しない (無音)。
  if (!primary && !legacyNote) return;

  // clear は「直前 checkpoint が新鮮なとき」だけ。古い/日付不明なら白紙のまま。
  // (compact は常に復元 — 上の分岐を通過した時点で無条件。)
  if (source === "clear") {
    const gen = primary?.generated_at ? Date.parse(primary.generated_at) : NaN;
    const fresh = Number.isFinite(gen) && Date.now() - gen <= FRESH_WINDOW_MS;
    if (!fresh) return;
  }

  const guide =
    "直前 checkpoint からの自動復元 (graphrag)。checkpoint を起点に作業を継続せよ。" +
    "active.primary.work_state = 退避した作業状態 (focus / 次アクション / 詰まり / 途中の編集)、" +
    "active.primary.linked_knowledge = この focus が生んだ恒久知識 (Decision/Risk/OK 等)、" +
    "active.primary.scratch = 深い生ログ (必要なら discussed_in の ConversationChunk を ask で辿る)。" +
    "compact 要約より checkpoint を優先せよ。";

  const payload = { restore: brief.active, guide };

  const out = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `${guide}\n\n${JSON.stringify(payload.restore, null, 2)}`
    }
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

main().catch(() => {
  // 入力不正 / CLI 失敗 / タイムアウト等 — セッション開始をブロックせず黙って終了。
}).finally(() => process.exit(0));

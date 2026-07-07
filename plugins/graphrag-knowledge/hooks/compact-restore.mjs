#!/usr/bin/env node
// Compact / Clear 復元フック (SessionStart)。
// 直前の checkpoint = active Investigation の作業状態 (work_state) とそこから生んだ
// 恒久知識 (linked_knowledge) を `brief --mode resume` で取り出し additionalContext に注入する。
// 発火は 2 つの source:
//   - compact: 常に復元 (auto-compact を含む。盲目的要約に curated な checkpoint を重ねる保険)。
//   - clear:   直前 checkpoint が one-shot マーカー (`checkpoint-mark` verb が刻む
//              .graphrag/cache/checkpoint-pending.json) を残しているときだけ復元。
//              マーカーは読んだ時点で消費 (削除) — 一度判定に使ったら以後の無関係な
//              /clear を邪魔しない。暴発防止に MARKER_TTL_MS の失効を併設
//              (撃ったのに clear しなかった古い意図は白紙のまま)。
//              マーカーが無ければ旧ゲート (generated_at が FRESH_WINDOW_MS 以内) に落ちる
//              (checkpoint-mark を撃たない旧 skill の checkpoint 直後をなお拾う後方互換)。
//              壁時計だけに頼らないのは: (1) checkpoint → 報告確認 → /clear で 10 分は
//              普通に超える、(2) op:update は内容が変わった時しか generated_at を進めない
//              ため同内容の再 checkpoint 直後でも「古い」と誤判定されるから。
//              (checkpoint → clear → 盲目的要約ゼロの綺麗な再開、という狙いのワークフロー用)
// startup / resume では何もしない。
// 三段で無害化する: (1) .graphrag が walk-up で見つからなければ即 no-op (CLI も起動しない)、
// (2) GRAPHRAG_COMPACT_RESTORE=off で明示 opt-out、(3) 配布 scope で届く範囲自体を絞れる。
// 依存ゼロの素 node — plugin 配布先に node_modules を要求しないため。
// どんな失敗でもセッション開始をブロックしない (何も出さず正常終了)。

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(PLUGIN_ROOT, "graphrag", "cli.ts");

// マーカー無し (旧 skill) の後方互換ゲート: clear で復元を許す generated_at の「新鮮さ」窓。
const FRESH_WINDOW_MS = 10 * 60 * 1000; // 10 分

// one-shot マーカーの失効窓。主の消費は unlink であり、これは「checkpoint-mark を撃ったが
// clear しなかった」古い意図が翌日の無関係な /clear で暴発しないための保険。
// graphrag/checkpoint-marker.ts の CHECKPOINT_MARKER_TTL_MS と揃える (依存ゼロ方針で import しない)。
const MARKER_TTL_MS = 60 * 60 * 1000; // 60 分

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

// checkpoint-mark verb (graphrag/checkpoint-marker.ts) が刻む one-shot マーカー。
function markerPath(anchorDir) {
  return path.join(anchorDir, ".graphrag", "cache", "checkpoint-pending.json");
}

// 壊れた/読めないマーカーは null (存在しない扱い → 旧ゲートに落ちる)。
function readMarker(anchorDir) {
  const fp = markerPath(anchorDir);
  if (!existsSync(fp)) return null;
  try {
    const parsed = JSON.parse(readFileSync(fp, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.marked_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

// one-shot 消費。無くても失敗しない。
function consumeMarker(anchorDir) {
  try {
    unlinkSync(markerPath(anchorDir));
  } catch {
    // 既に無い / 消せない — 消費は best-effort
  }
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

  // one-shot マーカーの判定。読んだ (= 判定に使った) 時点で消費する。
  //   clear:   マーカーあり+新鮮 → 復元 / マーカーあり+失効 → 白紙 / 無し → 旧ゲート。
  //   compact: 復元は無条件だが、マーカーが残っていれば片付ける
  //            (checkpoint → auto-compact 復元後、後日の無関係な /clear での二重復元を防ぐ)。
  const marker = readMarker(anchorDir);
  let markerFresh = false;
  if (marker) {
    consumeMarker(anchorDir);
    const marked = Date.parse(marker.marked_at);
    markerFresh = Number.isFinite(marked) && Date.now() - marked <= MARKER_TTL_MS;
    if (source === "clear" && !markerFresh) return; // 失効した意図 — 白紙のまま (CLI も起動しない)
  }

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

  // clear かつマーカー無し (旧 skill の checkpoint): 後方互換の generated_at ゲート。
  // マーカーが新鮮ならここは通らない (意図の明示が時刻推定より強い)。
  // (compact は常に復元 — 上の分岐を通過した時点で無条件。)
  if (source === "clear" && !markerFresh) {
    const gen = primary?.generated_at ? Date.parse(primary.generated_at) : NaN;
    const fresh = Number.isFinite(gen) && Date.now() - gen <= FRESH_WINDOW_MS;
    if (!fresh) return;
  }

  const guide =
    "直前 checkpoint からの自動復元 (graphrag)。checkpoint を起点に作業を継続せよ。" +
    "最初の一手は active.primary.work_state の next 先頭 — まずそれを実行する。" +
    "ask / brief の再実行や広い探索・ファイル総ざらいから再開しない " +
    "(必要な知識は linked_knowledge に整理済み。探索は next を実行して不足が判明してからで遅くない)。" +
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

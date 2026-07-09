#!/usr/bin/env node
// Clear 復元フック (SessionStart)。
// 直前の checkpoint (`checkpoint-mark` verb が ask-state.json の予約キー __checkpoint__ に
// 刻んだ work_state と「最初の一手」) を、source==="clear" のときだけ additionalContext に注入する。
//
// 設計:
//   - compact では復元しない。compact は古い checkpoint を無条件再注入するミスリード源なので、
//     source!=="clear" なら即終了 (キーにも触らない)。引き継ぎは /clear 経由のみ。
//   - 予約キーは checkpoint-mark 側で検証済み (id 実在・active・work_state 書式・first_action 非空・
//     8KB 以内)。よってこのフックは CLI も graph パースもせず、キーの中身をそのまま組んで注入する。
//   - one-shot: 読んだら「判定より先に」キーを消費 (削除して書き戻す)。鮮度判定で先に return して
//     キーが残ると、次の無関係な /clear で同じ指示が再注入される事故が実際に起きた。だから全分岐
//     (注入する/しない) より前に必ず消す。
// 三段で無害化する: (1) .graphrag が walk-up で見つからなければ即 no-op、
// (2) GRAPHRAG_CLEAR_RESTORE=off で明示 opt-out、(3) 配布 scope で届く範囲自体を絞れる。
// 依存ゼロの素 node (node:fs / node:path のみ。graphrag/*.ts を import しない) —
// plugin 配布先に node_modules を要求しないため。
// どんな失敗でもセッション開始をブロックしない (何も出さず正常終了)。

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// 予約キー名。graphrag/cli-ask-state.ts の CHECKPOINT_STATE_KEY と揃える
// (依存ゼロ方針で import せず複製する — 変える時は両側を直すこと)。
const CHECKPOINT_KEY = "__checkpoint__";

// 予約キーの失効窓。主の消費は下の one-shot 削除であり、これは「checkpoint-mark を撃ったが
// clear しなかった」古い意図が翌日の無関係な /clear で暴発しないための保険。
// graphrag/checkpoint-marker.ts の CHECKPOINT_TTL_MS と揃える (依存ゼロ方針で import しない)。
const CHECKPOINT_TTL_MS = 60 * 60 * 1000; // 60 分

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

// 明示 opt-out: プロセス env、または vault 側 .graphrag/.env に GRAPHRAG_CLEAR_RESTORE=off。
// (旧 GRAPHRAG_COMPACT_RESTORE は廃止。認識しない。)
function isOptedOut(anchorDir) {
  if (/^off$/i.test(process.env.GRAPHRAG_CLEAR_RESTORE ?? "")) return true;
  const envPath = path.join(anchorDir, ".graphrag", ".env");
  try {
    if (existsSync(envPath)) {
      const text = readFileSync(envPath, "utf8");
      if (/^\s*GRAPHRAG_CLEAR_RESTORE\s*=\s*off\s*$/im.test(text)) return true;
    }
  } catch {
    // .env が読めなくても opt-out 扱いにはしない
  }
  return false;
}

// checkpoint-mark verb が書く予約キーの置き場所 (= cacheDirForVault(vault) 固定)。
function askStatePath(anchorDir) {
  return path.join(anchorDir, ".graphrag", "cache", "ask-state.json");
}

// 予約キーを消費 (削除) して原子書き込みで書き戻す。他キーは保つ。
// tmp+rename で「壊れた JSON を読ませない」ところまで保証する (ask-state.json の saveAskState と同じ規約)。
function consumeCheckpointKey(fp, state) {
  delete state[CHECKPOINT_KEY];
  try {
    if (!existsSync(path.dirname(fp))) mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = `${fp}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, fp);
  } catch {
    // 書き戻せなくても復元判定自体は続行する (best-effort な消費)。
  }
}

function emit(additionalContext) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext
    }
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);

  // clear だけ扱う。compact / startup / resume では何もしない (キーにも触らない)。
  if (input?.source !== "clear") return;

  const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const anchorDir = findGraphragDir(cwd);
  if (!anchorDir) return; // 非 graphrag リポジトリ — 透明
  if (isOptedOut(anchorDir)) return; // 明示 opt-out

  const fp = askStatePath(anchorDir);
  if (!existsSync(fp)) return; // ask-state.json 自体が無い — 無音
  let state;
  try {
    state = JSON.parse(readFileSync(fp, "utf8"));
  } catch {
    return; // パース不能 — 無音 (他キーごと壊すより触らない)
  }
  if (!state || typeof state !== "object") return;
  const entry = state[CHECKPOINT_KEY];
  if (!entry || typeof entry !== "object") return; // 予約キー無し — 無音

  // 消費を「判定より先に」。以降どの分岐に落ちても予約キーは既に消えている
  // (鮮度で先に return してキーが残る事故を構造的に防ぐ)。
  consumeCheckpointKey(fp, state);

  // 失効判定: marked_at が 60 分以内か。parse 不能なら last_at (ms epoch) で代替、
  // それも無ければ失効扱い。
  const markedMs = Date.parse(entry.marked_at);
  const stampMs = Number.isFinite(markedMs)
    ? markedMs
    : (typeof entry.last_at === "number" ? entry.last_at : NaN);
  const fresh = Number.isFinite(stampMs) && Date.now() - stampMs <= CHECKPOINT_TTL_MS;

  // cwd 判定: 実体パス同士の厳密一致 (別ディレクトリの checkpoint を引き込まない)。
  // 素の文字列比較だと symlink で偽陰性になる — checkpoint-mark 側の process.cwd() は
  // OS 解決済み (/private/var/…) だが、フック input.cwd は未解決 (/var/…) で届き得る。
  // realpath 不能 (削除済み等) はそのままの文字列で比較する。
  const realOrSelf = (p) => {
    try { return realpathSync(p); } catch { return p; }
  };
  const sameCwd = typeof entry.cwd === "string" &&
    typeof input.cwd === "string" &&
    realOrSelf(input.cwd) === realOrSelf(entry.cwd);

  if (!fresh || !sameCwd) {
    // 沈黙は「なぜ復元しなかったか」の切り分けを不能にするので、理由を一行だけ注入する。
    const reason = !fresh
      ? "expired: past the 60-minute freshness window"
      : `checkpoint belongs to a different directory (${entry.cwd})`;
    emit(
      `A graphrag checkpoint existed but was NOT restored (${reason}). ` +
      "If needed, restore manually via the graphrag CLI: brief --mode resume."
    );
    return;
  }

  // 判定 OK — 命令形プロースを注入 (JSON ダンプではない)。
  emit(
    "Automatic restore from the last graphrag checkpoint. Prioritize this over any compact summary or exploration.\n" +
    "First action (do NOT restart from ask / brief re-runs or broad exploration):\n" +
    `→ ${entry.first_action}\n\n` +
    "--- work state (as of checkpoint) ---\n" +
    `${entry.work_state}\n` +
    "---\n" +
    `Source: Investigation ${entry.investigation_id} (trace via ask only when you need deep raw logs or related knowledge)`
  );
}

main().catch(() => {
  // 入力不正 / IO 失敗等 — セッション開始をブロックせず黙って終了。
}).finally(() => process.exit(0));

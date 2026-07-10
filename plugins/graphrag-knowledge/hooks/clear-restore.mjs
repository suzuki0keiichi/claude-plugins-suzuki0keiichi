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
//   - 予約キーの置き場所は書き手 (checkpoint-mark の cacheDirForVault(vault)) と同じ規則で解決する:
//     walk-up した anchor の .graphrag/.env が GRAPHRAG_VAULT_DIR で外部 vault を指していれば
//     「vault の親の .graphrag/cache」を読む。ここを anchor 側固定で読むと共有 vault 構成で
//     書き手と分裂し、復元が毎回無音で失敗する (実際に起きた)。
//   - ack 契約: 注入は additionalContext なので人間には見えない。復元成功/不成功のどちらの
//     注入文も「最初の返答の冒頭でユーザーに宣言せよ」を義務付ける。これにより /clear 後の
//     最初の返答に宣言が無い = 引き継ぎ失敗、と人間が沈黙から判定できる。
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

// 書き手 (checkpoint-mark) が使う vault dir を、CLI と同じ first-wins で解決する:
// シェル env → anchor の .graphrag/.env の GRAPHRAG_VAULT_DIR → ローカル既定 (<anchor>/.graphrag/vault)。
// 相対パスは anchor 基準で解決する (CLI は自身の cwd 基準だが、フックに書き手の cwd は届かない)。
function resolveVaultDir(anchorDir) {
  const fromEnv = process.env.GRAPHRAG_VAULT_DIR;
  if (typeof fromEnv === "string" && fromEnv !== "") return path.resolve(anchorDir, fromEnv);
  const envPath = path.join(anchorDir, ".graphrag", ".env");
  try {
    if (existsSync(envPath)) {
      // parseDotEnv (graphrag/cli-env.ts) の簡易複製: # コメント / export 接頭辞 / 引用符除去。
      for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
        const m = /^GRAPHRAG_VAULT_DIR\s*=\s*(.*)$/.exec(body);
        if (!m) continue;
        let value = m[1].trim();
        if (
          (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
          (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
        ) {
          value = value.slice(1, -1);
        }
        if (value) return path.resolve(anchorDir, value);
      }
    }
  } catch {
    // .env が読めなければローカル既定へフォールバック
  }
  return path.join(anchorDir, ".graphrag", "vault");
}

// checkpoint-mark verb が書く予約キーの置き場所 (= cacheDirForVault(vault) の依存ゼロ複製)。
// vault の親を .graphrag に正規化し、その下の cache/ask-state.json。
function askStatePath(vaultDir) {
  let stateDir = path.dirname(path.resolve(vaultDir));
  if (path.basename(stateDir) !== ".graphrag") stateDir = path.join(stateDir, ".graphrag");
  return path.join(stateDir, "cache", "ask-state.json");
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

  const fp = askStatePath(resolveVaultDir(anchorDir));
  if (!existsSync(fp)) return; // ask-state.json 自体が無い — 無音 (checkpoint 未実行と同義)
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
      "The user cannot see this message and may be relying on the handover — open your first reply by " +
      "telling them the checkpoint was not restored and why. " +
      "Offer manual restore via the graphrag CLI: brief --mode resume."
    );
    return;
  }

  // 判定 OK — 命令形プロースを注入 (JSON ダンプではない)。
  emit(
    "Automatic restore from the last graphrag checkpoint. Prioritize this over any compact summary or exploration.\n" +
    "Handover ack (mandatory): the user cannot see this injection — your first reply is their only proof " +
    "the handover worked. Open it with 1-2 lines declaring that the checkpoint was restored: the current " +
    "focus and the first action you are about to take. Then execute that first action.\n" +
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
}).finally(() => {
  // process.exit() は使わない: macOS では pipe への stdout 書き込みが非同期なので、
  // exit が emit の flush に先行すると注入 JSON が途中で切れる (予約キーは消費済みのため
  // 復元内容が回収不能に消える)。stdin は消費済みで他に生きたハンドルは無く、自然終了する。
  process.exitCode = 0;
});

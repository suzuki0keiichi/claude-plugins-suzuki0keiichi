#!/usr/bin/env node
// Clear 復元フック (SessionStart)。
// 直前の checkpoint (`checkpoint-mark` verb が ask-state.json の identity 別予約キー
// __checkpoint__:<hash> に刻んだ work_state と「最初の一手」) を、source==="clear" のときだけ
// additionalContext に注入する。
//
// 設計:
//   - compact では復元しない。compact は古い checkpoint を無条件再注入するミスリード源なので、
//     source!=="clear" なら即終了 (キーにも触らない)。引き継ぎは /clear 経由のみ。
//   - 予約キーは checkpoint-mark 側で検証済み (id 実在・active・work_state 書式・first_action 非空・
//     8KB 以内)。よってこのフックは CLI も graph パースもせず、キーの中身をそのまま組んで注入する。
//   - 予約キーは identity 別 (#29): 全 `__checkpoint__:*` entry のうち同一性判定 (下記三段) で
//     自分に一致するものだけを扱う。他 session/project の entry は読みも消費もしない
//     (単一キー時代は別 project の /clear が判定前消費で予約を先食いしていた)。
//     一致が無ければ「予約キー無し」と同じ無音。旧単一キー `__checkpoint__` は読み互換として
//     従来どおり無条件に消費して扱う (移行措置 — 一度消費されれば消える)。
//   - one-shot: 扱う entry は「判定より先に」消費 (削除して書き戻す)。鮮度判定で先に return して
//     キーが残ると、次の無関係な /clear で同じ指示が再注入される事故が実際に起きた。だから全分岐
//     (注入する/しない) より前に、自分が扱う entry は必ず消す (entry 単位の consume-first)。
//   - 予約キーの置き場所は書き手 (checkpoint-mark の cacheDirForVault(vault)) と同じ規則で解決する:
//     walk-up した anchor の .graphrag/.env が GRAPHRAG_VAULT_DIR で外部 vault を指していれば
//     「vault の親の .graphrag/cache」を読む。ここを anchor 側固定で読むと共有 vault 構成で
//     書き手と分裂し、復元が毎回無音で失敗する (実際に起きた)。
//   - 同一性判定は三段フォールバック (精度順に session_dir → root → cwd)。詳細は main() の該当箇所と
//     graphrag/cli-ask-state.ts の CheckpointStateEntry のコメント。
//   - ack 契約: 注入は additionalContext なので人間には見えない。復元成功/不成功のどちらの
//     注入文も「最初の返答の冒頭でユーザーに宣言せよ」を義務付ける。これにより /clear 後の
//     最初の返答に宣言が無い = 引き継ぎ失敗、と人間が沈黙から判定できる。
// 三段で無害化する: (1) .graphrag が walk-up で見つからなければ即 no-op、
// (2) GRAPHRAG_CLEAR_RESTORE=off で明示 opt-out、(3) 配布 scope で届く範囲自体を絞れる。
// 依存ゼロの素 node (node:fs / node:path のみ。graphrag/*.ts を import しない) —
// plugin 配布先に node_modules を要求しないため。
// どんな失敗でもセッション開始をブロックしない (何も出さず正常終了)。

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// 予約キーの stem。graphrag/cli-ask-state.ts の CHECKPOINT_STATE_KEY と揃える
// (依存ゼロ方針で import せず複製する — 変える時は両側を直すこと)。
// 実キーは identity 別の `__checkpoint__:<hash>` (#29)。suffix hash は書き手の衝突回避用で、
// このフックは解釈しない (照合は entry の中身 session_dir/root/cwd で行う)。
// stem 単体のキーは旧フォーマット (単一予約キー時代) の読み互換。
const CHECKPOINT_KEY = "__checkpoint__";

// 予約キーの失効窓。主の消費は下の one-shot 削除であり、これは「checkpoint-mark を撃ったが
// clear しなかった」古い意図が翌日の無関係な /clear で暴発しないための保険。
// graphrag/cli-ask-state.ts の CHECKPOINT_TTL_MS と揃える (依存ゼロ方針で import しない)。
const CHECKPOINT_TTL_MS = 60 * 60 * 1000; // 60 分

// ── mkdir ベースの軽量 lock (#29) ─────────────────────────────────────────
// graphrag/cli-ask-state.ts の withAskStateLock と同一プロトコルの依存ゼロ複製
// (変える時は両側を直すこと):
//   - lock は <baseDir>/ask-state.lock という「ディレクトリ」。mkdir は既存時に EEXIST で
//     失敗するため、素の node だけで原子的な取得になる (恒久ファイル種は増えない — owner ファイル
//     も一時 dir 内のみ)。
//   - 取得直後に lock dir 内へ owner ファイル (pid + hostname + ランダム nonce + 取得時刻) を
//     書く (#41)。mkdir 直後の dir mtime は新しいので、owner を書くまでの間に stale 判定される
//     ことはない。
//   - 取得失敗時は 25ms 間隔でリトライ。stale 判定 (#41 再レビュー — vault-lock.ts と同じ流儀):
//     主軸は「owner pid の死亡」。owner の hostname が自ホストと一致する時だけ pid 生存を見る。
//       * mtime (owner ファイル、無ければ dir) が 5 秒以内 → fresh、待つ。
//       * 5 秒超 + owner pid 死亡 → 残骸 (クラッシュした保持者)、奪取。
//       * 5 秒超 + owner pid 生存 → 奪取しない (fn 内で停止しているだけの生きた保持者から
//         横取りすると双方が RMW を完走して lost update になる)。例外は
//         LOCK_PID_REUSE_MAX_MS (10 分) 超: pid 再利用の保険としての絶対上限。
//       * owner が無い/読めない/hostname 不一致 (ネットワーク共有 state dir 等) → 従来の
//         mtime 判定 (5 秒超で奪取可) に落とす。
//     奪取前に「最初に読んだ nonce と現在の nonce が同一のままであること」を再確認する
//     (read→rm 間に別プロセスが奪取済みなら nonce が変わる — 二重奪取の大半を検出。残る窓は
//     mkdir の原子性が受け止める: 同時奪取しても mkdir に勝つのは一方だけ)。
//     削除は owner ファイル → dir の順。dir が空でなければ rmdir が ENOTEMPTY で失敗し retry に戻る。
//   - release (finally) は owner ファイルの nonce が自分と一致する場合のみ削除する (#41 ABA:
//     停止中に stale 奪取されていたら lock はもう他者のもの — 不一致/読めない場合は触らない。
//     従来は無条件 rmdir だったため、奪取者の lock を消して第三者を進入させ lost update が再発した)。
//   - fencing (#41 再レビュー): RMW の save 直前に owner の nonce が自分のままかを再確認し、
//     失われていたら書かずに RMW 全体を再試行する (再 acquire → fn 再実行、最大 3 回)。
//     上限到達時は従来同等の best-effort で書く (console.error = stderr で可視化)。
//   - 10 秒でタイムアウトし「lock なしで続行」する (best-effort、console.error で可視化)。
//     セッション開始をブロックしない。
const LOCK_DIRNAME = "ask-state.lock";
const LOCK_OWNER_FILENAME = "owner.json";
const LOCK_STALE_MS = 5_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 25;
// 生存 pid の lock でも奪取を許す絶対上限 (pid 再利用の保険)。vault-lock.ts の staleMs と同じ流儀。
const LOCK_PID_REUSE_MAX_MS = 600_000;
// fencing 喪失時の RMW 再試行上限 (初回込み)。
const RMW_MAX_ATTEMPTS = 3;

// pid が生きているか (kill 0 プローブ。EPERM = 存在するが権限なし → 生存扱い)。
// graphrag/vault-lock.ts の pidAlive の依存ゼロ複製。
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

// owner ファイルを読む。無い/読めない/形式不正は null (= owner 不明)。欠け/型不正の
// フィールドは null (旧フォーマットの owner は hostname を持たない → mtime 判定に落ちる)。
function readLockOwner(ownerPath) {
  try {
    const parsed = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      nonce: typeof parsed.nonce === "string" ? parsed.nonce : null,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : null
    };
  } catch {
    return null;
  }
}

function readLockOwnerNonce(ownerPath) {
  return readLockOwner(ownerPath)?.nonce ?? null;
}

// stale 経過後 (age > LOCK_STALE_MS) の lock を奪取してよいか。プロトコルコメント参照。
function lockOwnerConsideredDead(owner, ageMs) {
  if (!owner || owner.pid === null || owner.hostname === null || owner.hostname !== os.hostname()) {
    return true; // owner 不明 / 旧フォーマット / 別ホスト → 従来の mtime 判定 (呼び手が stale 済み)
  }
  if (!pidAlive(owner.pid)) return true; // 保持者は死んでいる → 残骸
  return ageMs > LOCK_PID_REUSE_MAX_MS; // 生存 pid は原則奪わない。絶対上限だけは例外
}

// 同期 sleep。Atomics.wait はメインスレッドの素 node で使える (timer も child_process も不要)。
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer が使えない環境では即リトライ (busy loop 側に倒す)。
  }
}

// save 直前の fencing 再検証で lock 喪失を検出した時の内部シグナル (withAskStateLock が捕捉して
// RMW 全体を再試行する)。fn 側の best-effort catch はこれだけ rethrow すること。
class AskStateFencingLostError extends Error {
  constructor() {
    super("ask-state lock lost before save");
  }
}

function acquireAskStateLock(baseDir) {
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  const lockDir = path.join(baseDir, LOCK_DIRNAME);
  const ownerPath = path.join(lockDir, LOCK_OWNER_FILENAME);
  const nonce = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;
  while (!held) {
    try {
      mkdirSync(lockDir); // 非 recursive: 既存なら EEXIST → 原子的な取得判定
      held = true;
      try {
        // 取得の証明を即座に書く。失敗しても保持は続行 — owner 不明 lock として振る舞う
        // (stale 化したら他者に無条件奪取され、release も nonce 不一致で触らない)。
        writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, nonce, hostname: os.hostname(), acquired_at: Date.now() }));
      } catch { /* best-effort */ }
    } catch (e) {
      if (e?.code !== "EEXIST") {
        // 権限等の想定外 — lock なしで続行 (best-effort)
        console.error(`[graphrag] ask-state lock: unexpected acquire failure (${e?.code ?? e}) — continuing without lock (best-effort)`);
        break;
      }
      // タイムアウトは全 retry 経路 (stale 奪取の continue 含む) が通る位置で判定する。
      // 旧実装は stale 分岐の continue が判定を素通りし、消せない残骸で無限 busy loop になった。
      if (Date.now() > deadline) {
        // タイムアウト — lock なしで続行 (best-effort)。無音だと lost update の可能性が見えない。
        console.error(`[graphrag] ask-state lock: timeout after ${LOCK_TIMEOUT_MS}ms (${lockDir}) — continuing without lock (best-effort, lost update possible)`);
        break;
      }
      try {
        const seenOwner = readLockOwner(ownerPath); // null = owner 不明
        let mtimeMs;
        try {
          mtimeMs = statSync(ownerPath).mtimeMs; // 保持者の証明の鮮度で判定
        } catch {
          mtimeMs = statSync(lockDir).mtimeMs; // owner 無し lock は dir の鮮度で判定
        }
        const age = Date.now() - mtimeMs;
        if (age > LOCK_STALE_MS && lockOwnerConsideredDead(seenOwner, age)) {
          // 奪取直前に nonce が変わっていないか再確認 (#41: 別プロセスが先に奪取して保持中の
          // lock を消さない)。owner 不明 (null) かつ stale はそのまま削除可。
          if (readLockOwnerNonce(ownerPath) === (seenOwner?.nonce ?? null)) {
            rmSync(ownerPath, { force: true });
            rmdirSync(lockDir); // 残骸を奪取 (rmdir の競合は片方が ENOENT/ENOTEMPTY → 次ループで再判定)
          }
          continue;
        }
      } catch {
        continue; // stat/rm 中に消えた等 → すぐ再取得を試みる
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  return {
    held,
    nonce,
    ownerPath,
    release() {
      if (!held) return;
      try {
        // 自分の nonce のままの時だけ解放する (#41 ABA)。不一致/読めない場合は停止中に
        // stale 奪取済み — その lock はもう他者のものなので触らない。
        if (readLockOwnerNonce(ownerPath) === nonce) {
          rmSync(ownerPath, { force: true });
          rmdirSync(lockDir);
        }
      } catch { /* 奪取済み等 — 触らない */ }
    }
  };
}

// 契約 (#41 再レビュー): fn は再実行され得る (最大 RMW_MAX_ATTEMPTS 回)。読みは必ず fn の
// 中で行い、書き込みは渡される save(state) を通すこと。save は書き込み直前に owner の nonce が
// 自分のままかを再検証し (fencing)、失われていたら書かずに fn ごと再試行する。上限到達時は
// 従来同等の best-effort で書く。lock なし (タイムアウト等) の時は fencing 検証をスキップして書く。
function withAskStateLock(baseDir, fn) {
  for (let attempt = 1; ; attempt += 1) {
    const lock = acquireAskStateLock(baseDir);
    const lastAttempt = attempt >= RMW_MAX_ATTEMPTS;
    try {
      const save = (state) => {
        if (lock.held && readLockOwnerNonce(lock.ownerPath) !== lock.nonce) {
          if (!lastAttempt) throw new AskStateFencingLostError();
          console.error("[graphrag] ask-state lock: lost before save and retries exhausted — writing best-effort (lost update possible)");
        }
        // tmp+rename で「壊れた JSON を読ませない」ところまで保証する
        // (graphrag/cli-ask-state.ts の saveAskState と同じ規約)。
        const fp = path.join(baseDir, "ask-state.json");
        const tmp = `${fp}.tmp.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(state, null, 2));
        renameSync(tmp, fp);
      };
      return fn(save);
    } catch (e) {
      if (e instanceof AskStateFencingLostError) continue; // 再 acquire → fn 再実行
      throw e;
    } finally {
      lock.release();
    }
  }
}

// 与えられたパスを realpath 解決してから上方向に辿り、.git (ディレクトリ、または worktree の
// ように .git ファイル) を持つ最寄りの祖先ディレクトリを返す。見つからなければ null。
// graphrag/checkpoint-marker.ts の findProjectRoot と揃える (依存ゼロ方針で import せず複製する
// — CHECKPOINT_TTL_MS / askStatePath と同じ扱い。変える時は両側を直すこと)。
// child_process で git を呼ばない (素の fs で .git を探す) のもこの方針の一部。
function findProjectRoot(startDir) {
  let dir;
  try {
    dir = realpathSync(startDir);
  } catch {
    dir = path.resolve(startDir); // 削除済み等 — 解決せずそのまま辿る
  }
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

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

// realpath 解決 (不能ならそのままの文字列)。素の文字列比較だと symlink で偽陰性になる —
// checkpoint-mark 側の process.cwd() は OS 解決済み (/private/var/…) だが、フック input.cwd は
// 未解決 (/var/…) で届き得る。
function realOrSelf(p) {
  try { return realpathSync(p); } catch { return p; }
}

// 同一性判定 (三段フォールバック。精度の高い順に session_dir → root → cwd)。
// graphrag/cli-ask-state.ts の CheckpointStateEntry のコメントも参照。
//   cwd: フックに届いたプロジェクト位置 (input.cwd、無ければ process.cwd())。
//   inputRoot: cwd から解決したプロジェクトルート (findProjectRoot)。
//   inputCwd: 生の input.cwd (三段目の厳密一致は従来どおりこちらで見る)。
function matchesProject(entry, cwd, inputRoot, inputCwd) {
  const entrySessionDir =
    typeof entry.session_dir === "string" && entry.session_dir ? entry.session_dir : null;
  const entryRoot = typeof entry.root === "string" && entry.root ? entry.root : null;
  if (entrySessionDir) {
    // [1] session_dir はモデルがシステムプロンプトの Primary working directory を
    // `checkpoint-mark --session-dir` で宣言したもので、こちらの input.cwd (Claude Code の
    // プロジェクトディレクトリそのもの) と同じ土俵にある最精密の情報。よってこれ「だけ」で判定し、
    // 不一致なら root へフォールバックせず拒否する: モノレポでサブディレクトリをプロジェクトとして
    // 開いた別セッションは、git ルートが同じでも別プロジェクト位置だから。
    return realOrSelf(cwd) === realOrSelf(entrySessionDir);
  }
  if (entryRoot && inputRoot) {
    // [2] session_dir を持たない entry (旧フォーマット / skill を経ない直接実行) の近似。
    // プロジェクトルート (最寄りの .git を持つ祖先) 同士の実体パス一致で見る。
    // かつて cwd 厳密一致で判定していたが、Claude Code の Bash ツールは作業ディレクトリが
    // セッション中持続するので、AI が `cd <subdir>` して checkpoint-mark を撃つと記録される
    // cwd はサブディレクトリになり、フックに届く input.cwd (セッションルート) と食い違って
    // 復元が拒否された (実際に起きた)。同じリポジトリなら同じ作業とみなす。
    return realOrSelf(inputRoot) === realOrSelf(entryRoot);
  }
  // [3] root がどちらかで欠ける (git 外 / root を持たない旧フォーマット entry) —
  // 従来の cwd 厳密一致。
  return (
    typeof entry.cwd === "string" &&
    typeof inputCwd === "string" &&
    realOrSelf(inputCwd) === realOrSelf(entry.cwd)
  );
}

// entry の打刻 (ms epoch)。marked_at (ISO) を優先し、parse 不能なら last_at で代替。
// どちらも無ければ NaN (= 失効扱い)。
function stampOf(entry) {
  const markedMs = Date.parse(entry.marked_at);
  if (Number.isFinite(markedMs)) return markedMs;
  return typeof entry.last_at === "number" ? entry.last_at : NaN;
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

  const inputRoot = findProjectRoot(cwd);

  // 読み → 自分の entry の選別 → 消費 (書き戻し) を lock で囲む。CLI 側の ask 書き込み
  // (bumpCallCount / recordAskHits / checkpoint-mark) と同一ファイルの RMW なので、
  // lock なしだと相互に lost update する (#29)。判定と注入は lock の外で行う (保持は短く)。
  // fn は fencing 喪失時に再実行され得る — 読みも fn の中で毎回やり直す (#41 再レビュー)。
  const consumed = withAskStateLock(path.dirname(fp), (save) => {
    let state;
    try {
      state = JSON.parse(readFileSync(fp, "utf8"));
    } catch {
      return null; // パース不能 — 無音 (他キーごと壊すより触らない)
    }
    if (!state || typeof state !== "object") return null;

    // identity 別キー (`__checkpoint__:*`) のうち、同一性判定で自分に一致する entry だけを選ぶ。
    // 一致しない entry は本来の持ち主の /clear のために読みも消費もしない。
    const keys = [];
    const matched = [];
    for (const [key, value] of Object.entries(state)) {
      if (!key.startsWith(`${CHECKPOINT_KEY}:`)) continue;
      if (!value || typeof value !== "object") continue;
      if (matchesProject(value, cwd, inputRoot, input.cwd)) {
        keys.push(key);
        matched.push(value);
      }
    }
    // 旧単一キーの読み互換: 従来どおり無条件に消費して扱う (移行措置。一度消費されれば消える)。
    const legacyValue = state[CHECKPOINT_KEY];
    const legacyEntry = legacyValue && typeof legacyValue === "object" ? legacyValue : null;
    if (legacyEntry) keys.push(CHECKPOINT_KEY);
    if (keys.length === 0) return null; // 一致なし — 予約キー無しと同じ無音 (書き戻しもしない)

    // 消費を「判定より先に」(entry 単位の consume-first)。以降どの分岐に落ちても自分が扱う
    // entry は既に消えている (鮮度で先に return してキーが残り、次の無関係な /clear で
    // 再注入される事故を構造的に防ぐ)。tmp+rename で「壊れた JSON を読ませない」ところまで
    // 保証する (ask-state.json の saveAskState と同じ規約)。他キーは保つ。
    for (const key of keys) delete state[key];
    try {
      save(state); // save 直前 fencing 込み (lock 喪失なら throw → fn ごと再試行)
    } catch (e) {
      if (e instanceof AskStateFencingLostError) throw e; // RMW 再試行のシグナルは握り潰さない
      // それ以外の IO 失敗: 書き戻せなくても復元判定自体は続行する (best-effort な消費)。
    }
    return { matched, legacyEntry };
  });
  if (!consumed) return;

  // 注入対象の選択: 自分に一致した entry (identity キー群 + 一致する旧単一キー) のうち最新のもの。
  // 一致が旧単一キーの不一致 entry しか無い場合も、従来どおり「復元しなかった理由」を注入する。
  const candidates = [...consumed.matched];
  if (consumed.legacyEntry && matchesProject(consumed.legacyEntry, cwd, inputRoot, input.cwd)) {
    candidates.push(consumed.legacyEntry);
  }
  candidates.sort((a, b) => (stampOf(b) || 0) - (stampOf(a) || 0));
  const sameProject = candidates.length > 0;
  const entry = candidates[0] ?? consumed.legacyEntry;

  // 失効判定: marked_at が 60 分以内か。parse 不能なら last_at (ms epoch) で代替、
  // それも無ければ失効扱い。
  const stampMs = stampOf(entry);
  const fresh = Number.isFinite(stampMs) && Date.now() - stampMs <= CHECKPOINT_TTL_MS;

  if (!fresh || !sameProject) {
    // 沈黙は「なぜ復元しなかったか」の切り分けを不能にするので、理由を一行だけ注入する。
    // 表示する位置は判定に使ったのと同じ最精密の値 (session_dir → root → cwd)。
    const reason = !fresh
      ? "expired: past the 60-minute freshness window"
      : `checkpoint belongs to a different project (${entry.session_dir ?? entry.root ?? entry.cwd})`;
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

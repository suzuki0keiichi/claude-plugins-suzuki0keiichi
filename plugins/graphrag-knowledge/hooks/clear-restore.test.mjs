// clear-restore.mjs の単体テスト。
// 実行: node --test hooks/clear-restore.test.mjs
// 予約キー方式: ask-state.json の __checkpoint__ キーを clear で one-shot 消費して注入する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "clear-restore.mjs");
const CHECKPOINT_KEY = "__checkpoint__";

// 開発者シェルの GRAPHRAG_VAULT_DIR がテストに漏れないよう既定で空文字列 (未設定扱い) を
// 混ぜる。呼び出し側が env で明示すればそちらが勝つ (Object spread の後勝ち)。
const runHook = (input, env = {}) =>
  execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, GRAPHRAG_VAULT_DIR: "", ...env }
  });

// 既定レイアウト <root>/.graphrag/vault の一時 fixture。
const makeAnchor = () => {
  const root = mkdtempSync(path.join(tmpdir(), "graphrag-ckpt-"));
  mkdirSync(path.join(root, ".graphrag", "vault"), { recursive: true });
  return root;
};

const askStatePath = (root) => path.join(root, ".graphrag", "cache", "ask-state.json");

// state (キー群) を ask-state.json に書く。
const writeState = (root, state) => {
  const fp = askStatePath(root);
  mkdirSync(path.dirname(fp), { recursive: true });
  writeFileSync(fp, JSON.stringify(state, null, 2));
  return fp;
};

// 外部 vault (anchor とは別リポジトリ) の ask-state.json パス。
// vault dir は <extRoot>/vault (state dir はその親を .graphrag に正規化した <extRoot>/.graphrag)
// — hooks/clear-restore.mjs の askStatePath / graphrag/cli-env.ts の cacheDirForVault と同じ規則。
const externalAskStatePath = (extRoot) => path.join(extRoot, ".graphrag", "cache", "ask-state.json");

// 外部 vault リポジトリ側に state (キー群) を書く。
const writeExternalState = (extRoot, state) => {
  const fp = externalAskStatePath(extRoot);
  mkdirSync(path.dirname(fp), { recursive: true });
  writeFileSync(fp, JSON.stringify(state, null, 2));
  return fp;
};

// anchor リポジトリ: <root>/.graphrag/vault は作らず、.graphrag/.env だけを置く
// (findGraphragDir は .env の存在だけでも anchor と認める)。
const makeAnchorWithEnv = (envText) => {
  const root = mkdtempSync(path.join(tmpdir(), "graphrag-ckpt-anchor-"));
  mkdirSync(path.join(root, ".graphrag"), { recursive: true });
  writeFileSync(path.join(root, ".graphrag", ".env"), envText);
  return root;
};

// 標準的な checkpoint 予約キー entry。marked_at / cwd を差し替えて各判定を試す。
const checkpointEntry = (over = {}) => ({
  count: 0,
  last_at: Date.now(),
  marked_at: new Date().toISOString(),
  cwd: over.cwd ?? "__PLACEHOLDER__",
  investigation_id: "investigation:s:live",
  first_action: "foo.ts:42 の bar() を直す",
  work_state: "current focus: X\nnext: foo.ts:42 の bar() を直す\nblocker: なし",
  ...over
});

// --- 無害化 / 無音系 ---

test("startup では何も出さない", () => {
  assert.equal(runHook({ source: "startup", cwd: process.cwd() }), "");
});

test("resume では何も出さない", () => {
  assert.equal(runHook({ source: "resume", cwd: process.cwd() }), "");
});

test("compact はキーが在っても無音かつキーを消費しない", () => {
  const root = makeAnchor();
  try {
    const fp = writeState(root, { [CHECKPOINT_KEY]: checkpointEntry({ cwd: root }) });
    const out = runHook({ source: "compact", cwd: root });
    assert.equal(out, "", "compact では復元しない");
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(onDisk[CHECKPOINT_KEY], "compact は予約キーを消費しない (clear まで残す)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear でも .graphrag が見つからなければ無音", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "no-graphrag-"));
  try {
    assert.equal(runHook({ source: "clear", cwd: empty }), "");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("clear でも GRAPHRAG_CLEAR_RESTORE=off なら無音", () => {
  const root = makeAnchor();
  try {
    writeState(root, { [CHECKPOINT_KEY]: checkpointEntry({ cwd: root }) });
    const out = runHook({ source: "clear", cwd: root }, { GRAPHRAG_CLEAR_RESTORE: "off" });
    assert.equal(out, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("入力が不正 JSON でもブロックせず無音", () => {
  const out = execFileSync(process.execPath, [SCRIPT], { input: "not json at all", encoding: "utf8" });
  assert.equal(out, "");
});

test("clear + ask-state.json 無しは無音", () => {
  const root = makeAnchor();
  try {
    assert.equal(runHook({ source: "clear", cwd: root }), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear + 予約キー無しは無音 (他キーが在っても)", () => {
  const root = makeAnchor();
  try {
    const fp = writeState(root, { abcd1234: { count: 2, last_at: 111 } });
    assert.equal(runHook({ source: "clear", cwd: root }), "");
    // 予約キーが無いだけなので消費 (書き戻し) はしない。
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.deepEqual(onDisk.abcd1234, { count: 2, last_at: 111 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear + ask-state.json 破損は無音", () => {
  const root = makeAnchor();
  try {
    const fp = askStatePath(root);
    mkdirSync(path.dirname(fp), { recursive: true });
    writeFileSync(fp, "{ broken json");
    assert.equal(runHook({ source: "clear", cwd: root }), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 外部 vault 解決 (書き手 checkpoint-mark と同じ first-wins 規則) ---

test("clear + 外部 vault へリダイレクト (.env の GRAPHRAG_VAULT_DIR): 外部側から復元し・キーは外部側で消費され・anchor 側に cache は作られない (回帰: anchor 固定で読むと書き手と分裂して復元が無音で失敗していた)", () => {
  const extRoot = mkdtempSync(path.join(tmpdir(), "graphrag-ckpt-ext-"));
  const externalVaultDir = path.join(extRoot, "vault");
  const root = makeAnchorWithEnv(`GRAPHRAG_VAULT_DIR=${externalVaultDir}\n`);
  try {
    mkdirSync(externalVaultDir, { recursive: true }); // <root>/.graphrag/vault は作らない
    const extFp = writeExternalState(extRoot, { [CHECKPOINT_KEY]: checkpointEntry({ cwd: root }) });

    const out = runHook({ source: "clear", cwd: root });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Automatic restore/, "外部 vault 側の予約キーから復元される");

    const onDisk = JSON.parse(readFileSync(extFp, "utf8"));
    assert.ok(!(CHECKPOINT_KEY in onDisk), "キーは外部側の ask-state.json で消費される");
    assert.ok(!existsSync(path.join(root, ".graphrag", "cache")), "anchor 側に .graphrag/cache は作られない");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(extRoot, { recursive: true, force: true });
  }
});

test("clear + シェル env の GRAPHRAG_VAULT_DIR は .env より優先される", () => {
  const ext1 = mkdtempSync(path.join(tmpdir(), "graphrag-ckpt-ext1-"));
  const ext2 = mkdtempSync(path.join(tmpdir(), "graphrag-ckpt-ext2-"));
  const vault1 = path.join(ext1, "vault");
  const vault2 = path.join(ext2, "vault");
  const root = makeAnchorWithEnv(`GRAPHRAG_VAULT_DIR=${vault1}\n`); // .env は external1 を指す
  try {
    mkdirSync(vault1, { recursive: true });
    mkdirSync(vault2, { recursive: true });
    // キーは external2 側にだけ置く (external1 側には ask-state.json 自体を作らない)。
    const fp2 = writeExternalState(ext2, { [CHECKPOINT_KEY]: checkpointEntry({ cwd: root }) });

    const out = runHook({ source: "clear", cwd: root }, { GRAPHRAG_VAULT_DIR: vault2 });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Automatic restore/, "シェル env が .env より勝って external2 から復元される");

    const onDisk2 = JSON.parse(readFileSync(fp2, "utf8"));
    assert.ok(!(CHECKPOINT_KEY in onDisk2), "external2 側で消費される");
    assert.ok(!existsSync(externalAskStatePath(ext1)), "external1 側は一切触られない");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ext1, { recursive: true, force: true });
    rmSync(ext2, { recursive: true, force: true });
  }
});

test("clear + .env の export 接頭辞・ダブルクォート付き GRAPHRAG_VAULT_DIR も解決できる", () => {
  const extRoot = mkdtempSync(path.join(tmpdir(), "graphrag-ckpt-ext-"));
  const externalVaultDir = path.join(extRoot, "vault");
  const root = makeAnchorWithEnv(`# comment\nexport GRAPHRAG_VAULT_DIR="${externalVaultDir}"\n`);
  try {
    mkdirSync(externalVaultDir, { recursive: true });
    const extFp = writeExternalState(extRoot, { [CHECKPOINT_KEY]: checkpointEntry({ cwd: root }) });

    const out = runHook({ source: "clear", cwd: root });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Automatic restore/, "export + ダブルクォート形式でも解決できる");

    const onDisk = JSON.parse(readFileSync(extFp, "utf8"));
    assert.ok(!(CHECKPOINT_KEY in onDisk), "キーは消費される");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(extRoot, { recursive: true, force: true });
  }
});

// --- 復元 happy-path / 失効・cwd 判定 ---

test("clear + 新鮮な予約キー: 注入され・キーは消え・他キーは残る・ack 義務の文言が入る", () => {
  const root = makeAnchor();
  try {
    const fp = writeState(root, {
      [CHECKPOINT_KEY]: checkpointEntry({ cwd: root }),
      abcd1234: { count: 2, last_at: 111 }
    });
    const out = runHook({ source: "clear", cwd: root });
    const parsed = JSON.parse(out);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(ctx, /foo\.ts:42 の bar\(\) を直す/, "first_action が含まれる");
    assert.match(ctx, /current focus: X/, "work_state が含まれる");
    assert.match(ctx, /investigation:s:live/, "出所 Investigation id が含まれる");
    assert.match(ctx, /Handover ack \(mandatory\)/, "ack 義務の文言が入る");
    assert.match(ctx, /first reply/, "最初の返答で宣言せよという指示が入る");

    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(CHECKPOINT_KEY in onDisk), "予約キーは one-shot 消費される");
    assert.deepEqual(onDisk.abcd1234, { count: 2, last_at: 111 }, "他キーは残る");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear + cwd が symlink 経由で表記違い: 実体パス一致なら復元する", () => {
  // 実バグの回帰: checkpoint-mark の process.cwd() は OS 解決済み (/private/var/…) だが、
  // フック input.cwd は未解決 (/var/…) で届き得る。素の文字列比較だと偽陰性で弾いていた。
  const root = makeAnchor();
  try {
    const resolved = realpathSync(root); // macOS では /var/… → /private/var/… に解決される
    const fp = writeState(root, {
      [CHECKPOINT_KEY]: checkpointEntry({ cwd: resolved })
    });
    const out = runHook({ source: "clear", cwd: root }); // 未解決表記で渡す
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Automatic restore/, "表記違いでも実体が同じなら復元される");
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(CHECKPOINT_KEY in onDisk), "消費される");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear + 失効 (60分超): 理由一行を注入しキーを消費", () => {
  const root = makeAnchor();
  try {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const fp = writeState(root, {
      [CHECKPOINT_KEY]: checkpointEntry({ cwd: root, marked_at: old, last_at: Date.now() - 2 * 60 * 60 * 1000 })
    });
    const out = runHook({ source: "clear", cwd: root });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /NOT restored/);
    assert.match(ctx, /freshness window/);
    assert.match(ctx, /open your first reply/, "失効時も最初の返答で宣言せよという指示が入る");
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(CHECKPOINT_KEY in onDisk), "失効でも one-shot 消費される");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear + root 無し (旧フォーマット) で cwd 不一致: 理由一行を注入しキーを消費", () => {
  const root = makeAnchor();
  try {
    const fp = writeState(root, {
      [CHECKPOINT_KEY]: checkpointEntry({ cwd: "/somewhere/else" })
    });
    const out = runHook({ source: "clear", cwd: root });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /NOT restored/);
    assert.match(ctx, /different project/);
    assert.match(ctx, /\/somewhere\/else/);
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(CHECKPOINT_KEY in onDisk), "不一致でも one-shot 消費される");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- プロジェクトルート判定 (cwd 厳密一致からの緩和) ---

// git リポジトリ相当の anchor (.git ディレクトリ + .graphrag/vault) を作る。
const makeGitAnchor = () => {
  const root = makeAnchor();
  mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
};

test("clear + サブディレクトリで打った checkpoint はセッションルートで復元される (回帰: AI が cd してから CLI を撃つと cwd がずれて拒否されていた)", () => {
  const root = makeGitAnchor();
  try {
    const sub = path.join(root, "plugins", "graphrag-knowledge");
    mkdirSync(sub, { recursive: true });
    // checkpoint-mark は cd 先 (サブディレクトリ) の cwd と、解決したプロジェクトルートを記録する。
    const fp = writeState(root, {
      [CHECKPOINT_KEY]: checkpointEntry({ cwd: sub, root })
    });
    // SessionStart フックにはセッションルート (= リポジトリルート) が届く。
    const out = runHook({ source: "clear", cwd: root });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Automatic restore/, "同じプロジェクトルートなら cwd 表記が違っても復元される");
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(CHECKPOINT_KEY in onDisk), "消費される");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear + 別 git リポジトリの checkpoint は復元されない", () => {
  const root = makeGitAnchor();
  const other = makeGitAnchor();
  try {
    const fp = writeState(root, {
      [CHECKPOINT_KEY]: checkpointEntry({ cwd: other, root: other })
    });
    const out = runHook({ source: "clear", cwd: root });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /NOT restored/);
    assert.match(ctx, /different project/);
    assert.ok(ctx.includes(realpathSync(other)) || ctx.includes(other), "不一致の root が理由に出る");
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(CHECKPOINT_KEY in onDisk), "不一致でも one-shot 消費される");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("clear + worktree (.git がファイル) は自分自身を root として解決する (親リポジトリまで登らない)", () => {
  const parent = makeGitAnchor();
  try {
    // 親リポジトリの中に worktree を置く。worktree の .git は「ファイル」。
    const wt = path.join(parent, "wt");
    mkdirSync(path.join(wt, ".graphrag", "vault"), { recursive: true });
    writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(parent, ".git", "worktrees", "wt")}\n`);

    // (1) worktree 内サブディレクトリの checkpoint は worktree ルートで復元される。
    const sub = path.join(wt, "src");
    mkdirSync(sub, { recursive: true });
    let fp = writeState(wt, { [CHECKPOINT_KEY]: checkpointEntry({ cwd: sub, root: wt }) });
    let ctx = JSON.parse(runHook({ source: "clear", cwd: wt })).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Automatic restore/, "worktree 自身が root として一致する");
    assert.ok(!(CHECKPOINT_KEY in JSON.parse(readFileSync(fp, "utf8"))), "消費される");

    // (2) 親リポジトリで打った checkpoint は worktree では復元されない (別 root)。
    fp = writeState(wt, { [CHECKPOINT_KEY]: checkpointEntry({ cwd: parent, root: parent }) });
    ctx = JSON.parse(runHook({ source: "clear", cwd: wt })).hookSpecificOutput.additionalContext;
    assert.match(ctx, /NOT restored/);
    assert.match(ctx, /different project/, "worktree は親リポジトリの root へ登らない");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("clear + 旧フォーマット entry (root 無し) は従来どおり cwd 厳密一致で判定される", () => {
  const root = makeGitAnchor();
  try {
    // (1) cwd が一致すれば復元される (root フィールドが無くても壊れない)。
    let fp = writeState(root, { [CHECKPOINT_KEY]: checkpointEntry({ cwd: root }) });
    let ctx = JSON.parse(runHook({ source: "clear", cwd: root })).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Automatic restore/, "root 無し + cwd 一致 → 復元");
    assert.ok(!(CHECKPOINT_KEY in JSON.parse(readFileSync(fp, "utf8"))), "消費される");

    // (2) 同一リポジトリ内でも cwd が違えば復元しない (root が無いので緩和は効かない)。
    const sub = path.join(root, "sub");
    mkdirSync(sub, { recursive: true });
    fp = writeState(root, { [CHECKPOINT_KEY]: checkpointEntry({ cwd: sub }) });
    ctx = JSON.parse(runHook({ source: "clear", cwd: root })).hookSpecificOutput.additionalContext;
    assert.match(ctx, /NOT restored/);
    assert.match(ctx, /different project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- session_dir 判定 (三段フォールバックの最上位) ---

test("clear + session_dir 一致: git ルートが違っても (git 外でも) 復元される", () => {
  // session_dir は skill がモデルのシステムプロンプトの Primary working directory を渡したもので、
  // フックの input.cwd と同じ土俵にある。git を一切持たない anchor でも単独で判定できる。
  const root = makeAnchor(); // .git は作らない
  try {
    const fp = writeState(root, {
      // cwd は cd 先のサブディレクトリ、root は無し (git 外) という最悪条件でも session_dir で通る。
      [CHECKPOINT_KEY]: checkpointEntry({ cwd: path.join(root, "sub"), session_dir: realpathSync(root) })
    });
    const out = runHook({ source: "clear", cwd: root });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Automatic restore/, "session_dir 一致だけで復元される");
    assert.ok(!(CHECKPOINT_KEY in JSON.parse(readFileSync(fp, "utf8"))), "消費される");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear + session_dir 不一致: git ルートが同じでも拒否される (モノレポのサブディレクトリを開いた別セッション)", () => {
  const root = makeGitAnchor();
  try {
    // リポジトリのサブディレクトリをプロジェクトとして開いた別セッションの checkpoint。
    // root は同一なので root 判定なら通ってしまうが、session_dir が最精密なので降りない。
    const sub = path.join(root, "packages", "api");
    mkdirSync(path.join(sub, ".graphrag", "vault"), { recursive: true });
    const fp = writeState(root, {
      [CHECKPOINT_KEY]: checkpointEntry({ cwd: sub, root, session_dir: sub })
    });
    const out = runHook({ source: "clear", cwd: root });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /NOT restored/);
    assert.match(ctx, /different project/);
    assert.ok(ctx.includes(sub), "理由には最精密の値 (session_dir) が出る");
    assert.ok(!(CHECKPOINT_KEY in JSON.parse(readFileSync(fp, "utf8"))), "不一致でも one-shot 消費される");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear + session_dir が symlink 経由の表記違い: 実体パス一致なら復元する", () => {
  const root = makeAnchor();
  try {
    const fp = writeState(root, {
      [CHECKPOINT_KEY]: checkpointEntry({ cwd: root, session_dir: realpathSync(root) })
    });
    const ctx = JSON.parse(runHook({ source: "clear", cwd: root })).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Automatic restore/, "未解決表記の input.cwd でも実体が同じなら復元される");
    assert.ok(!(CHECKPOINT_KEY in JSON.parse(readFileSync(fp, "utf8"))), "消費される");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- #29: identity 別キー (__checkpoint__:<hash>) — 複数 session/project の共存 ---

// 書き手 (checkpoint-mark) と同じ identity 別キー。suffix hash の中身をフックは解釈しない
// (照合は entry の session_dir/root/cwd で行う) が、実物と同じ形で作る。
const ckptKeyFor = (identity) =>
  `${CHECKPOINT_KEY}:${createHash("sha1").update(identity).digest("hex").slice(0, 12)}`;

test("#29 clear + identity 別キー2件: 自分の entry だけ復元・消費し、他 project の entry は残る (2回目は無音)", () => {
  const rootA = makeAnchor();
  const otherDir = mkdtempSync(path.join(tmpdir(), "graphrag-ckpt-other-"));
  try {
    const realA = realpathSync(rootA);
    const otherReal = realpathSync(otherDir);
    const fp = writeState(rootA, {
      [ckptKeyFor(realA)]: checkpointEntry({ cwd: rootA, session_dir: realA, first_action: "A の一手" }),
      [ckptKeyFor(otherReal)]: checkpointEntry({ cwd: otherDir, session_dir: otherReal, first_action: "B の一手" })
    });

    const out = runHook({ source: "clear", cwd: rootA });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Automatic restore/, "自分の identity に一致する entry から復元される");
    assert.match(ctx, /A の一手/, "復元されるのは自分の checkpoint");
    assert.ok(!ctx.includes("B の一手"), "他 project の checkpoint は注入されない");

    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(ckptKeyFor(realA) in onDisk), "自分の entry は one-shot 消費される");
    assert.ok(ckptKeyFor(otherReal) in onDisk, "他 project の entry は消費されず残る");

    // 同一 project の 2 回目の /clear は無音 (consume-first のセマンティクス維持)。
    assert.equal(runHook({ source: "clear", cwd: rootA }), "", "2回目は無音");
    const onDisk2 = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(ckptKeyFor(otherReal) in onDisk2, "2回目でも他 project の entry は残る");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }
});

test("#29 clear + 一致 identity 無し: 無音で、他 project の entry は判定前消費されない (先食いバグの解消)", () => {
  const rootA = makeAnchor();
  const otherDir = mkdtempSync(path.join(tmpdir(), "graphrag-ckpt-other-"));
  try {
    const otherReal = realpathSync(otherDir);
    const fp = writeState(rootA, {
      [ckptKeyFor(otherReal)]: checkpointEntry({ cwd: otherDir, session_dir: otherReal, first_action: "B の一手" })
    });
    assert.equal(runHook({ source: "clear", cwd: rootA }), "", "一致なしは予約キー無しと同じ無音");
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(ckptKeyFor(otherReal) in onDisk, "本来の持ち主のために entry は残る");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }
});

test("#29 clear + 旧単一キー互換: __checkpoint__ は従来どおり消費・復元され、他 project の identity キーは残る", () => {
  const rootA = makeAnchor();
  const otherDir = mkdtempSync(path.join(tmpdir(), "graphrag-ckpt-other-"));
  try {
    const otherReal = realpathSync(otherDir);
    const fp = writeState(rootA, {
      [CHECKPOINT_KEY]: checkpointEntry({ cwd: rootA, first_action: "旧キーの一手" }),
      [ckptKeyFor(otherReal)]: checkpointEntry({ cwd: otherDir, session_dir: otherReal, first_action: "B の一手" })
    });
    const out = runHook({ source: "clear", cwd: rootA });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Automatic restore/, "旧単一キーからの復元互換");
    assert.match(ctx, /旧キーの一手/);
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(CHECKPOINT_KEY in onDisk), "旧単一キーは従来どおり消費される (移行措置)");
    assert.ok(ckptKeyFor(otherReal) in onDisk, "他 project の identity キーは残る");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }
});

test("#29 clear + identity キーが失効 (60分超): 理由一行を注入し自分の entry のみ消費", () => {
  const rootA = makeAnchor();
  const otherDir = mkdtempSync(path.join(tmpdir(), "graphrag-ckpt-other-"));
  try {
    const realA = realpathSync(rootA);
    const otherReal = realpathSync(otherDir);
    const oldMs = Date.now() - 2 * 60 * 60 * 1000;
    const fp = writeState(rootA, {
      [ckptKeyFor(realA)]: checkpointEntry({
        cwd: rootA, session_dir: realA, marked_at: new Date(oldMs).toISOString(), last_at: oldMs
      }),
      [ckptKeyFor(otherReal)]: checkpointEntry({ cwd: otherDir, session_dir: otherReal })
    });
    const out = runHook({ source: "clear", cwd: rootA });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /NOT restored/);
    assert.match(ctx, /freshness window/);
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(ckptKeyFor(realA) in onDisk), "失効した自分の entry は消費される");
    assert.ok(ckptKeyFor(otherReal) in onDisk, "他 project の entry は残る");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }
});

// --- #29: 実並行 — フックの consume と CLI の bump が同一ファイルで競合しても lost update しない ---

test("#29 実並行: /clear の consume と並列 bump 群が競合しても count が失われず checkpoint は一度だけ消費される", async () => {
  const root = makeAnchor();
  try {
    const realA = realpathSync(root);
    const cacheDir = path.join(root, ".graphrag", "cache");
    const fp = writeState(root, {
      [ckptKeyFor(realA)]: checkpointEntry({ cwd: root, session_dir: realA, first_action: "並行の一手" })
    });

    const askStateUrl = pathToFileURL(
      path.join(path.dirname(SCRIPT), "..", "graphrag", "cli-ask-state.ts")
    ).href;
    const bumpChild = () =>
      execFileP(process.execPath, [
        "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module",
        "-e",
        `const { bumpCallCount } = await import(process.argv[1]);\n` +
        `for (let i = 0; i < 50; i++) bumpCallCount("hook parallel q", process.argv[2]);\n`,
        askStateUrl,
        cacheDir
      ]);

    // 子プロセス群を走らせつつ、途中でフック (同期) を実行して consume を混ぜる。
    const children = Array.from({ length: 4 }, () => bumpChild());
    const out = runHook({ source: "clear", cwd: root });
    await Promise.all(children);

    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /並行の一手/, "並行中でも自分の checkpoint が復元される");
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(ckptKeyFor(realA) in onDisk), "checkpoint は消費されている");
    // fingerprintQuestion("hook parallel q") の複製はせず、count 合計で検証する
    // (このファイルは依存ゼロ方針で graphrag/*.ts を import しない)。
    const total = Object.values(onDisk).reduce((s, e) => s + (e?.count ?? 0), 0);
    assert.equal(total, 200, "フックの書き戻しが bump を巻き戻さない (lost update 無し)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- #41: lock の owner プロトコル — stale 残骸 (owner ファイルあり/なし) の奪取 ---

const LOCK_DIRNAME = "ask-state.lock";
const LOCK_OWNER_FILENAME = "owner.json";

// lock (dir と、在れば owner ファイル) の mtime を過去へ偽装して stale 化する。
const backdateLock = (lockDir, ms) => {
  const past = new Date(Date.now() - ms);
  const ownerFp = path.join(lockDir, LOCK_OWNER_FILENAME);
  if (existsSync(ownerFp)) utimesSync(ownerFp, past, past);
  utimesSync(lockDir, past, past);
};

test("#41 stale lock (owner ファイル付き残骸) はフックが奪取して復元し、lock が残らない", () => {
  const root = makeAnchor();
  try {
    const realA = realpathSync(root);
    const fp = writeState(root, {
      [ckptKeyFor(realA)]: checkpointEntry({ cwd: root, session_dir: realA, first_action: "奪取後の一手" })
    });
    // クラッシュした保持者の残骸: owner ファイル入りの lock dir (#41 の新プロトコルが書く形)。
    const lockDir = path.join(root, ".graphrag", "cache", LOCK_DIRNAME);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, LOCK_OWNER_FILENAME),
      JSON.stringify({ pid: 99999999, nonce: "dead-crashed-holder", acquired_at: Date.now() - 60_000 })
    );
    backdateLock(lockDir, 60_000);

    const out = runHook({ source: "clear", cwd: root });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /奪取後の一手/, "残骸 lock 越しでも復元される");
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(ckptKeyFor(realA) in onDisk), "checkpoint は消費されている");
    assert.ok(!existsSync(lockDir), "残骸 lock は奪取・解放され、残らない");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#41 stale lock (owner ファイル無し・owner 不明の残骸) もフックが奪取して復元する", () => {
  const root = makeAnchor();
  try {
    const realA = realpathSync(root);
    writeState(root, {
      [ckptKeyFor(realA)]: checkpointEntry({ cwd: root, session_dir: realA, first_action: "素の残骸越しの一手" })
    });
    const lockDir = path.join(root, ".graphrag", "cache", LOCK_DIRNAME);
    mkdirSync(lockDir, { recursive: true });
    backdateLock(lockDir, 60_000);

    const out = runHook({ source: "clear", cwd: root });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /素の残骸越しの一手/, "owner 不明の残骸でも奪取して復元される");
    assert.ok(!existsSync(lockDir), "奪取後に自分の lock として解放される");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

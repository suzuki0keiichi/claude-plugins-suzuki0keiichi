// proactive-persistence-reminder.mjs の単体テスト。
// 実行: node --test hooks/proactive-persistence-reminder.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeDeltaInjection, composeDeltaInjectionWithSeen } from "./proactive-persistence-reminder.mjs";
import { loadCommitShown, appendCommitShown, consumerCacheDir, vaultKey, hash32 } from "./rail-shared.mjs";

test("structure-only info is visible at commit, with omission and coverage context", () => {
  const result = {
    status: "info", connected_knowledge: [],
    structure_summary: Array.from({ length: 5 }, (_, i) => ({
      id: `component:s:c${i}`, type: "Component", title: `Component ${i}`,
      summary: "Never lose this condition.", files_in_scope: 2, files_total: 7
    })),
    structure_coverage: { unregistered_count: 1, unframed_count: 2 },
    counts: { structures_overflow: 3 }
  };
  const text = composeDeltaInjection(result);
  assert.ok(text.includes("Component 0 (2/7 files)"));
  assert.ok(text.includes("+6 more structures"));
  assert.ok(text.includes("1 unregistered, 2 registered without structure"));
  assert.ok(text.includes("delta-check --full"));
  assert.ok(text.includes("does not show those bodies"));
  assert.ok(!text.includes("Never lose"), "the compact map never pretends to be a full norm");
  assert.equal(composeDeltaInjection({ status: "clean", structure_summary: [] }), null);
});

test("commit map does not present provisional structure as authored intent", () => {
  const text = composeDeltaInjection({ status: "info", structure_summary: [{
    id: "component:s:candidate", type: "Component", title: "Candidate", files_in_scope: 1, files_total: 2,
    summary: "Machine scaffold", summary_provisional: true
  }] });
  assert.ok(text.includes("provisional — intent not authored"));
  assert.ok(!text.includes("Machine scaffold"));
});

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "proactive-persistence-reminder.mjs");

const runHook = (stdinText, env = {}) =>
  execFileSync(process.execPath, [SCRIPT], {
    input: stdinText,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });

// cwd を明示して .graphrag の無い場所に固定する (テスト実行 cwd がプラグイン repo だと
// 本物の delta-check が走ってしまう)。plainDir = .graphrag 無し。
const plainDir = mkdtempSync(path.join(tmpdir(), "ppr-plain-"));

const hookInput = (command, cwd = plainDir) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } });

const writeBackOnly = (out) => {
  const parsed = JSON.parse(out);
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
  assert.match(ctx, /^<graphrag write-back check, on commit boundary:/);
  assert.match(ctx, /deferred work — register it now as a Goal \(state: planned\)/, "「あとで」の書き込みトリガを含む");
  assert.ok(!ctx.includes("<graphrag delta check"), "vault の無い場所では delta 成分なし");
};

test("git commit を含むコマンドでリマインダ JSON を stdout に出す (vault 無し = 書き戻し促しのみ)", () => {
  writeBackOnly(runHook(hookInput('git commit -m "feat: 何か"')));
});

test("複合コマンド中の git commit も検出する", () => {
  writeBackOnly(runHook(hookInput("git add -A && git commit -m 'fix'")));
});

test("グローバルオプション介在 (git -C <dir> commit) も検出する", () => {
  writeBackOnly(runHook(hookInput("git -C /tmp/repo commit --amend")));
});

test("git commit を含まないコマンドでは何も出さない", () => {
  assert.equal(runHook(hookInput("git status && git diff")), "");
});

test("コミットメッセージ等のクォート内文字列には反応しない", () => {
  assert.equal(runHook(hookInput('echo "あとで git commit すること"')), "");
  assert.equal(runHook(hookInput("git log --grep 'git commit'")), "");
});

test("単語境界 — git commitlint / mygit commit には反応しない", () => {
  assert.equal(runHook(hookInput("git commitlint --edit")), "");
  assert.equal(runHook(hookInput("mygit commit -m x")), "");
});

test("tool_input.command が無い入力では何も出さない", () => {
  assert.equal(runHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: plainDir, tool_input: {} })), "");
  assert.equal(runHook(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } })), "");
});

test("不正な JSON 入力でも何も出さず exit 0 (非ブロッキング)", () => {
  assert.equal(runHook("not-json{{{"), "");
});

// --- delta-check 同乗 (スタブ CLI で DI) ---

const withGraphragRepo = (fn) => {
  const root = mkdtempSync(path.join(tmpdir(), "ppr-repo-"));
  try {
    mkdirSync(path.join(root, ".graphrag", "vault"), { recursive: true });
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const stubCli = (root, result) => {
  const stub = path.join(root, "stub-delta.mjs");
  writeFileSync(stub, `process.stdout.write(${JSON.stringify(JSON.stringify(result))});\n`);
  return stub;
};

test("delta-check が知識ヒットを返すと、見出しが write-back 促しの前に同乗する", () => {
  withGraphragRepo((root) => {
    const stub = stubCli(root, {
      status: "info",
      connected_knowledge: [
        {
          id: "constraint:s:one-authority",
          type: "Constraint",
          title: "権威は1箇所",
          headline: "状態集合を再実装しない",
          via: [{ edge: "constrains", path: "src/ui/table.tsx" }]
        }
      ],
      marker_findings: [],
      placement_findings: [],
      counts: { connected_overflow: 0 }
    });
    const out = runHook(hookInput("git commit -m x", root), { GRAPHRAG_DELTA_CHECK_CLI: stub });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /<graphrag delta check, knowledge wired to this diff>/);
    assert.match(ctx, /Constraint constraint:s:one-authority: 権威は1箇所 — 状態集合を再実装しない \(constrains src\/ui\/table\.tsx\)/);
    assert.match(ctx, /<graphrag write-back check/, "書き戻し促しも残る");
    assert.ok(ctx.indexOf("delta check") < ctx.indexOf("write-back check"), "読み → 書き戻しの順");
  });
});

test("delta-check が clean なら delta 成分なし (従来文言のみ) — 出力契約", () => {
  withGraphragRepo((root) => {
    const stub = stubCli(root, { status: "clean", connected_knowledge: [], marker_findings: [], placement_findings: [] });
    const out = runHook(hookInput("git commit -m x", root), { GRAPHRAG_DELTA_CHECK_CLI: stub });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes("<graphrag delta check"));
    assert.match(ctx, /^<graphrag write-back check/);
  });
});

test("delta-check の失敗 (壊れたスタブ) は無音で従来文言のみ — 非ブロッキング", () => {
  withGraphragRepo((root) => {
    const stub = path.join(root, "broken.mjs");
    writeFileSync(stub, "process.exit(3);\n");
    const out = runHook(hookInput("git commit -m x", root), { GRAPHRAG_DELTA_CHECK_CLI: stub });
    writeBackOnly(out);
  });
});

test("composeDeltaInjection: findings は detail を列挙し next_step は CLI へ誘導", () => {
  const text = composeDeltaInjection({
    status: "warn",
    connected_knowledge: [],
    marker_findings: [
      { detail: "src/a.ts:3 references decision:s:gone, which was deleted (301)." }
    ],
    placement_findings: [{ detail: "src/pay/x.ts sits inside the home directory of component:s:checkout." }],
    counts: {}
  });
  assert.match(text, /2 wiring finding\(s\)/);
  assert.match(text, /decision:s:gone/);
  assert.match(text, /run `delta-check` for per-finding next_step/);
});

test("composeDeltaInjection: null 契約 — clean / 空 findings は注入しない", () => {
  assert.equal(composeDeltaInjection({ status: "clean" }), null);
  assert.equal(composeDeltaInjection(null), null);
  assert.equal(
    composeDeltaInjection({ status: "warn", connected_knowledge: [], marker_findings: [], placement_findings: [], counts: {} }),
    null
  );
});

test("composeDeltaInjection: authority echo は権威の所在と追加行を添えて出す", () => {
  const text = composeDeltaInjection({
    status: "info",
    connected_knowledge: [],
    authority_echoes: [
      {
        alias: "zero_bytes",
        knowledge_id: "decision:s:error-status-authority",
        title: "エラー状態集合の権威は ERROR_STATUSES",
        authority_paths: ["shared/constants.ts"],
        occurrences: [{ path: "src/ui/SsdTable.tsx", line: 479, text: 'const DONE = ["verified", "zero_bytes"];' }]
      }
    ],
    marker_findings: [],
    placement_findings: [],
    counts: {}
  });
  assert.match(text, /authority echo/);
  assert.match(text, /"zero_bytes" belongs to decision:s:error-status-authority/);
  assert.match(text, /src\/ui\/SsdTable\.tsx:479/);
  assert.match(text, /use the authority instead/);
});

// --- レビュー指摘 #1: worktree 境界と -C スキップ ---

test("linked worktree (.git ファイル) では親 checkout の .graphrag に到達しない — 別ツリー検査の防止", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ppr-wt-"));
  try {
    mkdirSync(path.join(root, ".graphrag", "vault"), { recursive: true });
    const wt = path.join(root, "wt");
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    // 親 root には .graphrag があるが、worktree 側から hook を打つと delta 成分なし =
    // findRepoRoot が .git ファイル境界で止まる (壊れたスタブを渡し、呼ばれたら fail させる)
    const stub = path.join(root, "must-not-run.mjs");
    writeFileSync(stub, "process.exit(9);\n");
    const out = runHook(hookInput("git commit -m x", wt), { GRAPHRAG_DELTA_CHECK_CLI: stub });
    writeBackOnly(out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git -C <dir> commit は cwd と別の場所への commit — delta 成分をスキップして促しのみ", () => {
  withGraphragRepo((root) => {
    const stub = path.join(root, "must-not-run.mjs");
    writeFileSync(stub, "process.exit(9);\n");
    const out = runHook(hookInput("git -C /tmp/other-repo commit -m x", root), { GRAPHRAG_DELTA_CHECK_CLI: stub });
    writeBackOnly(out);
  });
});


// --- novelty damping (goal:hook-novelty-damping): 同一セッションで見せた見出しを畳む ---

const dampResult = () => ({
  status: "info",
  connected_knowledge: [
    { id: "constraint:s:c1", type: "Constraint", title: "C1", headline: "h1", via: [{ edge: "constrains", path: "a.ts" }] },
    { id: "decision:s:d1", type: "Decision", title: "D1", headline: "h2", via: [] },
    { id: "decision:s:d2", type: "Decision", state: "superseded", title: "D2", headline: "h3", via: [] }
  ],
  structure_summary: [
    { id: "component:s:x", type: "Component", title: "X", summary: "authored", files_in_scope: 1, files_total: 3 },
    { id: "layer:s:l", type: "Layer", title: "L", summary: "authored", files_in_scope: 1, files_total: 9 }
  ],
  authority_echoes: [{ alias: "TOKEN", knowledge_id: "decision:s:d1", title: "D1", authority_paths: ["a.ts"], occurrences: [{ path: "b.ts", line: 3, text: "TOKEN" }] }],
  marker_findings: [{ detail: "b.ts:1 references decision:s:gone (301)." }],
  placement_findings: [],
  counts: { connected_overflow: 0, structures_overflow: 0 }
});

test("damping: 初回は全件表示し、表示した見出しだけを shownNow に返す", () => {
  const r = composeDeltaInjectionWithSeen(dampResult(), new Map());
  assert.match(r.context, /3 registered knowledge node\(s\)/);
  assert.match(r.context, /Component X \(1\/3 files\)/);
  assert.deepEqual(r.damped, { knowledge: 0, structures: 0 });
  assert.deepEqual(r.shownNow.map((x) => x.id).sort(), ["component:s:x", "constraint:s:c1", "decision:s:d1", "decision:s:d2", "layer:s:l"]);
  assert.ok(r.shownNow.every((x) => /^[0-9a-f]{8}$/.test(x.s)), "キーは表示内容のハッシュ");
});

test("damping: 2 回目は既知の見出しを 1 行に畳み、所見と echo は畳まない", () => {
  const first = composeDeltaInjectionWithSeen(dampResult(), new Map());
  const shown = new Map(first.shownNow.map((x) => [x.id, x.s]));
  const second = composeDeltaInjectionWithSeen(dampResult(), shown);
  assert.ok(!second.context.includes("registered knowledge node(s) are wired"), "見出し本体は出ない");
  assert.ok(!second.context.includes("Component X (1/3 files)"), "構造行も出ない");
  assert.match(second.context, /3 knowledge headline\(s\) already shown earlier in this session, unchanged \(constraint:s:c1, decision:s:d1, decision:s:d2\)/);
  assert.match(second.context, /2 structure\(s\) already shown earlier in this session, unchanged/);
  assert.match(second.context, /1 authority echo\(es\)/, "echo は毎回");
  assert.match(second.context, /1 wiring finding\(s\)/, "所見は毎回");
  assert.deepEqual(second.damped, { knowledge: 3, structures: 2 });
  assert.deepEqual(second.shownNow, [], "畳んだものは再記録しない");
});

test("damping (F1): 表示内容が変わった見出しは再表示される (state / title / headline / provisional)", () => {
  const first = composeDeltaInjectionWithSeen(dampResult(), new Map());
  const shown = new Map(first.shownNow.map((x) => [x.id, x.s]));
  const changed = dampResult();
  changed.connected_knowledge[1].state = "superseded"; // d1 が superseded に
  changed.connected_knowledge[0].headline = "h1 — never bypass the gate"; // c1 の headline に禁止条件が追記された (state 同一)
  changed.structure_summary[0].summary_provisional = true; // X が provisional に戻った
  const r = composeDeltaInjectionWithSeen(changed, shown);
  assert.match(r.context, /2 registered knowledge node\(s\) are wired/);
  assert.match(r.context, /Decision \[superseded\] decision:s:d1/);
  assert.match(r.context, /constraint:s:c1: C1 — h1 — never bypass the gate/, "title/headline の更新は state 同一でも再表示");
  assert.match(r.context, /Component X .*provisional — intent not authored/);
  assert.match(r.context, /1 knowledge headline\(s\) already shown/);
  assert.match(r.context, /1 structure\(s\) already shown/);
  assert.deepEqual(r.shownNow.map((x) => x.id).sort(), ["component:s:x", "constraint:s:c1", "decision:s:d1"]);
  const again = composeDeltaInjectionWithSeen(changed, new Map([...shown, ...r.shownNow.map((x) => [x.id, x.s])]));
  assert.deepEqual(again.shownNow, [], "更新後の内容を記録すれば次は畳まれる");
});

test("damping (F2): 見出しが全て既知でも scope gaps と overflow の案内は毎回出る", () => {
  const first = composeDeltaInjectionWithSeen(dampResult(), new Map());
  const shown = new Map(first.shownNow.map((x) => [x.id, x.s]));
  const next = {
    ...dampResult(), authority_echoes: [], marker_findings: [],
    structure_coverage: { unregistered_count: 3, unframed_count: 1 },
    counts: { connected_overflow: 0, structures_overflow: 4 }
  };
  const r = composeDeltaInjectionWithSeen(next, shown);
  assert.match(r.context, /Scope gaps: 3 unregistered, 1 registered without structure/);
  assert.match(r.context, /\(\+4 more structures\)/);
  assert.ok(!r.context.includes("Component X (1/3 files)"), "見出し本体は畳まれたまま");
  assert.ok(!r.context.includes("Compare the change with the registered summaries"), "本文比較の指示は新規表示がある時だけ");
});

test("damping: cap で隠れた見出しは表示していないので記録しない", () => {
  const many = { status: "info", connected_knowledge: Array.from({ length: 14 }, (_, i) => ({ id: `decision:s:d${i}`, type: "Decision", title: `D${i}`, via: [] })), counts: {} };
  const r = composeDeltaInjectionWithSeen(many, new Map());
  assert.equal(r.shownNow.length, 10);
  assert.match(r.context, /\+4 more knowledge node\(s\) not shown here/);
});

test("damping (F4): 見出しが全て既知になっても、未表示の知識 (cap / connected_overflow) の存在は毎回出る", () => {
  const many = () => ({
    status: "info",
    connected_knowledge: Array.from({ length: 20 }, (_, i) => ({ id: `decision:s:d${String(i).padStart(2, "0")}`, type: "Decision", title: `D${i}`, via: [] })),
    counts: { connected_overflow: 3 }
  });
  const shown = new Map();
  const r1 = composeDeltaInjectionWithSeen(many(), shown);
  assert.equal(r1.shownNow.length, 10);
  assert.match(r1.context, /\+13 more knowledge node\(s\) not shown here/, "1 回目: 表示 cap 超過 10 + CLI 上限超過 3");
  for (const x of r1.shownNow) shown.set(x.id, x.s);
  const r2 = composeDeltaInjectionWithSeen(many(), shown);
  assert.equal(r2.shownNow.length, 10, "2 回目: 残り 10 件が表示される");
  assert.match(r2.context, /\+3 more knowledge node\(s\) not shown here/);
  for (const x of r2.shownNow) shown.set(x.id, x.s);
  const r3 = composeDeltaInjectionWithSeen(many(), shown);
  assert.equal(r3.shownNow.length, 0);
  assert.match(r3.context, /20 knowledge headline\(s\) already shown/);
  assert.match(r3.context, /\+3 more knowledge node\(s\) not shown here/, "3 回目: 全て既知でも CLI 上限で一度も出ていない 3 件の存在は消えない");
});

test("damping: 全て既知で所見も echo も無ければ「既知・変化なし」の行だけになる", () => {
  const only = { status: "info", connected_knowledge: [{ id: "decision:s:d1", type: "Decision", title: "D1", via: [] }], counts: {} };
  const first = composeDeltaInjectionWithSeen(only, new Map());
  const r = composeDeltaInjectionWithSeen(only, new Map(first.shownNow.map((x) => [x.id, x.s])));
  const body = r.context.split("\n").slice(1, -1);
  assert.equal(body.length, 1);
  assert.match(body[0], /1 knowledge headline\(s\) already shown earlier in this session, unchanged/);
});

const hookInputSession = (command, cwd, session_id) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, session_id, tool_input: { command } });

test("rail-shared (F3): k:commit は consumer 側 cache に vault identity 付きで記録され、他 kind/壊れた行と同居できる", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ppr-seen-"));
  try {
    const cacheDir = consumerCacheDir(root);
    const vA = vaultKey("/ext/vault-a");
    const vB = vaultKey("/ext/vault-b");
    assert.equal(cacheDir, path.join(root, ".graphrag", "cache"));
    assert.equal(loadCommitShown(cacheDir, "s1", vA).size, 0);
    assert.ok(appendCommitShown(cacheDir, "s1", vA, [{ id: "decision:s:a", s: hash32("x") }, { id: "component:s:x", s: hash32("y") }]));
    const fp = path.join(cacheDir, "rail-seen-s1.jsonl");
    writeFileSync(fp, readFileSync(fp, "utf8") + '{"k":"node","id":"decision:s:zzz"}\n{broken\n');
    assert.deepEqual([...loadCommitShown(cacheDir, "s1", vA).keys()].sort(), ["component:s:x", "decision:s:a"]);
    assert.equal(loadCommitShown(cacheDir, "s1", vB).size, 0, "vault を切り替えると既読を継承しない");
    assert.equal(loadCommitShown(cacheDir, "s2", vA).size, 0, "セッション別");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook 統合 (F3): 同じ外部 vault を読む 2 つの worktree は互いの表示を畳まず、vault 側には書かない", () => {
  const ext = mkdtempSync(path.join(tmpdir(), "ppr-ext-vault-"));
  const w1 = mkdtempSync(path.join(tmpdir(), "ppr-w1-"));
  const w2 = mkdtempSync(path.join(tmpdir(), "ppr-w2-"));
  try {
    mkdirSync(path.join(ext, "vault"), { recursive: true });
    for (const w of [w1, w2]) {
      mkdirSync(path.join(w, ".graphrag"), { recursive: true });
      // 外部 vault を readonly で参照する consumer (.graphrag/.env のみ、vault/ は持たない)
      writeFileSync(path.join(w, ".graphrag", ".env"), `GRAPHRAG_VAULT_DIR=${path.join(ext, "vault")}\nGRAPHRAG_VAULT_MODE=readonly\n`);
    }
    const result = { status: "info", connected_knowledge: [{ id: "constraint:s:one", type: "Constraint", title: "One", via: [] }], marker_findings: [], placement_findings: [], counts: {} };
    const stub = path.join(w1, "stub.mjs");
    writeFileSync(stub, `process.stdout.write(${JSON.stringify(JSON.stringify(result))});\n`);
    const env = { GRAPHRAG_DELTA_CHECK_CLI: stub };
    const c1 = JSON.parse(runHook(hookInputSession("git commit -m a", w1, "sess-X"), env)).hookSpecificOutput.additionalContext;
    assert.match(c1, /constraint:s:one: One/);
    const c2 = JSON.parse(runHook(hookInputSession("git commit -m b", w2, "sess-X"), env)).hookSpecificOutput.additionalContext;
    assert.match(c2, /constraint:s:one: One/, "別 worktree は w1 の既読を引き継がない");
    const c1b = JSON.parse(runHook(hookInputSession("git commit -m c", w1, "sess-X"), env)).hookSpecificOutput.additionalContext;
    assert.match(c1b, /already shown earlier in this session/, "同じ worktree の 2 回目は畳む");
    assert.ok(existsSync(path.join(w1, ".graphrag", "cache", "rail-seen-sess-X.jsonl")), "記録は consumer 側");
    assert.ok(!existsSync(path.join(ext, "cache")) && !existsSync(path.join(ext, ".graphrag")), "外部 vault 側には何も書かない");
  } finally {
    for (const d of [ext, w1, w2]) rmSync(d, { recursive: true, force: true });
  }
});

test("hook 統合: 同一セッションの 2 回目の commit は見出しを畳み、別セッション/セッション無しは全件", () => {
  withGraphragRepo((root) => {
    const stub = stubCli(root, {
      status: "info",
      connected_knowledge: [{ id: "constraint:s:one", type: "Constraint", title: "One", headline: "h", via: [{ edge: "constrains", path: "a.ts" }] }],
      structure_summary: [{ id: "component:s:x", type: "Component", title: "X", summary: "authored", files_in_scope: 1, files_total: 2 }],
      marker_findings: [], placement_findings: [], counts: {}
    });
    const env = { GRAPHRAG_DELTA_CHECK_CLI: stub };
    const ctx1 = JSON.parse(runHook(hookInputSession("git commit -m a", root, "sess-A"), env)).hookSpecificOutput.additionalContext;
    assert.match(ctx1, /Constraint constraint:s:one: One/);
    assert.match(ctx1, /Component X \(1\/2 files\)/);
    const ctx2 = JSON.parse(runHook(hookInputSession("git commit -m b", root, "sess-A"), env)).hookSpecificOutput.additionalContext;
    assert.ok(!ctx2.includes("constraint:s:one: One"), "2 回目は見出し本体を出さない");
    assert.match(ctx2, /1 knowledge headline\(s\) already shown earlier in this session/);
    assert.match(ctx2, /1 structure\(s\) already shown earlier in this session/);
    assert.match(ctx2, /<graphrag write-back check/, "書き戻し促しは毎回");
    const ctx3 = JSON.parse(runHook(hookInputSession("git commit -m c", root, "sess-B"), env)).hookSpecificOutput.additionalContext;
    assert.match(ctx3, /Constraint constraint:s:one: One/, "別セッションは全件");
    const ctx4 = JSON.parse(runHook(hookInput("git commit -m d", root), env)).hookSpecificOutput.additionalContext;
    assert.match(ctx4, /Constraint constraint:s:one: One/, "session id 無しは畳まない");
    const seen = readFileSync(path.join(root, ".graphrag", "cache", "rail-seen-sess-A.jsonl"), "utf8");
    assert.equal(seen.split("\n").filter((l) => l.includes('"commit"')).length, 2, "1 回目に表示した 2 件だけ記録");
    const log = readFileSync(path.join(root, ".graphrag", "cache", "rail-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const commitLogs = log.filter((e) => e.rail === "commit");
    assert.equal(commitLogs.length, 4);
    assert.equal(commitLogs[0].shown, 2);
    assert.equal(commitLogs[1].damped_knowledge, 1);
    assert.equal(commitLogs[1].damped_structures, 1);
    assert.ok(existsSync(path.join(root, ".graphrag", "cache")));
  });
});

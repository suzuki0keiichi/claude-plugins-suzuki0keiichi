// proactive-persistence-reminder.mjs の単体テスト。
// 実行: node --test hooks/proactive-persistence-reminder.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeDeltaInjection } from "./proactive-persistence-reminder.mjs";

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

// frame-map.mjs の単体テスト。
// 実行: node --test hooks/frame-map.test.mjs
// 方針: ゲート (Write 以外 / 非実装 / 更新 / anchor 無し) は無音、
// 注入は「見せる地図がある時だけ」。CLI 呼び出しは GRAPHRAG_FRAME_MAP_CLI で stub に差し替える。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeInjection } from "./frame-map.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "frame-map.mjs");

const runHook = (input, env = {}) =>
  execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, GRAPHRAG_VAULT_DIR: "", GRAPHRAG_FRAME_MAP_CLI: "", ...env }
  });

const makeRepo = () => {
  const root = mkdtempSync(path.join(tmpdir(), "graphrag-frame-"));
  mkdirSync(path.join(root, ".graphrag", "vault"), { recursive: true });
  return root;
};

// 固定 JSON を吐く stub CLI (frame-check の代役)。
const makeStub = (root, result) => {
  const stub = path.join(root, "stub-frame-check.mjs");
  writeFileSync(stub, `process.stdout.write(${JSON.stringify(JSON.stringify(result))});\n`);
  return stub;
};

const writeInput = (filePath, toolResponse = "File created successfully") => ({
  tool_name: "Write",
  tool_input: { file_path: filePath },
  tool_response: toolResponse
});

// ── composeInjection (純関数) ────────────────────────────────────────────────

const UNWIRED_RESULT = {
  entries: [
    {
      path: "src/pay/discount.ts",
      status: "unwired",
      claimants: [{ id: "component:s:checkout", title: "決済", dir_members: 2 }]
    }
  ],
  findings: [
    {
      kind: "in-footprint-unwired",
      severity: "warn",
      file_path: "src/pay/discount.ts",
      detail: "d",
      next_step: "n"
    }
  ]
};

test("composeInjection: unwired は『配線するか・動かすか・免除か』の三択を注入する", () => {
  const text = composeInjection(UNWIRED_RESULT, "src/pay/discount.ts");
  assert.ok(text);
  assert.match(text, /home directory of component:s:checkout/);
  assert.match(text, /wire it|move it|exempt/);
});

test("composeInjection: claimant 複数 (フラット配置) は非難なしの局所地図を注入する", () => {
  const result = {
    entries: [
      {
        path: "lib/new.ts",
        status: "unclaimed",
        claimants: [
          { id: "component:s:x", title: "X", dir_members: 3 },
          { id: "component:s:y", title: "Y", dir_members: 1 }
        ]
      }
    ],
    findings: []
  };
  const text = composeInjection(result, "lib/new.ts");
  assert.ok(text);
  assert.match(text, /Local map for lib\/new\.ts/);
  assert.match(text, /component:s:x "X" \(3 files here\)/);
  assert.ok(!/wrong place|violation/i.test(text), "非難の語彙を使わない");
});

test("composeInjection: 無所属で周りに構造も無ければ null (無所属は正当 — 無音)", () => {
  const result = { entries: [{ path: "scripts/x.ts", status: "unclaimed", claimants: [] }], findings: [] };
  assert.equal(composeInjection(result, "scripts/x.ts"), null);
});

test("composeInjection: registered / exempt / non-impl は null", () => {
  for (const status of ["registered", "exempt", "non-impl"]) {
    const result = { entries: [{ path: "a.ts", status, claimants: [{ id: "c", title: "t", dir_members: 1 }] }], findings: [] };
    assert.equal(composeInjection(result, "a.ts"), null, status);
  }
});

test("composeInjection: component-candidate は『生まれたがっている』合図を注入する", () => {
  const result = {
    entries: [{ path: "scripts/e.ts", status: "unclaimed", claimants: [] }],
    findings: [
      { kind: "component-candidate", severity: "warn", dir: "scripts", detail: "scripts/ now holds 5 ...", next_step: "register or exempt" }
    ]
  };
  const text = composeInjection(result, "scripts/e.ts");
  assert.ok(text);
  assert.match(text, /now holds 5/);
});

// ── E2E: ゲート (全て無音で正常終了) ─────────────────────────────────────────

test("gate: Write 以外 / 非実装ファイル / 更新 (created でない) は無音", () => {
  const root = makeRepo();
  try {
    const f = path.join(root, "src", "a.ts");
    assert.equal(runHook({ tool_name: "Edit", tool_input: { file_path: f } }), "");
    assert.equal(runHook(writeInput(path.join(root, "README.md"))), "");
    assert.equal(runHook(writeInput(f, "The file has been updated")), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: .graphrag anchor が祖先に無ければ無音 (非 graphrag リポジトリでは何もしない)", () => {
  const noAnchor = mkdtempSync(path.join(tmpdir(), "plain-repo-"));
  try {
    assert.equal(runHook(writeInput(path.join(noAnchor, "src", "a.ts"))), "");
  } finally {
    rmSync(noAnchor, { recursive: true, force: true });
  }
});

// ── E2E: stub CLI 経由の注入 ─────────────────────────────────────────────────

test("E2E: unwired の新規 Write に additionalContext を注入する (relPath は POSIX で CLI に渡る)", () => {
  const root = makeRepo();
  try {
    const stub = makeStub(root, UNWIRED_RESULT);
    const out = runHook(writeInput(path.join(root, "src", "pay", "discount.ts")), {
      GRAPHRAG_FRAME_MAP_CLI: stub
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(parsed.hookSpecificOutput.additionalContext, /graphrag frame map/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /component:s:checkout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E2E: 見せる地図が無い結果 (claimant 無し・所見無し) は注入しない", () => {
  const root = makeRepo();
  try {
    const stub = makeStub(root, {
      entries: [{ path: "src/pay/discount.ts", status: "unclaimed", claimants: [] }],
      findings: []
    });
    const out = runHook(writeInput(path.join(root, "src", "pay", "discount.ts")), {
      GRAPHRAG_FRAME_MAP_CLI: stub
    });
    assert.equal(out, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E2E: CLI が壊れた JSON を返しても無音で正常終了 (非ブロッキング)", () => {
  const root = makeRepo();
  try {
    const stub = path.join(root, "broken.mjs");
    writeFileSync(stub, "process.stdout.write('not json');\n");
    const out = runHook(writeInput(path.join(root, "src", "a.ts")), { GRAPHRAG_FRAME_MAP_CLI: stub });
    assert.equal(out, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

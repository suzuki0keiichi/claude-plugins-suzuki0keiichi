import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import {
  constraintCheck,
  ENFORCES_MARKER_RE,
  skipLineFingerprint,
  type ConstraintCheckDeps,
  type MarkerHit
} from "./constraint-check.ts";

// 合成 graph → 本物の vault ファイルに書いてから読む (staleness-check.test と同じ経路忠実主義)。
function writeVaultFromGraph(graph: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "grag-constraint-vault-"));
  for (const f of buildVaultFiles(graph as any)) {
    const abs = path.join(dir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return dir;
}

// 合成 repo: 実在ファイル集合と内容を DI で固定 (ディスク・git 不要)。
function fakeRepo(files: Record<string, string>, markers: MarkerHit[] = []): ConstraintCheckDeps {
  return {
    fileExists: (_root, rel) => rel in files,
    readFile: (_root, rel) => {
      if (!(rel in files)) throw new Error(`ENOENT: ${rel}`);
      return files[rel];
    },
    grepMarkers: () => markers
  };
}

// マーカー文字列は実行時に組み立てる: ソースリテラルに `graphrag:enforces <有効id>` を置くと、
// この repo 自身の constraint-check (defaultGrepMarkers の git grep) がテストフィクスチャを
// 実マーカーとして拾い、恒久的な orphan-marker ノイズになる (${""} でトークンと id を分断)。
const marker = (id: string) => `// graphrag:enforces ${""}${id}`;
const MARKER = marker("constraint:sys:no-sync-io");

function baseGraph(extraNodes: any[] = [], extraEdges: any[] = []) {
  return {
    nodes: [
      { id: "file:sys:src/pay.ts", type: "File", title: "pay", path: "src/pay.ts", summary: "決済" },
      { id: "file:sys:test/pay-io.test.ts", type: "File", title: "pay-io.test", path: "test/pay-io.test.ts", summary: "検査" },
      { id: "constraint:sys:no-sync-io", type: "Constraint", title: "決済経路で同期 IO 禁止", summary: "要約" },
      ...extraNodes
    ],
    edges: [
      { id: "e-c1", type: "constrains", from: "constraint:sys:no-sync-io", to: "file:sys:src/pay.ts" },
      { id: "e-e1", type: "enforced_by", from: "constraint:sys:no-sync-io", to: "file:sys:test/pay-io.test.ts" },
      ...extraEdges
    ]
  };
}

test("配線が健全 (enforcer 実在 + マーカー有り) なら status ok / findings 空", () => {
  const vault = writeVaultFromGraph(baseGraph());
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo(
      { "test/pay-io.test.ts": `${MARKER}\ntest("sync io", () => {});\n` },
      [{ path: "test/pay-io.test.ts", line: 1, constraintId: "constraint:sys:no-sync-io" }]
    )
  );
  assert.equal(res.status, "ok");
  assert.equal(res.findings.length, 0);
  assert.deepEqual(res.constraints, { total: 1, enforced: 1, unenforceable: 0, unguarded: 0 });
});

test("unguarded: enforced_by も enforcement:none も無い Constraint は warn + 処方 + plan_fragment", () => {
  const vault = writeVaultFromGraph(
    baseGraph([{ id: "constraint:sys:lonely", type: "Constraint", title: "誰も守らない", summary: "要約" }])
  );
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": `${MARKER}\n` })
  );
  const f = res.findings.find((x) => x.kind === "unguarded");
  assert.ok(f, "unguarded finding が要る");
  assert.equal(f!.severity, "warn");
  assert.equal(f!.constraint_id, "constraint:sys:lonely");
  // 何が駄目か + どうしたら良いかが利用エージェントに分かる (処方の実質検査)
  assert.match(f!.detail, /no mechanical consumer/);
  assert.ok(f!.next_step.includes(`graphrag:enforces ${""}constraint:sys:lonely`), "マーカー追記の処方が要る");
  assert.match(f!.next_step, /--unenforceable|enforcement:"none"/);
  const frag: any = f!.plan_fragment;
  assert.equal(frag.edges[0].type, "enforced_by");
  assert.equal(frag.edges[0].from, "constraint:sys:lonely");
  assert.equal(res.constraints.unguarded, 1);
  assert.equal(res.status, "warn");
});

test("unenforceable (理由付き) は finding にしない / 理由無しは warn", () => {
  const vault = writeVaultFromGraph(
    baseGraph([
      { id: "constraint:sys:gdpr", type: "Constraint", title: "GDPR", summary: "要約", enforcement: "none", enforcement_reason: "法規要件はテストで表現できない" },
      { id: "constraint:sys:mute", type: "Constraint", title: "理由無し", summary: "要約", enforcement: "none" }
    ])
  );
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": `${MARKER}\n` })
  );
  assert.equal(res.constraints.unenforceable, 2);
  assert.ok(!res.findings.some((f) => f.constraint_id === "constraint:sys:gdpr"), "理由付き宣言は黙認");
  const f = res.findings.find((x) => x.kind === "unenforceable-no-reason");
  assert.equal(f?.constraint_id, "constraint:sys:mute");
  assert.match(f!.next_step, /enforcement_reason/);
});

test("enforcer-missing: 宛先検査ファイルがディスクに無ければ error (status も error)", () => {
  const vault = writeVaultFromGraph(baseGraph());
  const res = constraintCheck({ vaultDir: vault, root: "/repo" }, fakeRepo({}));
  const f = res.findings.find((x) => x.kind === "enforcer-missing");
  assert.ok(f);
  assert.equal(f!.severity, "error");
  assert.equal(f!.file_path, "test/pay-io.test.ts");
  assert.match(f!.detail, /does not exist on disk/);
  assert.match(f!.next_step, /re-wire|restore/i);
  assert.equal(res.status, "error");
});

test("enforcer-skipped: skip マーカー (it.skip / @Disabled 等) は warn + 行番号", () => {
  const vault = writeVaultFromGraph(baseGraph());
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": `${MARKER}\nit.skip("sync io guard", () => {});\n` })
  );
  const f = res.findings.find((x) => x.kind === "enforcer-skipped");
  assert.ok(f);
  assert.equal(f!.line, 2);
  assert.match(f!.detail, /it\/test\/describe\.skip/);
  assert.match(f!.next_step, /un-skip|unrelated/i);
});

function skippedFinding(body: string) {
  const vault = writeVaultFromGraph(baseGraph());
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": `${MARKER}\n${body}\n` })
  );
  return res.findings.find((x) => x.kind === "enforcer-skipped");
}

test("enforcer-skipped: 条件付き skip (三項演算子の参照 / チェーン / skipIf・runIf) も拾う (issue #47)", () => {
  const cases: [string, RegExp][] = [
    [`const describeX = cond ? describe.skip : describe;`, /it\/test\/describe\.skip/],
    [`(cond ? describe.skip : describe)("x", () => {});`, /it\/test\/describe\.skip/],
    [`it.skip.each([1, 2])("x %i", () => {});`, /it\/test\/describe\.skip/],
    [`test.concurrent.skip("x", () => {});`, /it\/test\/describe\.skip/],
    [`describe.skipIf(cond)("x", () => {});`, /skipIf\/runIf/],
    [`it.skipIf(cond)("x", () => {});`, /skipIf\/runIf/],
    [`describe.runIf(!cond)("x", () => {});`, /skipIf\/runIf/],
    [`  t.Skipf("needs %s", os)`, /Skipf\/SkipNow \(Go\)/],
    [`  t.SkipNow()`, /Skipf\/SkipNow \(Go\)/],
    [`    pytest.skip("windows only")`, /pytest\.skip\(\)/],
    // issue #48
    [`    t.skip("root cannot reproduce EACCES");`, /t\.skip\/t\.todo \(node:test\)/],
    [`  t.todo("later");`, /t\.skip\/t\.todo \(node:test\)/],
    [`  context.todo("later");`, /test\.todo/],
    [`@DisabledOnOs(OS.WINDOWS)`, /conditional \(JUnit5\)/],
    [`@EnabledIfEnvironmentVariable(named = "CI", matches = "true")`, /conditional \(JUnit5\)/],
    [`#[cfg_attr(windows, ignore)]`, /cfg_attr\(\.\.\., ignore\)/],
    [`#[cfg_attr(windows, ignore = "flaky on windows")]`, /cfg_attr\(\.\.\., ignore\)/],
    [`describe.only("focus", () => {});`, /\.only \(exclusive selection/]
  ];
  for (const [body, label] of cases) {
    const f = skippedFinding(body);
    assert.ok(f, `should detect: ${body}`);
    assert.equal(f!.line, 2, body);
    assert.match(f!.detail, label, body);
  }
});

test("enforcer-skipped: テスト API 以外の .skip / .skipIf は拾わない", () => {
  for (const body of [
    `audit.skip();`,
    `obj.skipIf(cond);`,
    `reader.runIf(ready);`,
    `const opts = { skipEmpty: true };`,
    `describe("skipping rules", () => {});`,
    // { skip: cond } options は行単位で本体内オブジェクトと区別できないので拾わない (issue #48 で見送り)
    `test("x", { skip: process.platform === "win32" }, () => {});`,
    `test("x", () => { const config = { skip: true }; });`,
    `#[cfg_attr(feature = "ignore", allow(dead_code))]`,
    `#[cfg_attr(any(unix, ignore), allow(dead_code))]`,
    `@EnabledFeature("x")`,
    `const rows = query.only(1);`
  ]) {
    assert.equal(skippedFinding(body), undefined, `should not detect: ${body}`);
  }
});

const ackLine = (code: string, reason = "root 実行時だけの環境条件") =>
  `${code} // graphrag:skip-unrelated ${skipLineFingerprint(code)} ${reason}`;

test("enforcer-skipped: 同じ行の graphrag:skip-unrelated <fingerprint> <理由> で確認済み — 新しい skip 行は再び warn (issue #48)", () => {
  const acked = ackLine(`  t.skip("root only");`);
  const vault = writeVaultFromGraph(baseGraph());
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": `${MARKER}\n${acked}\n` })
  );
  assert.equal(res.findings.find((x) => x.kind === "enforcer-skipped"), undefined);
  assert.deepEqual(res.acknowledged_skips, [
    { path: "test/pay-io.test.ts", line: 2, label: "t.skip/t.todo (node:test)", reason: "root 実行時だけの環境条件" }
  ]);

  const f = skippedFinding(`${acked}\nit.skip("new skip", () => {});`);
  assert.ok(f);
  assert.equal(f!.line, 3);
  assert.doesNotMatch(f!.detail, /root only/);
  assert.match(f!.detail, /1 other skip line\(s\) are acknowledged/);
  const fp = skipLineFingerprint(`it.skip("new skip", () => {});`);
  assert.match(f!.next_step, new RegExp(`L3 \`graphrag:skip-unrelated ${fp} <reason>\``));
});

test("enforcer-skipped: 確認後に同じ行の条件を書き換えたり skip を足したりすると stale として再び warn", () => {
  const acked = ackLine(`it.skipIf(isWindows)("x", () => {});`);
  const changed = acked.replace("isWindows", "isLinux");
  const f = skippedFinding(changed);
  assert.ok(f);
  assert.match(f!.detail, /stale graphrag:skip-unrelated/);
  assert.ok(skippedFinding(acked.replace(`it.skipIf`, `it.skip("y"); it.skipIf`)));
});

test("enforcer-skipped: 理由の無い印・文字列内の印・別の行の印では確認済みにならない", () => {
  const code = `  t.skip("x");`;
  const fp = skipLineFingerprint(code);
  assert.ok(skippedFinding(`${code} // graphrag:skip-unrelated ${fp}`));
  assert.ok(skippedFinding(`  t.skip("graphrag:skip-unrelated ${fp} hidden in a string");`));
  assert.ok(skippedFinding(`// graphrag:skip-unrelated ${fp} reason on the previous line\n${code}`));
});

test("enforcer-skipped: ブロックコメントの印は無効 — 印の後ろに足した skip が fingerprint から漏れない", () => {
  const code = `t.skip("unrelated");`;
  const blockAck = `${code} /* graphrag:skip-unrelated ${skipLineFingerprint(code)} unrelated */`;
  assert.ok(skippedFinding(blockAck));
  const f = skippedFinding(`${blockAck} it.skip("actual invariant", () => {});`);
  assert.ok(f);
  assert.match(f!.detail, /actual invariant/);
  // 印が行コメント記号の直後でない (/* note 印 …) なら、引用符でコメント末尾を隠しても受理しない
  const tricky = `t.skip("unrelated"); /* note graphrag:skip-unrelated ${skipLineFingerprint(`t.skip("unrelated"); /* note `)} "reason */ it.skip('actual invariant', () => {}); //"`;
  assert.ok(skippedFinding(tricky));
  // コメント記号の無い印も受理しない
  assert.ok(skippedFinding(`${code} graphrag:skip-unrelated ${skipLineFingerprint(code)} unrelated`));
});

test("enforcer-skipped: .only は確認済みにできない (その行のテスト自身は走り、別の enforcer を止め得る)", () => {
  const f = skippedFinding(ackLine(`describe.only("focus", () => {});`, "無関係"));
  assert.ok(f);
  assert.match(f!.detail, /\.only/);
  assert.match(f!.next_step, /Remove the \.only \(L2\).*neither acknowledged nor covered/);
  // .only だけの finding に確認済みの印や代替の登記は案内しない (自己矛盾した処方にしない)
  assert.doesNotMatch(f!.next_step, /graphrag:skip-unrelated|register another enforcer/);
});

test("enforcer-skipped: CRLF の行でも graphrag:skip-unrelated が LF と同じに読まれ、行の変更で stale になる (issue #49)", () => {
  const code = `  t.skip("root only");`;
  const acked = ackLine(code);
  const crlfVault = writeVaultFromGraph(baseGraph());
  const run = (content: string) =>
    constraintCheck({ vaultDir: crlfVault, root: "/repo" }, fakeRepo({ "test/pay-io.test.ts": content }));
  const lf = run(`${MARKER}\n${acked}\n`);
  const crlf = run(`${MARKER}\r\n${acked}\r\n`);
  const acked2 = ackLine(`  t.skip("non-root only");`);
  const mixed = run(`${MARKER}\n${acked}\r\n${acked2}\n`);
  assert.equal(lf.status, "ok");
  assert.equal(crlf.status, "ok");
  assert.deepEqual(crlf.acknowledged_skips, lf.acknowledged_skips);
  assert.equal(mixed.status, "ok");
  assert.deepEqual(mixed.acknowledged_skips.map((s) => s.line), [2, 3]);
  // 印として無効な形は CRLF でも無効のまま (理由なし・文字列内・ブロックコメント)
  const fp = skipLineFingerprint(code);
  for (const bad of [
    `${code} // graphrag:skip-unrelated ${fp}`,
    `  t.skip("graphrag:skip-unrelated ${fp} hidden in a string");`,
    `${code} /* graphrag:skip-unrelated ${fp} unrelated */`
  ]) {
    assert.ok(run(`${MARKER}\r\n${bad}\r\n`).findings.some((x) => x.kind === "enforcer-skipped"), bad);
  }
  const stale = run(`${MARKER}\r\n${acked.replace("root only", "root-only")}\r\n`);
  assert.match(stale.findings.find((x) => x.kind === "enforcer-skipped")!.detail, /stale graphrag:skip-unrelated/);
  // .only は CRLF でも免除できない
  assert.ok(run(`${MARKER}\r\n${ackLine(`describe.only("focus", () => {});`, "無関係")}\r\n`).findings.some((x) => x.kind === "enforcer-skipped"));
});

// 判定単位は Constraint (issue #49): 同じ制約に enforcer を 2 本 (pay-io = skip あり, pay-alt = 代替) 登記する。
function twoEnforcerGraph(altNodes: any[] = []) {
  return baseGraph(
    [{ id: "file:sys:test/pay-alt.test.ts", type: "File", title: "pay-alt.test", path: "test/pay-alt.test.ts", summary: "代替検査" }, ...altNodes],
    [{ id: "e-e2", type: "enforced_by", from: "constraint:sys:no-sync-io", to: "file:sys:test/pay-alt.test.ts" }]
  );
}
const SKIPPED = `${MARKER}\nit.skipIf(isWindows)("sync io guard", () => {});\n`;
const CLEAN_ALT = `${MARKER}\nit("sync io guard (injected)", () => {});\n`;

test("enforcer-skipped: 未確認 skip の無い代替 enforcer が登記されていれば warn にせず covered_skips に出す (issue #49)", () => {
  const res = constraintCheck(
    { vaultDir: writeVaultFromGraph(twoEnforcerGraph()), root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": SKIPPED, "test/pay-alt.test.ts": CLEAN_ALT })
  );
  assert.equal(res.status, "ok");
  assert.deepEqual(res.covered_skips, [
    {
      constraint_id: "constraint:sys:no-sync-io",
      path: "test/pay-io.test.ts",
      line: 2,
      label: "skipIf/runIf (conditional)",
      covered_by: ["test/pay-alt.test.ts"]
    }
  ]);
  assert.deepEqual(res.acknowledged_skips, []);
});

test("enforcer-skipped: 守り手の全てに skip があれば各ファイルで warn し、next_step で代替の登記を案内する", () => {
  const res = constraintCheck(
    { vaultDir: writeVaultFromGraph(twoEnforcerGraph()), root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": SKIPPED, "test/pay-alt.test.ts": `${MARKER}\nit.skipIf(isLinux)("x", () => {});\n` })
  );
  const skipped = res.findings.filter((x) => x.kind === "enforcer-skipped");
  assert.deepEqual(skipped.map((x) => x.file_path).sort(), ["test/pay-alt.test.ts", "test/pay-io.test.ts"]);
  assert.match(skipped[0].next_step, /register another enforcer that checks this constraint without a skip/);
  assert.deepEqual(res.covered_skips, []);
});

test("enforcer-skipped: マーカーの無い / ディスクに無い / 読めない代替は数えず、その診断も消さない", () => {
  const vault = writeVaultFromGraph(twoEnforcerGraph());
  const noMarker = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": SKIPPED, "test/pay-alt.test.ts": `it("x", () => {});\n` })
  );
  assert.ok(noMarker.findings.some((x) => x.kind === "enforcer-skipped" && x.file_path === "test/pay-io.test.ts"));
  assert.ok(noMarker.findings.some((x) => x.kind === "marker-missing" && x.file_path === "test/pay-alt.test.ts"));

  const missing = constraintCheck({ vaultDir: vault, root: "/repo" }, fakeRepo({ "test/pay-io.test.ts": SKIPPED }));
  assert.ok(missing.findings.some((x) => x.kind === "enforcer-skipped"));
  assert.ok(missing.findings.some((x) => x.kind === "enforcer-missing" && x.file_path === "test/pay-alt.test.ts"));

  const unreadable = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    { ...fakeRepo({ "test/pay-io.test.ts": SKIPPED }), fileExists: () => true }
  );
  assert.ok(unreadable.findings.some((x) => x.kind === "enforcer-skipped"));
  assert.ok(unreadable.findings.some((x) => x.kind === "enforcer-missing" && /cannot be read/.test(x.detail)));
  for (const res of [noMarker, missing, unreadable]) assert.deepEqual(res.covered_skips, []);
});

test("enforcer-skipped: .only を持つ制約では代替があっても何も covered にしない (別ファイルの代替ごと止め得る)", () => {
  const vault = writeVaultFromGraph(twoEnforcerGraph());
  const sameFile = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({
      "test/pay-io.test.ts": `${MARKER}\ndescribe.only("focus", () => {});\nit.skipIf(isWindows)("x", () => {});\n`,
      "test/pay-alt.test.ts": CLEAN_ALT
    })
  );
  const f = sameFile.findings.find((x) => x.kind === "enforcer-skipped");
  assert.ok(f);
  assert.match(f!.detail, /L2 \.only.*L3 skipIf/);
  assert.match(f!.next_step, /Remove the \.only \(L2\)/);
  assert.match(f!.next_step, /L3 `graphrag:skip-unrelated [0-9a-f]{8} <reason>`/);
  assert.deepEqual(sameFile.covered_skips, []);

  // 代替側に .only: 代替は clean でなく、skip した側も warn のまま
  const inAlt = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": SKIPPED, "test/pay-alt.test.ts": `${MARKER}\ndescribe.only("focus", () => {});\n` })
  );
  assert.deepEqual(inAlt.findings.filter((x) => x.kind === "enforcer-skipped").map((x) => x.file_path).sort(), [
    "test/pay-alt.test.ts",
    "test/pay-io.test.ts"
  ]);
  assert.deepEqual(inAlt.covered_skips, []);

  // 3 本目の enforcer に .only: clean な代替があっても covered にしない
  const graph = twoEnforcerGraph([
    { id: "file:sys:test/pay-third.test.ts", type: "File", title: "pay-third.test", path: "test/pay-third.test.ts", summary: "検査" }
  ]);
  graph.edges.push({ id: "e-e4", type: "enforced_by", from: "constraint:sys:no-sync-io", to: "file:sys:test/pay-third.test.ts" });
  const third = constraintCheck(
    { vaultDir: writeVaultFromGraph(graph), root: "/repo" },
    fakeRepo({
      "test/pay-io.test.ts": SKIPPED,
      "test/pay-alt.test.ts": CLEAN_ALT,
      "test/pay-third.test.ts": `${MARKER}\nit.only("focus", () => {});\n`
    })
  );
  const ioF = third.findings.find((x) => x.kind === "enforcer-skipped" && x.file_path === "test/pay-io.test.ts");
  assert.ok(ioF);
  // 別ファイルの .only が残る間は代替の登記で解消しないので、先に .only を案内し、代替の登記は案内しない
  assert.match(ioF!.next_step, /Another enforcer of this constraint has \.only \(test\/pay-third\.test\.ts L2\)/);
  assert.doesNotMatch(ioF!.next_step, /register another enforcer/);
  assert.deepEqual(third.covered_skips, []);
});

test("enforcer-skipped: stale な印の代替は clean でなく、確認済みだけの代替は clean (acknowledged と covered は混ざらない)", () => {
  const vault = writeVaultFromGraph(twoEnforcerGraph());
  const staleAlt = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({
      "test/pay-io.test.ts": SKIPPED,
      "test/pay-alt.test.ts": `${MARKER}\n${ackLine(`it.skip("x", () => {});`).replace(`"x"`, `"y"`)}\n`
    })
  );
  const staleSkipped = staleAlt.findings.filter((x) => x.kind === "enforcer-skipped");
  assert.deepEqual(staleSkipped.map((x) => x.file_path).sort(), ["test/pay-alt.test.ts", "test/pay-io.test.ts"]);
  assert.match(staleSkipped.find((x) => x.file_path === "test/pay-alt.test.ts")!.detail, /stale graphrag:skip-unrelated/);
  assert.deepEqual(staleAlt.covered_skips, []);

  const ackedAlt = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({
      "test/pay-io.test.ts": `${MARKER}\n${ackLine(`t.skip("root only");`)}\nit.skipIf(isWindows)("x", () => {});\n`,
      "test/pay-alt.test.ts": `${MARKER}\n${ackLine(`t.skip("root only");`)}\nit("x", () => {});\n`
    })
  );
  assert.equal(ackedAlt.status, "ok");
  assert.equal(ackedAlt.counts.covered_skips, 1);
  assert.deepEqual(ackedAlt.covered_skips.map((s) => [s.path, s.line, s.covered_by]), [
    ["test/pay-io.test.ts", 3, ["test/pay-alt.test.ts"]]
  ]);
  assert.deepEqual(ackedAlt.acknowledged_skips.map((s) => [s.path, s.line]).sort(), [
    ["test/pay-alt.test.ts", 2],
    ["test/pay-io.test.ts", 2]
  ]);
});

test("enforcer-skipped: stale な印の行は代替があっても covered にせず warn のまま (行の書き換えの信号を消さない)", () => {
  const res = constraintCheck(
    { vaultDir: writeVaultFromGraph(twoEnforcerGraph()), root: "/repo" },
    fakeRepo({
      "test/pay-io.test.ts": `${MARKER}\n${ackLine(`it.skipIf(isWindows)("x", () => {});`).replace("isWindows", "isLinux")}\nit.skip("y", () => {});\n`,
      "test/pay-alt.test.ts": CLEAN_ALT
    })
  );
  const f = res.findings.find((x) => x.kind === "enforcer-skipped");
  assert.ok(f);
  assert.equal(f!.line, 2);
  assert.match(f!.detail, /stale graphrag:skip-unrelated/);
  assert.match(f!.detail, /1 other skip line\(s\) are recorded in covered_skips/);
  // 代替が既にあるので「代替を登記せよ」は案内しない
  assert.doesNotMatch(f!.next_step, /register another enforcer/);
  assert.deepEqual(res.covered_skips.map((s) => s.line), [3]);
});

test("enforcer-skipped: 代替が無くても stale な印の行だけなら「代替を登記」を案内しない (stale は covered にならない)", () => {
  const f = skippedFinding(ackLine(`it.skipIf(isWindows)("x", () => {});`).replace("isWindows", "isLinux"));
  assert.ok(f);
  assert.match(f!.detail, /stale graphrag:skip-unrelated/);
  assert.doesNotMatch(f!.next_step, /register another enforcer/);
  assert.match(f!.next_step, /graphrag:skip-unrelated [0-9a-f]{8} <reason>/);
});

test("enforcer-skipped: CRLF の代替でも確認済みの行は clean とみなされ、他の enforcer の skip を covered にする", () => {
  const res = constraintCheck(
    { vaultDir: writeVaultFromGraph(twoEnforcerGraph()), root: "/repo" },
    fakeRepo({
      "test/pay-io.test.ts": SKIPPED,
      "test/pay-alt.test.ts": `${MARKER}\r\n${ackLine(`t.skip("root only");`)}\r\nit("x", () => {});\r\n`
    })
  );
  assert.equal(res.status, "ok");
  assert.deepEqual(res.covered_skips.map((s) => s.path), ["test/pay-io.test.ts"]);
});

test("enforcer-skipped: 同じファイルが守る複数の Constraint は cid ごとに独立に判定する", () => {
  const OTHER = "constraint:sys:no-net";
  const graph = twoEnforcerGraph();
  graph.nodes.push({ id: OTHER, type: "Constraint", title: "決済経路でネットワーク禁止", summary: "要約" });
  graph.edges.push({ id: "e-e3", type: "enforced_by", from: OTHER, to: "file:sys:test/pay-io.test.ts" });
  const res = constraintCheck(
    { vaultDir: writeVaultFromGraph(graph), root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": `${MARKER}\n${marker(OTHER)}\n${SKIPPED}`, "test/pay-alt.test.ts": CLEAN_ALT })
  );
  const skipped = res.findings.filter((x) => x.kind === "enforcer-skipped");
  assert.deepEqual(skipped.map((x) => x.constraint_id), [OTHER]);
  assert.deepEqual(res.covered_skips.map((s) => [s.constraint_id, s.covered_by]), [
    ["constraint:sys:no-sync-io", ["test/pay-alt.test.ts"]]
  ]);
});

// 既知の限界の characterization: 行単位の字句一致なのでコメント/文字列内も拾う。
// 字句除去を入れたらこのテストを「拾わない」側へ更新する。
test("enforcer-skipped: コメント/文字列内の skip も拾う (既知の限界)", () => {
  assert.ok(skippedFinding(`// describe.skip is not allowed here`));
  assert.ok(skippedFinding(`const doc = "use it.skipIf(cond) for platform tests";`));
});

test("marker-missing: enforcer は実在するがマーカーが無ければ warn (追記すべき行を明示)", () => {
  const vault = writeVaultFromGraph(baseGraph());
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": `test("sync io", () => {});\n` })
  );
  const f = res.findings.find((x) => x.kind === "marker-missing");
  assert.ok(f);
  assert.ok(f!.next_step.includes(`graphrag:enforces ${""}constraint:sys:no-sync-io`));
  assert.match(f!.next_step, /test\/pay-io\.test\.ts/);
});

test("orphan-marker: 実在しない Constraint を指すマーカーは warn / tombstone successor へ 301 案内", () => {
  const vault = writeVaultFromGraph(baseGraph());
  // tombstone 台帳: ghost は no-sync-io に置き換え済み
  const tombDir = path.join(vault, ".tombstones");
  mkdirSync(tombDir, { recursive: true });
  writeFileSync(
    path.join(tombDir, "2026-06.jsonl"),
    JSON.stringify({
      id: "constraint:sys:ghost", type: "Constraint", title: "ghost",
      deleted_at: "2026-06-01T00:00:00.000Z", reason: "統合", successor: "constraint:sys:no-sync-io"
    }) + "\n"
  );
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo(
      { "test/pay-io.test.ts": `${MARKER}\n`, "test/old.test.ts": `${marker("constraint:sys:ghost")}\n` },
      [
        { path: "test/pay-io.test.ts", line: 1, constraintId: "constraint:sys:no-sync-io" },
        { path: "test/old.test.ts", line: 1, constraintId: "constraint:sys:ghost" },
        { path: "test/never.test.ts", line: 3, constraintId: "constraint:sys:never-was" }
      ]
    )
  );
  const ghosts = res.findings.filter((x) => x.kind === "orphan-marker");
  assert.equal(ghosts.length, 2);
  const redirected = ghosts.find((g) => g.constraint_id === "constraint:sys:ghost");
  assert.match(redirected!.detail, /replaced by constraint:sys:no-sync-io/);
  assert.ok(redirected!.next_step.includes(`graphrag:enforces ${""}constraint:sys:no-sync-io`), "successor への 301 案内");
  const neverWas = ghosts.find((g) => g.constraint_id === "constraint:sys:never-was");
  assert.match(neverWas!.next_step, /typo|register|remove/i);
});

test("unregistered-enforcer: マーカーは在るが enforced_by 未登記 → そのまま適用できる plan_fragment", () => {
  const vault = writeVaultFromGraph(
    baseGraph([{ id: "constraint:sys:lonely", type: "Constraint", title: "T", summary: "S" }])
  );
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo(
      { "test/pay-io.test.ts": `${MARKER}\n`, "test/lonely.test.ts": `${marker("constraint:sys:lonely")}\n` },
      [
        { path: "test/pay-io.test.ts", line: 1, constraintId: "constraint:sys:no-sync-io" },
        { path: "test/lonely.test.ts", line: 1, constraintId: "constraint:sys:lonely" }
      ]
    )
  );
  const f = res.findings.find((x) => x.kind === "unregistered-enforcer");
  assert.ok(f);
  assert.equal(f!.constraint_id, "constraint:sys:lonely");
  const frag: any = f!.plan_fragment;
  // File ノードは vault に無いので fragment が create を同梱する (貼るだけで通る)
  assert.equal(frag.nodes[0].type, "File");
  assert.equal(frag.nodes[0].path, "test/lonely.test.ts");
  assert.equal(frag.edges[0].from, "constraint:sys:lonely");
  assert.equal(frag.edges[0].to, "file:sys:test/lonely.test.ts");
  // 登記済みの側 (pay-io) には出ない
  assert.ok(!res.findings.some((x) => x.kind === "unregistered-enforcer" && x.constraint_id === "constraint:sys:no-sync-io"));
});

test("contradictory-enforcement: enforcement:none なのに enforced_by が有れば warn", () => {
  const g = baseGraph();
  (g.nodes[2] as any).enforcement = "none";
  (g.nodes[2] as any).enforcement_reason = "宣言だけ残った";
  const vault = writeVaultFromGraph(g);
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo({ "test/pay-io.test.ts": `${MARKER}\n` })
  );
  const f = res.findings.find((x) => x.kind === "contradictory-enforcement");
  assert.ok(f);
  assert.match(f!.next_step, /Decide which is true/);
});

test("project vault は対象外 (note 明示で ok)", () => {
  const vault = writeVaultFromGraph({ nodes: [], edges: [] });
  const res = constraintCheck({ vaultDir: vault, root: "/repo", schemaId: "project" }, fakeRepo({}));
  assert.equal(res.status, "ok");
  assert.match(res.note, /project vault/);
  assert.equal(res.findings.length, 0);
});

test("マーカー走査不能 (git 無し等) は orphan/unregistered を skip して note で正直に言う", () => {
  const vault = writeVaultFromGraph(baseGraph());
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    {
      fileExists: () => true,
      readFile: () => `${MARKER}\n`,
      grepMarkers: () => { throw new Error("not a git repository"); }
    }
  );
  assert.match(res.note, /Marker reverse-scan unavailable/);
  assert.equal(res.status, "ok");
});

test("enforcementDebt: enforced_by も enforcement:none も無い Constraint だけを数える (ask/inspect 同乗用)", async () => {
  const { enforcementDebt } = await import("./constraint-check.ts");
  const graph = {
    nodes: [
      { id: "constraint:s:wired", type: "Constraint", title: "a" },
      { id: "constraint:s:declared", type: "Constraint", title: "b", enforcement: "none" },
      { id: "constraint:s:naked", type: "Constraint", title: "c" },
      { id: "decision:s:d", type: "Decision", title: "d" },
      { id: "file:s:t.ts", type: "File", path: "t.ts", title: "t" }
    ],
    edges: [{ id: "e1", type: "enforced_by", from: "constraint:s:wired", to: "file:s:t.ts" }]
  };
  assert.deepEqual(enforcementDebt(graph as any), { total: 3, unguarded: 1 });
});

test("ENFORCES_MARKER_RE はコメント記法非依存でマーカーを抜く (プレースホルダは拾わない)", () => {
  const text = [
    MARKER,
    `#graphrag:enforces  ${""}constraint:sys:a_b.c-1`, // # コメント・空白複数も拾う
    "-- graphrag:enforces constraint:<system>:<slug>", // ドキュメントのプレースホルダは対象外
    `graphrag:enforces ${""}risk:sys:not-a-constraint`, // Constraint 以外の型 slug は対象外
    `enforces: ${""}constraint:sys:legacy-form` // 名前空間なしの旧形式は対象外 (v1.21.0 で graphrag: 前置に確定)
  ].join("\n");
  const ids = [...text.matchAll(ENFORCES_MARKER_RE)].map((m) => m[1]);
  assert.deepEqual(ids, ["constraint:sys:no-sync-io", "constraint:sys:a_b.c-1"]);
});

test("marker-missing: マーカーが文字列リテラル内にしか無い enforcer は「マーカー無し」扱い (フィクスチャ耐性)", () => {
  const vault = writeVaultFromGraph(baseGraph());
  const res = constraintCheck(
    { vaultDir: vault, root: "/repo" },
    fakeRepo(
      // 実コメントマーカーは無く、文字列リテラルの中にだけ id が書かれている
      { "test/pay-io.test.ts": `const tpl = "${marker("constraint:sys:no-sync-io").replace(/"/g, '\\"')}";\ntest("x", () => {});\n` },
      []
    )
  );
  const f = res.findings.find((x) => x.kind === "marker-missing");
  assert.ok(f, "リテラル内の id は実マーカーと数えない → marker-missing が要る");
});

test("defaultGrepMarkers (実 git grep 経路): テストフィクスチャの文字列リテラル内 id は orphan-marker にならない", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "grag-constraint-repo-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  // 登記済み enforcer: 実コメントマーカー + フィクスチャ文字列 (実在しない id をリテラルで保持)
  mkdirSync(path.join(repo, "test"), { recursive: true });
  writeFileSync(
    path.join(repo, "test", "pay-io.test.ts"),
    `${MARKER}\nconst fixture = "${marker("constraint:sys:ghost-fixture").replace(/"/g, '\\"')}";\n`
  );
  execFileSync("git", ["-C", repo, "add", "."]);
  const vault = writeVaultFromGraph(baseGraph());
  // grepMarkers を DI しない = defaultGrepMarkers (git grep + リテラル除去) が走る
  const res = constraintCheck({ vaultDir: vault, root: repo });
  const ghosts = res.findings.filter((x) => x.kind === "orphan-marker");
  assert.deepEqual(ghosts, [], "リテラル内の ghost id が orphan-marker として誤検出されてはならない");
  assert.equal(res.status, "ok");
});

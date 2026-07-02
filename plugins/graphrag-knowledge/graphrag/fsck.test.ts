import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildVaultFiles } from "./build-vault.ts";
import { writeVaultDelta } from "./mutate-vault.ts";
import { fsckVault, runFsck, type FsckReport } from "./fsck.ts";

// 固定タイムスタンプ (banner round-trip で決定論的に byte 一致させる)。
const FIXED_TS = "2026-01-01T00:00:00.000Z";

function seedGraph() {
  return {
    generated_at: FIXED_TS,
    nodes: [
      { id: "file:s:README.md", type: "File", title: "README.md", path: "README.md" },
      { id: "decision:s:a", type: "Decision", title: "A", summary: "a" },
    ],
    edges: [
      {
        id: "decision_s_a__documented_by__file_s_README.md",
        type: "documented_by",
        from: "decision:s:a",
        to: "file:s:README.md",
      },
    ],
  };
}

function materialize(vault: string, graph: any): void {
  for (const f of buildVaultFiles(graph)) {
    const abs = path.join(vault, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
}

/** git repo 内に seed 済み・commit 済みの vault を作る。 */
function gitVault(graph: any = seedGraph()): { repo: string; vault: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "fsck-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  const vault = path.join(repo, "vault");
  materialize(vault, graph);
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"]);
  return { repo, vault };
}

function commitAll(repo: string, msg: string): void {
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", msg]);
}

function check(report: FsckReport, id: string) {
  const c = report.checks.find((c) => c.id === id);
  assert.ok(c, `check ${id} must be present`);
  return c!;
}

const ALL_CHECK_IDS = [
  "import-parse",
  "duplicate-node-ids",
  "id-path-consistency",
  "edge-endpoints",
  "schema-validate",
  "round-trip",
  "git-uncommitted",
];

test("fsck: クリーンな vault は全チェック ok・status ok・counts が正しい", () => {
  const { vault } = gitVault();
  const report = fsckVault({ vaultDir: vault });
  assert.equal(report.status, "ok");
  assert.deepEqual(report.checks.map((c) => c.id), ALL_CHECK_IDS, "安定 check id が全て出る");
  for (const c of report.checks) assert.equal(c.status, "ok", `${c.id} should be ok`);
  assert.deepEqual(report.counts, { files: 2, nodes: 2, edges: 1, errors: 0, warnings: 0 });
});

test("fsck: frontmatter が壊れたファイルは import-parse error (件数 + ファイル一覧)", () => {
  const { repo, vault } = gitVault();
  writeFileSync(path.join(vault, "Decision", "broken.md"), "no frontmatter at all\n");
  commitAll(repo, "corrupt"); // git-uncommitted と混ざらないよう commit しておく
  const report = fsckVault({ vaultDir: vault });
  assert.equal(report.status, "error");
  const c = check(report, "import-parse");
  assert.equal(c.status, "error");
  const d: any = c.detail;
  assert.equal(d.failed, 1);
  assert.deepEqual(d.failures.map((f: any) => f.file), ["Decision/broken.md"]);
  assert.match(c.hint ?? "", /git/);
});

test("fsck: 同一 node id を複数ファイルが持つと duplicate-node-ids error", () => {
  const { repo, vault } = gitVault();
  copyFileSync(path.join(vault, "Decision", "A.md"), path.join(vault, "Decision", "A-copy.md"));
  commitAll(repo, "dup copy");
  const report = fsckVault({ vaultDir: vault });
  assert.equal(report.status, "error");
  const c = check(report, "duplicate-node-ids");
  assert.equal(c.status, "error");
  const dupes: any[] = (c.detail as any).duplicates;
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].id, "decision:s:a");
  assert.deepEqual([...dupes[0].files].sort(), ["Decision/A-copy.md", "Decision/A.md"]);
  // schema レベルでも duplicate node id は失敗として現れる
  assert.equal(check(report, "schema-validate").status, "error");
});

test("fsck: 実在しないノードへのエッジは edge-endpoints error", () => {
  const g = seedGraph();
  g.edges.push({
    id: "decision_s_a__documented_by__file_s_ghost",
    type: "documented_by",
    from: "decision:s:a",
    to: "file:s:ghost",
  });
  const { vault } = gitVault(g);
  const report = fsckVault({ vaultDir: vault });
  assert.equal(report.status, "error");
  const c = check(report, "edge-endpoints");
  assert.equal(c.status, "error");
  const problems: any[] = (c.detail as any).problems;
  assert.equal(problems.length, 1);
  assert.equal(problems[0].ref, "file:s:ghost");
  assert.equal(problems[0].problem, "missing node");
  assert.equal(check(report, "schema-validate").status, "error", "validateGraph も missing to を検出");
});

test("fsck: vault: 参照は形のみ検査 — 正形は ok、slash 無しの奇形は error", () => {
  const g = seedGraph();
  g.edges.push(
    {
      id: "decision_s_a__sets_policy_for__xref_ok",
      type: "sets_policy_for",
      from: "decision:s:a",
      to: "vault:billing/decision:billing:x",
    },
    {
      id: "decision_s_a__sets_policy_for__xref_bad",
      type: "sets_policy_for",
      from: "decision:s:a",
      to: "vault:no-slash-here",
    }
  );
  const { vault } = gitVault(g);
  const report = fsckVault({ vaultDir: vault });
  const c = check(report, "edge-endpoints");
  assert.equal(c.status, "error");
  const problems: any[] = (c.detail as any).problems;
  assert.equal(problems.length, 1, "正形の vault: 参照は問題にしない (shape-only)");
  assert.equal(problems[0].ref, "vault:no-slash-here");
  assert.match(problems[0].problem, /malformed cross-vault ref/);
  // validateGraph は vault: 参照を一律 skip するので、この奇形は fsck だけが捕まえる
  assert.equal(check(report, "schema-validate").status, "ok");
});

test("fsck: 手編集でパースは通るが直列化が非 canonical → round-trip WARN (破損ではなく漂流)", () => {
  const { repo, vault } = gitVault();
  const file = path.join(vault, "Decision", "A.md");
  writeFileSync(file, readFileSync(file, "utf8") + "\n<!-- a human scribbled here -->\n");
  commitAll(repo, "hand edit");
  const report = fsckVault({ vaultDir: vault });
  assert.equal(report.status, "warn", "WARN 止まり (error にしない)");
  const c = check(report, "round-trip");
  assert.equal(c.status, "warn");
  assert.deepEqual((c.detail as any).non_canonical, ["Decision/A.md"]);
  assert.equal(check(report, "import-parse").status, "ok");
  assert.equal(check(report, "git-uncommitted").status, "ok");
});

test("fsck: CRLF チェックアウト (EOL 差のみ) は round-trip ok (write path と同じ EOL 無視)", () => {
  const { repo, vault } = gitVault();
  const file = path.join(vault, "Decision", "A.md");
  writeFileSync(file, readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
  commitAll(repo, "crlf");
  const report = fsckVault({ vaultDir: vault });
  assert.equal(check(report, "round-trip").status, "ok");
});

test("fsck: 未 commit の vault 変更 (torn write の兆候) は git-uncommitted ERROR + 復旧ヒント", () => {
  const { vault } = gitVault();
  // torn write の再現: delta は書かれたが commit 前に死んだ (writeVaultDelta のみ)。
  const g = seedGraph();
  g.nodes.push({ id: "decision:s:torn", type: "Decision", title: "Torn", summary: "t" });
  writeVaultDelta(vault, g);
  const report = fsckVault({ vaultDir: vault });
  assert.equal(report.status, "error");
  const c = check(report, "git-uncommitted");
  assert.equal(c.status, "error");
  assert.ok(((c.detail as any).changes as string[]).length > 0);
  assert.match(c.hint ?? "", /torn write/);
  assert.match(c.hint ?? "", /restore --source=HEAD/);
  // delta 自体は canonical な書き込みなので round-trip は ok のまま — torn write は
  // 直列化検査ではなく git 検査が捕まえる、という役割分担を固定する。
  assert.equal(check(report, "round-trip").status, "ok");
});

test("fsck: 型ディレクトリ不一致 (Decision ノードが OperationalKnowledge/ に居る) は id-path-consistency ERROR", () => {
  const { repo, vault } = gitVault();
  mkdirSync(path.join(vault, "OperationalKnowledge"), { recursive: true });
  renameSync(
    path.join(vault, "Decision", "A.md"),
    path.join(vault, "OperationalKnowledge", "A.md")
  );
  commitAll(repo, "move to wrong type dir");
  const report = fsckVault({ vaultDir: vault });
  assert.equal(report.status, "error");
  const c = check(report, "id-path-consistency");
  assert.equal(c.status, "error");
  const m: any = (c.detail as any).mismatches[0];
  assert.equal(m.node_id, "decision:s:a");
  assert.equal(m.actual, "OperationalKnowledge/A.md");
  assert.equal(m.expected, "Decision/A.md");
  assert.equal(m.severity, "error");
});

test("fsck: basename のみ不一致 (rename 漂流) は id-path-consistency WARN 止まり", () => {
  const { repo, vault } = gitVault();
  renameSync(path.join(vault, "Decision", "A.md"), path.join(vault, "Decision", "Z.md"));
  commitAll(repo, "rename basename");
  const report = fsckVault({ vaultDir: vault });
  assert.equal(report.status, "warn");
  const c = check(report, "id-path-consistency");
  assert.equal(c.status, "warn");
  assert.equal((c.detail as any).mismatches[0].severity, "warn");
});

test("fsck: git repo でない vault は git-uncommitted WARN (検知不能を正直に報告)", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "fsck-nogit-"));
  materialize(vault, seedGraph());
  // 親ディレクトリ (tmpdir) が偶然 git repo でも「非 repo」経路を決定論的に踏むよう DI する。
  const report = fsckVault({
    vaultDir: vault,
    deps: {
      gitStatusPorcelain: () => {
        throw new Error("fatal: not a git repository");
      },
    },
  });
  assert.equal(report.status, "warn");
  const c = check(report, "git-uncommitted");
  assert.equal(c.status, "warn");
  assert.match(c.hint ?? "", /not a git repository/);
});

test("runFsck: 出力 JSON を返し、error 時は exitCode 1 / ok 時は 0 を設定する", () => {
  const prevExitCode = process.exitCode;
  const writes: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: string) => {
    writes.push(String(s));
    return true;
  };
  try {
    const { vault } = gitVault();
    const ok = runFsck(["--vault", vault]);
    assert.equal(ok.status, "ok");
    assert.equal(process.exitCode ?? 0, 0);
    const printed = JSON.parse(writes.join(""));
    assert.equal(printed.status, "ok");
    assert.equal(printed.generated_by, "graphrag/fsck.ts");

    writes.length = 0;
    writeFileSync(path.join(vault, "Decision", "broken.md"), "garbage\n");
    const bad = runFsck(["--vault", vault]);
    assert.equal(bad.status, "error");
    assert.equal(process.exitCode, 1);
  } finally {
    (process.stdout as any).write = origWrite;
    process.exitCode = prevExitCode;
  }
});

test("cli 経由 (verb 配線): `fsck --vault` が exit 0 / 壊れた vault で exit 1", () => {
  const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const { vault } = gitVault();
  const run = (dir: string) => {
    try {
      const stdout = execFileSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", cliPath, "fsck", "--vault", dir],
        { encoding: "utf8", cwd: path.dirname(dir) }
      );
      return { code: 0, stdout };
    } catch (e: any) {
      return { code: e.status as number, stdout: String(e.stdout ?? "") };
    }
  };
  const ok = run(vault);
  assert.equal(ok.code, 0);
  assert.equal(JSON.parse(ok.stdout).status, "ok");

  writeFileSync(path.join(vault, "Decision", "broken.md"), "garbage\n");
  assert.ok(existsSync(path.join(vault, "Decision", "broken.md")));
  const bad = run(vault);
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.stdout).status, "error");
});

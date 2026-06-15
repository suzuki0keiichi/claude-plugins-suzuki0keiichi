import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCarvingAllow } from "./cli-carving-allow.ts";
import { loadCarvingConfig } from "./carving-config.ts";

function tmpConfigPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "callow-"));
  return path.join(dir, "carving.json");
}

test("carving-allow add: エントリを追加し added は当日 (YYYY-MM-DD)", async () => {
  const cp = tmpConfigPath();
  const r = await runCarvingAllow(["add", "--config", cp, "--path", "tools/build.bat", "--reason", "ビルド入口"]);
  assert.equal(r.action, "add");
  assert.equal(r.entry.path, "tools/build.bat");
  assert.equal(r.entry.reason, "ビルド入口");
  assert.match(r.entry.added, /^\d{4}-\d{2}-\d{2}$/);
  // 書かれたファイルは carving-config の検証を通る形
  const loaded = loadCarvingConfig(cp);
  assert.equal(loaded.exists, true);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.config!.allowed_orphans.length, 1);
  // 原子書き: tmp ファイルが残っていない
  assert.deepEqual(readdirSync(path.dirname(cp)).filter((f) => f.endsWith(".tmp")), []);
});

test("carving-allow add: 同じ path の重複追加は reject", async () => {
  const cp = tmpConfigPath();
  await runCarvingAllow(["add", "--config", cp, "--path", "a.sh", "--reason", "r"]);
  await assert.rejects(
    runCarvingAllow(["add", "--config", cp, "--path", "a.sh", "--reason", "r2"]),
    /既に免除済み/
  );
});

test("carving-allow add: glob 文字を含む path は reject、--reason 必須", async () => {
  const cp = tmpConfigPath();
  await assert.rejects(
    runCarvingAllow(["add", "--config", cp, "--path", "plans/*.html", "--reason", "r"]),
    /glob/
  );
  await assert.rejects(
    runCarvingAllow(["add", "--config", cp, "--path", "a.sh"]),
    /--reason is required/
  );
});

test("carving-allow add: 既存 carving.json が壊れていたら上書きせず reject", async () => {
  const cp = tmpConfigPath();
  writeFileSync(cp, "{broken");
  await assert.rejects(
    runCarvingAllow(["add", "--config", cp, "--path", "a.sh", "--reason", "r"]),
    /carving\.json が不正/
  );
  assert.equal(readFileSync(cp, "utf8"), "{broken", "壊れたファイルに追い打ちで上書きしない");
});

test("carving-allow remove: エントリを削除、無いものは reject", async () => {
  const cp = tmpConfigPath();
  await runCarvingAllow(["add", "--config", cp, "--path", "a.sh", "--reason", "r"]);
  await runCarvingAllow(["add", "--config", cp, "--path", "b.sh", "--reason", "r"]);
  const r = await runCarvingAllow(["remove", "--config", cp, "--path", "a.sh"]);
  assert.equal(r.action, "remove");
  assert.equal(r.removed.path, "a.sh");
  const loaded = loadCarvingConfig(cp);
  assert.deepEqual(loaded.config!.allowed_orphans.map((e) => e.path), ["b.sh"]);
  await assert.rejects(
    runCarvingAllow(["remove", "--config", cp, "--path", "no-such.sh"]),
    /見つからない/
  );
});

test("carving-allow list: エントリ列挙、ファイル不在は exists:false", async () => {
  const cp = tmpConfigPath();
  const empty = await runCarvingAllow(["list", "--config", cp]);
  assert.equal(empty.exists, false);
  assert.deepEqual(empty.allowed_orphans, []);
  await runCarvingAllow(["add", "--config", cp, "--path", "a.sh", "--reason", "r"]);
  const r = await runCarvingAllow(["list", "--config", cp]);
  assert.equal(r.exists, true);
  assert.deepEqual(r.allowed_orphans.map((e: any) => e.path), ["a.sh"]);
});

test("carving-allow: git repo 外では commit 失敗を非致命で注記、repo 内では commit される", async () => {
  // repo 外: tmpdir は git repo でない
  const cpOut = tmpConfigPath();
  const rOut = await runCarvingAllow(["add", "--config", cpOut, "--path", "a.sh", "--reason", "r"]);
  assert.equal(rOut.git.committed, false);
  assert.ok(rOut.git.note, "失敗理由が注記される");
  assert.ok(existsSync(cpOut), "git 失敗でも書き込み自体は成功している (非致命)");

  // repo 内: init + user 設定をして commit が通ること
  const dir = mkdtempSync(path.join(tmpdir(), "callow-git-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  const cpIn = path.join(dir, "carving.json");
  const rIn = await runCarvingAllow(["add", "--config", cpIn, "--path", "a.sh", "--reason", "r"]);
  assert.equal(rIn.git.committed, true, JSON.stringify(rIn.git));
  const subject = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(subject, "carving-allow add: a.sh");
});

test("carving-allow migrate: 旧 builtin パターン該当の File を config エントリ案として出す (書き込みなし)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "callow-mig-"));
  const gp = path.join(dir, "graph.json");
  writeFileSync(gp, JSON.stringify({
    nodes: [
      { id: "f1", type: "File", path: "build-all.utf8.bat", role: "source" },
      { id: "f2", type: "File", path: "plans/handover.html", role: "source" },
      { id: "f3", type: "File", path: "app/winsw/service.xml", role: "config" },
      { id: "f4", type: "File", path: "app/ui/index.css", role: "source" },
      { id: "f5", type: "File", path: "src/core/a.ts", role: "source" }, // 非該当
      { id: "p1", type: "Pocket", title: "x" }, // File 以外は無視
    ],
    edges: [],
  }));
  const r = await runCarvingAllow(["migrate", "--graph", gp]);
  assert.equal(r.action, "migrate");
  const byPath = new Map(r.candidates.map((c: any) => [c.path, c]));
  assert.deepEqual(
    [...byPath.keys()].sort(),
    ["app/ui/index.css", "app/winsw/service.xml", "build-all.utf8.bat", "plans/handover.html"]
  );
  // 案は carving.json エントリの形 (path/reason/added) + 出自パターン名
  const cand: any = byPath.get("app/winsw/service.xml");
  assert.equal(cand.from_builtin, "winsw-service-xml");
  assert.match(cand.reason, /winsw-service-xml/);
  assert.match(cand.added, /^\d{4}-\d{2}-\d{2}$/);
  // 書き込みなし: graph.json 以外のファイルが増えていない
  assert.deepEqual(readdirSync(dir), ["graph.json"]);
});

test("carving-allow: 未知 verb は usage エラー", async () => {
  await assert.rejects(runCarvingAllow(["frobnicate"]), /usage: carving-allow/);
});

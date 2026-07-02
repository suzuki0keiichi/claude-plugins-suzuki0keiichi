import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadCarvingConfig,
  parseCarvingConfig,
  resolveCarvingConfigPath,
  staleConfigEntries,
} from "./carving-config.ts";

test("parseCarvingConfig: 正しい形はエラーなしで読める", () => {
  const raw = JSON.stringify({
    allowed_orphans: [
      { path: "tools/build-all.bat", reason: "ビルド入口。Pocket でなく梱包", added: "2026-06-11" },
    ],
  });
  const { config, errors } = parseCarvingConfig(raw);
  assert.deepEqual(errors, []);
  assert.equal(config!.allowed_orphans.length, 1);
  assert.equal(config!.allowed_orphans[0].path, "tools/build-all.bat");
});

test("parseCarvingConfig: glob/regex 文字 (* ? [) を含む path は ERROR", () => {
  for (const p of ["plans/*.html", "src/?.ts", "src/[ab].ts"]) {
    const { errors } = parseCarvingConfig(JSON.stringify({
      allowed_orphans: [{ path: p, reason: "r", added: "2026-06-11" }],
    }));
    assert.equal(errors.length, 1, `${p} は glob として弾かれるべき`);
    assert.match(errors[0], /glob/);
  }
});

test("parseCarvingConfig: reason / added 欠落は ERROR", () => {
  const { errors } = parseCarvingConfig(JSON.stringify({
    allowed_orphans: [
      { path: "a.bat", added: "2026-06-11" },          // reason 欠落
      { path: "b.bat", reason: "r" },                  // added 欠落
      { path: "c.bat", reason: "  ", added: "2026-06-11" }, // 空白だけの reason も欠落扱い
    ],
  }));
  assert.equal(errors.length, 3);
  assert.match(errors[0], /reason 必須/);
  assert.match(errors[1], /added .*必須/);
  assert.match(errors[2], /reason 必須/);
});

test("parseCarvingConfig: path 重複は ERROR、path 欠落エントリはエラーにして config から落とす", () => {
  const { config, errors } = parseCarvingConfig(JSON.stringify({
    allowed_orphans: [
      { path: "a.bat", reason: "r", added: "2026-06-11" },
      { path: "a.bat", reason: "r2", added: "2026-06-11" },
      { reason: "path なし", added: "2026-06-11" },
    ],
  }));
  assert.equal(errors.length, 2);
  assert.match(errors[0], /path 重複/);
  assert.match(errors[1], /path 必須/);
  assert.equal(config!.allowed_orphans.length, 2);
});

test("parseCarvingConfig: 壊れた JSON / 形違いは config:null", () => {
  assert.equal(parseCarvingConfig("{oops").config, null);
  assert.equal(parseCarvingConfig(JSON.stringify({ allowed_orphans: "x" })).config, null);
  assert.equal(parseCarvingConfig(JSON.stringify([])).config, null);
  assert.ok(parseCarvingConfig("{oops").errors.length > 0);
});

test("loadCarvingConfig: ファイル不在は exists:false でエラーなし (非致命)", () => {
  const r = loadCarvingConfig(path.join(tmpdir(), "no-such-dir-xyz", "carving.json"));
  assert.equal(r.exists, false);
  assert.equal(r.config, null);
  assert.deepEqual(r.errors, []);
});

test("loadCarvingConfig: 実ファイルを読む", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cconf-"));
  const cp = path.join(dir, "carving.json");
  writeFileSync(cp, JSON.stringify({
    allowed_orphans: [{ path: "x.sh", reason: "r", added: "2026-06-11" }],
  }));
  const r = loadCarvingConfig(cp);
  assert.equal(r.exists, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.config!.allowed_orphans[0].path, "x.sh");
});

test("staleConfigEntries: graph に無い path だけを返す (stale-exemption)", () => {
  const config = {
    allowed_orphans: [
      { path: "alive.sh", reason: "r", added: "2026-06-11" },
      { path: "gone.sh", reason: "r", added: "2026-06-11" },
    ],
  };
  assert.deepEqual(staleConfigEntries(config, new Set(["alive.sh", "other.ts"])), ["gone.sh"]);
});

test("resolveCarvingConfigPath: graph が .graphrag 配下ならその隣、それ以外は同階層の .graphrag 配下", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cconf-"));
  const stateDir = path.join(dir, ".graphrag");
  mkdirSync(stateDir);
  assert.equal(
    resolveCarvingConfigPath(path.join(stateDir, "indexed-graph.json")),
    path.join(stateDir, "carving.json")
  );
  assert.equal(
    resolveCarvingConfigPath(path.join(dir, "graph.json")),
    path.join(stateDir, "carving.json")
  );
  // E1: graph が .graphrag/cache 配下 (carve の新規約) でも carving.json は .graphrag 直下
  assert.equal(
    resolveCarvingConfigPath(path.join(stateDir, "cache", "indexed-graph.json")),
    path.join(stateDir, "carving.json")
  );
});

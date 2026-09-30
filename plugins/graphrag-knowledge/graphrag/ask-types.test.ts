// issue #36 (部分対応): 型の意図は query 文字列ではなく ask --types の構造化 filter で渡す。
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildVaultFiles } from "./build-vault.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");

test("ask --types は brief と evidence の両段に同じ filter を渡し、未知型は入力エラー", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "asktypes-"));
  try {
    const vault = path.join(tmp, "vault");
    for (const f of buildVaultFiles({
      generated_at: "2026-01-01T00:00:00.000Z",
      nodes: [
        { id: "file:s:a.ts", type: "File", title: "a.ts", path: "a.ts" },
        { id: "decision:s:d", type: "Decision", title: "retry policy", summary: "retry policy for writes" },
        { id: "risk:s:r", type: "Risk", title: "retry policy risk", summary: "retry policy may loop" }
      ],
      edges: []
    })) {
      mkdirSync(path.dirname(path.join(vault, f.relPath)), { recursive: true });
      writeFileSync(path.join(vault, f.relPath), f.content);
    }
    execFileSync("git", ["-C", tmp, "init", "-q"]);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, GRAPHRAG_VAULT_DIR: vault };
    const run = (args: string[]) => spawnSync("node", ["--experimental-strip-types", CLI, "ask", ...args], { cwd: tmp, env, encoding: "utf8" });
    // 部分一致 (coverage が LOW 未満) の query で brief を弱くし、evidence へ段上げさせる
    const r = run(["--lexical-only", "--limit", "1", "--types", "Risk", "retry storm handling"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const types = out.stages.flatMap((s: any) =>
      (s.output?.query?.matches ?? s.output?.direct_evidence ?? []).map((m: any) => m.node.type));
    assert.ok(out.stages.some((s: any) => s.stage === "evidence"), "escalated to evidence");
    assert.ok(types.length > 0 && types.every((t: string) => t === "Risk"), JSON.stringify(types));
    const bad = run(["--lexical-only", "--types", "Decisoin", "retry policy"]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /unknown node type "Decisoin"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

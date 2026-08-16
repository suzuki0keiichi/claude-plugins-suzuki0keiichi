import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_PROVIDER, embedderHomeDir, localEmbedderStatus } from "./embedder-local.ts";
import { createVectorProvider } from "./vector.ts";

function withEmbedderDir(dir: string, fn: () => void | Promise<void>) {
  const previous = process.env.GRAPHRAG_EMBEDDER_DIR;
  process.env.GRAPHRAG_EMBEDDER_DIR = dir;
  const restore = () => {
    if (previous === undefined) delete process.env.GRAPHRAG_EMBEDDER_DIR;
    else process.env.GRAPHRAG_EMBEDDER_DIR = previous;
  };
  const result = fn();
  if (result instanceof Promise) return result.finally(restore);
  restore();
  return result;
}

test("embedderHomeDir: GRAPHRAG_EMBEDDER_DIR overrides the ~/.graphrag/embedder default", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "graphrag-embedder-"));
  try {
    withEmbedderDir(dir, () => {
      assert.equal(embedderHomeDir(), dir);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("localEmbedderStatus: empty dir → installed=false / fake install → installed=true", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "graphrag-embedder-"));
  try {
    withEmbedderDir(dir, () => {
      assert.equal(localEmbedderStatus().installed, false);
      const pkgDir = path.join(dir, "node_modules", "@huggingface", "transformers");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(path.join(pkgDir, "package.json"), "{}");
      const status = localEmbedderStatus();
      assert.equal(status.installed, true);
      assert.equal(status.model, LOCAL_EMBEDDING_MODEL);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createVectorProvider(local): endpoint 無しで生成でき、metadata がモデルを持つ", () => {
  const provider = createVectorProvider({ provider: LOCAL_EMBEDDING_PROVIDER, model: LOCAL_EMBEDDING_MODEL });
  assert.equal(provider.id, LOCAL_EMBEDDING_PROVIDER);
  assert.equal(provider.semantic, true);
  assert.equal(provider.metadata.endpoint, null);
  assert.equal(provider.metadata.model, LOCAL_EMBEDDING_MODEL);
});

test("createVectorProvider(local): 未導入マシンでの embed は embedder-setup への導線付きで落ちる", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "graphrag-embedder-"));
  try {
    await withEmbedderDir(dir, async () => {
      const provider = createVectorProvider({ provider: LOCAL_EMBEDDING_PROVIDER, model: LOCAL_EMBEDDING_MODEL });
      await assert.rejects(
        () => provider.embed("query: test"),
        (error: Error) => error.message.includes("embedder-setup")
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

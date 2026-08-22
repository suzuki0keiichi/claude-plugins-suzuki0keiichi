import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithTimeout, prefixPolicyForModel, EMBEDDING_PREFIX_POLICIES } from "./vector.ts";

// --- R1 接頭辞ポリシー ---
test("prefixPolicyForModel: nomic-embed-text gets document/query prefixes (auto)", () => {
  const p = prefixPolicyForModel("nomic-embed-text", "auto");
  assert.deepEqual(p, EMBEDDING_PREFIX_POLICIES["nomic-embed-text"]);
  assert.equal(p!.document, "search_document: ");
  assert.equal(p!.query, "search_query: ");
});

test("prefixPolicyForModel: tagged model name (nomic-embed-text:latest) still matches", () => {
  const p = prefixPolicyForModel("nomic-embed-text:latest", "auto");
  assert.ok(p, "前方一致でタグ付きモデルも当たる");
  assert.equal(p!.query, "search_query: ");
});

test("prefixPolicyForModel: unregistered model → null (no prefix)", () => {
  assert.equal(prefixPolicyForModel("text-embedding-3-small", "auto"), null);
  assert.equal(prefixPolicyForModel(null, "auto"), null);
  assert.equal(prefixPolicyForModel(undefined, "auto"), null);
});

test("prefixPolicyForModel: mode 'off' always returns null even for registered model", () => {
  assert.equal(prefixPolicyForModel("nomic-embed-text", "off"), null);
});

test("prefixPolicyForModel: e5 系 (同梱デフォルト含む) は passage:/query: 接頭辞", () => {
  for (const model of ["Xenova/multilingual-e5-small", "Xenova/multilingual-e5-base", "multilingual-e5-base", "intfloat/multilingual-e5-large"]) {
    const p = prefixPolicyForModel(model, "auto");
    assert.ok(p, `policy missing for ${model}`);
    assert.equal(p!.document, "passage: ");
    assert.equal(p!.query, "query: ");
  }
});

import { embedForIndex, embedQueryForVectorIndex } from "./vector.ts";

// embedForIndex / embedQueryForVectorIndex は createVectorProvider 経由で実 endpoint を
// 叩く。global fetch を差し替えてリクエスト body の input を捕まえ、接頭辞の付き方を検証する。
// (索引メタ prefix_policy の有無で付与が切り替わる = 互換の要)
async function captureEmbedInput(fn: () => Promise<unknown>): Promise<string> {
  const realFetch = globalThis.fetch;
  let captured = "";
  globalThis.fetch = (async (url: string, opts: any) => {
    // model 可用性プローブ (/models) には登録モデルを返す。/embeddings には埋め込みを返し
    // input を捕まえる。
    if (String(url).endsWith("/models")) {
      return { ok: true, json: async () => ({ data: [{ id: "nomic-embed-text" }] }) };
    }
    captured = JSON.parse(opts.body).input;
    return { ok: true, json: async () => ({ data: [{ embedding: [1, 0, 0] }] }) };
  }) as any;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return captured;
}

const PREFIXED_INDEX = {
  provider: "openai-compatible-embedding",
  dimensions: 3,
  provider_options: { endpoint: "http://localhost:1/v1/embeddings", model: "nomic-embed-text" },
  prefix_policy: { document: "search_document: ", query: "search_query: " },
  rows: []
};

// 旧 index = prefix_policy メタが無いだけ (endpoint/model は通常どおり在る)。
const LEGACY_INDEX = {
  provider: "openai-compatible-embedding",
  dimensions: 3,
  provider_options: { endpoint: "http://localhost:1/v1/embeddings", model: "nomic-embed-text" },
  rows: []
};

test("embedForIndex: applies document prefix when index has prefix_policy", async () => {
  const input = await captureEmbedInput(() => embedForIndex(PREFIXED_INDEX, "認証基盤", "document"));
  assert.equal(input, "search_document: 認証基盤");
});

test("embedForIndex: applies query prefix when index has prefix_policy", async () => {
  const input = await captureEmbedInput(() => embedForIndex(PREFIXED_INDEX, "認証", "query"));
  assert.equal(input, "search_query: 認証");
});

test("embedForIndex: no prefix when index lacks prefix_policy (legacy index compat)", async () => {
  const docInput = await captureEmbedInput(() => embedForIndex(LEGACY_INDEX, "認証", "document"));
  assert.equal(docInput, "認証", "メタ無し index は document 接頭辞を付けない");
  const qInput = await captureEmbedInput(() => embedForIndex(LEGACY_INDEX, "認証", "query"));
  assert.equal(qInput, "認証", "メタ無し index は query 接頭辞を付けない");
});

test("embedQueryForVectorIndex: query prefix applied iff index carries prefix_policy", async () => {
  const withPolicy = await captureEmbedInput(() => embedQueryForVectorIndex("認証", PREFIXED_INDEX));
  assert.equal(withPolicy, "search_query: 認証", "ポリシー在りは query 接頭辞付与");
  const legacy = await captureEmbedInput(() => embedQueryForVectorIndex("認証", LEGACY_INDEX));
  assert.equal(legacy, "認証", "旧 index (メタ無し) は接頭辞なし=従来挙動");
});

// embedding endpoint への fetch が無制限にハングしない (AbortController で上限を課す) こと。
// endpoint が「ポートは開くが応答しない」状態だと素の fetch は永久に待ち、索引ビルドが
// 固まる。ハング相当の fetch (signal は尊重するが応答しない) を注入して検証する。
test("fetchWithTimeout aborts a hanging request after the timeout", async () => {
  const hangingFetch = (_url: string, opts: any) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const e: any = new Error("The operation was aborted");
        e.name = "AbortError";
        reject(e);
      });
      // それ以外では決して解決しない (= endpoint ハング)。
    });
  const start = Date.now();
  await assert.rejects(
    () => fetchWithTimeout("http://x/v1/embeddings", { method: "POST" }, 40, hangingFetch),
    /abort/i
  );
  assert.ok(Date.now() - start < 2000, "timeout で速やかに reject する (ハングしない)");
});

test("fetchWithTimeout forwards options + an AbortSignal and passes through a fast response", async () => {
  let sawSignal = false;
  let sawMethod: string | null = null;
  const okFetch = async (_url: string, opts: any) => {
    sawSignal = opts.signal instanceof AbortSignal;
    sawMethod = opts.method;
    return { ok: true };
  };
  const res: any = await fetchWithTimeout("http://x", { method: "POST" }, 1000, okFetch);
  assert.equal(res.ok, true);
  assert.equal(sawSignal, true, "AbortSignal が付与される");
  assert.equal(sawMethod, "POST", "呼び出し側の options が透過される");
});

// ── embedding circuit breaker (issue #24) ────────────────────────────────────
import { createServer } from "node:http";
import { createVectorProvider, resetEmbeddingCircuit } from "./vector.ts";

test("circuit breaker: 5xx を一度踏んだ endpoint への embedding は以後即失敗 (circuit open)", async () => {
  resetEmbeddingCircuit();
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.statusCode = 503;
    res.end("boom");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const provider = createVectorProvider({
    provider: "openai-compatible-embedding",
    endpoint: `http://127.0.0.1:${port}/v1/embeddings`,
    model: "m"
  });
  try {
    await assert.rejects(() => provider.embed("a"), /Embedding request failed: 503/);
    await assert.rejects(() => provider.embed("b"), /circuit open/);
    assert.equal(hits, 1, "2回目は endpoint に到達しない (fail-fast)");
  } finally {
    server.close();
    resetEmbeddingCircuit();
  }
});

test("circuit breaker: 4xx では開かない (endpoint は生きている)", async () => {
  resetEmbeddingCircuit();
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.statusCode = 400;
    res.end("bad request");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const provider = createVectorProvider({
    provider: "openai-compatible-embedding",
    endpoint: `http://127.0.0.1:${port}/v1/embeddings`,
    model: "m"
  });
  try {
    await assert.rejects(() => provider.embed("a"), /Embedding request failed: 400/);
    await assert.rejects(() => provider.embed("b"), /Embedding request failed: 400/);
    assert.equal(hits, 2, "4xx では circuit は開かず毎回到達する");
  } finally {
    server.close();
    resetEmbeddingCircuit();
  }
});

// ── issue #31: embedding バッチ化 (embedMany / chunk / fallback) ─────────────
import {
  chunkTextsForEmbedding,
  embedTextsWithProvider,
  embedManyForIndex
} from "./vector.ts";

test("chunkTextsForEmbedding: 件数上限で分割 (境界含む)", () => {
  assert.deepEqual(
    chunkTextsForEmbedding(["a", "b", "c", "d", "e"], 2, 1000),
    [["a", "b"], ["c", "d"], ["e"]]
  );
  assert.deepEqual(chunkTextsForEmbedding(["a", "b"], 2, 1000), [["a", "b"]], "上限ちょうどは 1 チャンク");
  assert.deepEqual(chunkTextsForEmbedding([], 2, 1000), []);
});

test("chunkTextsForEmbedding: byte 上限 (UTF-8) で分割・単体超過テキストは単独チャンク", () => {
  // "ああ" = 6 bytes。maxBytes 12 → 2 件 + 1 件。
  assert.deepEqual(chunkTextsForEmbedding(["ああ", "ああ", "ああ"], 10, 12), [["ああ", "ああ"], ["ああ"]]);
  // 単体で byte 上限を超えるテキストも捨てず単独チャンクで送る。
  assert.deepEqual(chunkTextsForEmbedding(["xxxxxxxxxx", "a"], 10, 4), [["xxxxxxxxxx"], ["a"]]);
});

test("embedTextsWithProvider: embedMany 非対応 provider は従来どおり直列 embed (順序維持)", async () => {
  const seen: string[] = [];
  const provider: any = { embed: async (t: string) => { seen.push(t); return [t.length, 0]; } };
  const out = await embedTextsWithProvider(provider, ["aa", "b", "ccc"]);
  assert.deepEqual(seen, ["aa", "b", "ccc"]);
  assert.deepEqual(out, [[2, 0], [1, 0], [3, 0]]);
});

test("embedTextsWithProvider: embedMany 対応 provider はチャンク単位で直列にまとめて送る (並行なし)", async () => {
  const batches: string[][] = [];
  let inFlight = 0;
  let overlapped = false;
  const provider: any = {
    embed: async (t: string) => [t.length],
    embedMany: async (texts: string[]) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      batches.push([...texts]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return texts.map((t) => [t.length]);
    }
  };
  const out = await embedTextsWithProvider(provider, ["aa", "b", "ccc", "dddd", "e"], { maxItems: 2 });
  assert.deepEqual(batches, [["aa", "b"], ["ccc", "dddd"], ["e"]], "件数上限ごとのチャンク");
  assert.equal(overlapped, false, "チャンクは直列送出 (並行リクエストはしない — circuit breaker の fail-fast 前提)");
  assert.deepEqual(out, [[2], [1], [3], [4], [1]], "返却順は入力順");
});

test("embedTextsWithProvider: 1 件は従来の embed 経路 (リクエスト形の互換維持)", async () => {
  let manyCalls = 0;
  const singles: string[] = [];
  const provider: any = {
    embed: async (t: string) => { singles.push(t); return [1]; },
    embedMany: async () => { manyCalls += 1; return [[1]]; }
  };
  await embedTextsWithProvider(provider, ["only"]);
  assert.deepEqual(singles, ["only"]);
  assert.equal(manyCalls, 0);
});

test("embedTextsWithProvider: embedMany の件数不一致は明示 Error", async () => {
  const provider: any = {
    embed: async () => [1],
    embedMany: async () => [[1]]
  };
  await assert.rejects(() => embedTextsWithProvider(provider, ["a", "b"]), /1 vector\(s\) for 2 input\(s\)/);
});

test("openai-compatible embedMany: input を配列で送り data[].index で並べ直す", async () => {
  resetEmbeddingCircuit();
  const realFetch = globalThis.fetch;
  let sentInput: any = null;
  globalThis.fetch = (async (_url: string, opts: any) => {
    sentInput = JSON.parse(opts.body).input;
    return {
      ok: true,
      json: async () => ({
        data: [
          { index: 1, embedding: [0, 1, 0] },
          { index: 0, embedding: [1, 0, 0] }
        ]
      })
    };
  }) as any;
  try {
    const provider = createVectorProvider({
      provider: "openai-compatible-embedding",
      endpoint: "http://batch-reorder.test/v1/embeddings",
      model: "m"
    });
    const out = await provider.embedMany!(["first", "second"]);
    assert.deepEqual(sentInput, ["first", "second"], "input は配列 1 リクエスト");
    assert.deepEqual(out[0], [1, 0, 0], "index=0 が先頭 (応答が順不同でも並べ直す)");
    assert.deepEqual(out[1], [0, 1, 0]);
  } finally {
    globalThis.fetch = realFetch;
    resetEmbeddingCircuit();
  }
});

test("openai-compatible embedMany: 応答件数不一致は明示 Error", async () => {
  resetEmbeddingCircuit();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ data: [{ index: 0, embedding: [1, 0, 0] }] })
  })) as any;
  try {
    const provider = createVectorProvider({
      provider: "openai-compatible-embedding",
      endpoint: "http://batch-count.test/v1/embeddings",
      model: "m"
    });
    await assert.rejects(() => provider.embedMany!(["a", "b"]), /sent 2 input\(s\), got 1/);
  } finally {
    globalThis.fetch = realFetch;
    resetEmbeddingCircuit();
  }
});

test("openai-compatible embedMany: バッチ内の次元不一致は明示 Error", async () => {
  resetEmbeddingCircuit();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      data: [
        { index: 0, embedding: [1, 0, 0] },
        { index: 1, embedding: [1, 0] }
      ]
    })
  })) as any;
  try {
    const provider = createVectorProvider({
      provider: "openai-compatible-embedding",
      endpoint: "http://batch-dims.test/v1/embeddings",
      model: "m"
    });
    await assert.rejects(() => provider.embedMany!(["a", "b"]), /inconsistent dimensions/);
  } finally {
    globalThis.fetch = realFetch;
    resetEmbeddingCircuit();
  }
});

test("embedManyForIndex: prefix_policy の document 接頭辞を全件に付けて配列で送る", async () => {
  resetEmbeddingCircuit();
  const realFetch = globalThis.fetch;
  let sentInput: any = null;
  globalThis.fetch = (async (url: string, opts: any) => {
    if (String(url).endsWith("/models")) {
      return { ok: true, json: async () => ({ data: [{ id: "nomic-embed-text" }] }) };
    }
    sentInput = JSON.parse(opts.body).input;
    return {
      ok: true,
      json: async () => ({
        data: [
          { index: 0, embedding: [1, 0, 0] },
          { index: 1, embedding: [0, 1, 0] }
        ]
      })
    };
  }) as any;
  try {
    const out = await embedManyForIndex(PREFIXED_INDEX, ["認証", "決済"], "document");
    assert.deepEqual(sentInput, ["search_document: 認証", "search_document: 決済"]);
    assert.equal(out.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    resetEmbeddingCircuit();
  }
});

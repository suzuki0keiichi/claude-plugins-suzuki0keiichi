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

import { existsSync, readFileSync } from "node:fs";

loadDotEnv();

function loadDotEnv(filePath = ".env") {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(rawValue.trim());
  }
}

function unquoteEnvValue(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export const OPENAI_COMPATIBLE_EMBEDDING_PROVIDER = "openai-compatible-embedding";
export const LM_STUDIO_EMBEDDING_PROVIDER = "lm-studio-embedding";
export const VECTOR_DIMENSIONS = 256;

const OPENAI_COMPATIBLE_PROVIDERS = new Set([
  OPENAI_COMPATIBLE_EMBEDDING_PROVIDER,
  LM_STUDIO_EMBEDDING_PROVIDER
]);

export const VECTOR_PROVIDER_CAPABILITIES = {
  [OPENAI_COMPATIBLE_EMBEDDING_PROVIDER]: {
    capability: "semantic",
    semantic: true,
    description: "OpenAI-compatible /v1/embeddings provider. Requires an embedding model endpoint."
  },
  [LM_STUDIO_EMBEDDING_PROVIDER]: {
    capability: "semantic",
    semantic: true,
    description: "LM Studio /v1/embeddings provider. Requires an embedding model loaded in LM Studio."
  }
};

// --- embedding auto-detection + model pin (no-silent-failure policy) -------
// semantic retrieval is required. There is no lexical/ngram fallback. When no
// endpoint is explicitly configured we auto-detect a local Ollama / LM Studio
// that serves the pinned embedding model. A reachable endpoint that does NOT
// serve the pinned model is treated as absent (loud), so model/dimension
// mismatch can never silently corrupt rankings.

export const PINNED_EMBEDDING_MODEL = "nomic-embed-text";

// --- R1 接頭辞ポリシー -------------------------------------------------------
// 一部の埋め込みモデル (nomic-embed-text など) は、検索文書と検索クエリで別々の
// 接頭辞を付けると非対称検索の精度が上がる。モデル名 → { document, query } を
// ここに登録する。未登録モデルは接頭辞なし (素のテキストを埋め込む = 従来挙動)。
//
// 互換の要: index 構築時に「適用したポリシー」を vector.json メタ (prefix_policy)
// に記録し、クエリ側は **index のメタを読んで** ポリシーが在る index にだけ
// query 接頭辞を付ける。メタ無し (旧 index) には決して付けない (document 側に
// 接頭辞が無いのに query 側だけ付けると非対称が壊れて精度が落ちる)。
export const EMBEDDING_PREFIX_POLICIES: Record<string, { document: string; query: string }> = {
  "nomic-embed-text": { document: "search_document: ", query: "search_query: " }
};

// モデル名から接頭辞ポリシーを引く。モデル名は "nomic-embed-text:latest" のような
// タグ付きでも来るので、modelMatchesPinned と同じ前方一致で登録キーに当てる。
// mode === "off" なら常に null (ポリシー無効化)。
export function prefixPolicyForModel(
  model: string | null | undefined,
  mode: "auto" | "off" = "auto"
): { document: string; query: string } | null {
  if (mode === "off") return null;
  if (typeof model !== "string" || model.length === 0) return null;
  for (const [key, policy] of Object.entries(EMBEDDING_PREFIX_POLICIES)) {
    if (model === key || model.startsWith(`${key}:`) || model.startsWith(key)) return policy;
  }
  return null;
}

// index のポリシー (vector.json メタ prefix_policy) に従って接頭辞を付けて埋め込む
// 共通ヘルパ。重複ゲート・提案器が「索引と同じ空間」で text を埋め込むために使う。
// kind: "document"=文書側接頭辞 / "query"=クエリ側接頭辞。メタ無し index では
// 接頭辞を付けない (旧 index 互換)。
export async function embedForIndex(
  vectorIndex: any,
  text: string,
  kind: "document" | "query"
): Promise<number[]> {
  const providerName = vectorIndex?.provider;
  if (!providerName) {
    throw new Error("Missing vector index provider. Rebuild the vector index with a semantic embedding provider.");
  }
  const provider = createVectorProvider({
    provider: providerName,
    dimensions: vectorIndex?.dimensions,
    endpoint: vectorIndex?.provider_options?.endpoint,
    model: vectorIndex?.provider_options?.model
  });
  const policy = vectorIndex?.prefix_policy ?? null;
  const prefix = policy && typeof policy[kind] === "string" ? policy[kind] : "";
  return provider.embed(`${prefix}${text}`);
}

export const DEFAULT_LOCAL_EMBEDDING_BASES = [
  { provider: OPENAI_COMPATIBLE_EMBEDDING_PROVIDER, label: "Ollama", base: "http://localhost:11434/v1" },
  { provider: LM_STUDIO_EMBEDDING_PROVIDER, label: "LM Studio", base: "http://localhost:1234/v1" }
];

function embeddingsUrlFromBase(base) {
  return `${String(base).replace(/\/$/, "")}/embeddings`;
}

function modelsUrlFromBase(base) {
  return `${String(base).replace(/\/$/, "")}/models`;
}

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// embedding endpoint への fetch は無制限に待たない。endpoint が「ポートは開くが応答しない /
// DNS ブラックホール」状態だと素の fetch は永久にハングし、(索引ビルドをロック外へ出した後でも)
// プロセスがそこで固まる。AbortController で上限を課し、超過は abort=失敗として扱う。
// 値は環境変数で上書き可能 (CPU が遅く 1 件の embedding に時間がかかる環境向け)。
export const EMBEDDING_FETCH_TIMEOUT_MS = readPositiveIntEnv("GRAPHRAG_EMBEDDING_TIMEOUT_MS", 60_000);
export const MODELS_PROBE_TIMEOUT_MS = readPositiveIntEnv("GRAPHRAG_EMBEDDING_PROBE_TIMEOUT_MS", 10_000);

export async function fetchWithTimeout(
  url,
  options: any = {},
  timeoutMs = EMBEDDING_FETCH_TIMEOUT_MS,
  fetchImpl = fetch
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function baseFromEndpoint(endpoint) {
  return String(endpoint).replace(/\/embeddings\/?$/, "");
}

function modelMatchesPinned(id, pinned = PINNED_EMBEDDING_MODEL) {
  if (typeof id !== "string") return false;
  return id === pinned || id.startsWith(`${pinned}:`) || id.startsWith(pinned);
}

// Returns string[] of model ids, or null when the endpoint is unreachable /
// not an OpenAI-compatible models endpoint.
async function listModels(base, apiKey) {
  let response;
  try {
    response = await fetchWithTimeout(modelsUrlFromBase(base), {
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }
    }, MODELS_PROBE_TIMEOUT_MS);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let payload;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data.map((entry) => entry?.id).filter((id) => typeof id === "string");
}

function embeddingUnavailableError(reason) {
  return new Error(
    [
      `Semantic embedding unavailable: ${reason}.`,
      `semantic retrieval is required and lexical/ngram fallback is disabled.`,
      `Enable one of:`,
      `  - Ollama: run "ollama serve" then "ollama pull ${PINNED_EMBEDDING_MODEL}" (OpenAI-compatible at http://localhost:11434/v1)`,
      `  - LM Studio: load "${PINNED_EMBEDDING_MODEL}" and start the local server (http://localhost:1234/v1)`,
      `  - or set GRAPHRAG_EMBEDDING_ENDPOINT to an OpenAI-compatible /v1/embeddings endpoint serving ${PINNED_EMBEDDING_MODEL}.`
    ].join("\n")
  );
}

// Resolve an embedding target. Explicit env/options take precedence; otherwise
// auto-detect. Throws a single actionable error when nothing usable is found
// or a reachable endpoint does not serve the pinned/expected model.
export async function resolveEmbeddingTarget(options: any = {}) {
  const apiKey = options.apiKey ?? process.env.GRAPHRAG_EMBEDDING_API_KEY;
  const explicitEndpoint = options.endpoint ?? process.env.GRAPHRAG_EMBEDDING_ENDPOINT;

  if (explicitEndpoint) {
    const provider = options.provider
      ?? process.env.GRAPHRAG_VECTOR_PROVIDER
      ?? OPENAI_COMPATIBLE_EMBEDDING_PROVIDER;
    const model = options.model ?? process.env.GRAPHRAG_EMBEDDING_MODEL ?? PINNED_EMBEDDING_MODEL;
    const base = baseFromEndpoint(explicitEndpoint);
    const models = await listModels(base, apiKey);
    if (models && !models.some((id) => modelMatchesPinned(id, model))) {
      throw embeddingUnavailableError(
        `configured endpoint ${explicitEndpoint} does not serve model "${model}" (available: ${models.slice(0, 12).join(", ") || "none"})`
      );
    }
    return { provider, endpoint: embeddingsUrlFromBase(base), model, apiKey };
  }

  const failures = [];
  for (const candidate of DEFAULT_LOCAL_EMBEDDING_BASES) {
    const models = await listModels(candidate.base, apiKey);
    if (models === null) {
      failures.push(`${candidate.label} (${candidate.base}) unreachable`);
      continue;
    }
    const match = models.find((id) => modelMatchesPinned(id));
    if (!match) {
      failures.push(`${candidate.label} reachable but no "${PINNED_EMBEDDING_MODEL}" (has: ${models.slice(0, 8).join(", ") || "none"})`);
      continue;
    }
    return { provider: candidate.provider, endpoint: embeddingsUrlFromBase(candidate.base), model: match, apiKey };
  }
  throw embeddingUnavailableError(`auto-detect found nothing usable [${failures.join("; ")}]`);
}

// Async front door for building/embedding paths: detect + pin, then build the
// low-level sync provider with the resolved endpoint/model.
export async function resolveVectorProvider(options: any = {}) {
  const target = await resolveEmbeddingTarget(options);
  return createVectorProvider({
    provider: target.provider,
    endpoint: target.endpoint,
    model: target.model,
    apiKey: target.apiKey,
    dimensions: options.dimensions
  });
}

// Query-time guard: the index recorded which endpoint/model built it. Verify
// that endpoint still serves that model before embedding a query, so a swapped
// model cannot silently produce mis-ranked results.
export async function assertEmbeddingModelAvailable(endpoint, model, apiKey) {
  const base = baseFromEndpoint(endpoint);
  const models = await listModels(base, apiKey);
  if (models === null) {
    throw embeddingUnavailableError(`recorded endpoint ${endpoint} unreachable`);
  }
  if (!models.some((id) => modelMatchesPinned(id, model))) {
    throw embeddingUnavailableError(
      `recorded model "${model}" not served by ${endpoint} (available: ${models.slice(0, 12).join(", ") || "none"})`
    );
  }
}

export function createVectorProvider(options: any = {}) {
  const provider = options.provider ?? process.env.GRAPHRAG_VECTOR_PROVIDER;
  if (!provider) {
    throw new Error("Missing vector provider. Set GRAPHRAG_VECTOR_PROVIDER to a semantic embedding provider.");
  }

  if (OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
    const endpoint = options.endpoint ?? process.env.GRAPHRAG_EMBEDDING_ENDPOINT;
    const model = options.model ?? process.env.GRAPHRAG_EMBEDDING_MODEL;
    const apiKey = options.apiKey ?? process.env.GRAPHRAG_EMBEDDING_API_KEY;
    if (!endpoint) {
      throw new Error(`Missing embedding endpoint for vector provider: ${provider}`);
    }
    if (!model) {
      throw new Error(`Missing embedding model for vector provider: ${provider}`);
    }
    return {
      id: provider,
      capability: "semantic",
      semantic: true,
      dimensions: options.dimensions ? Number(options.dimensions) : null,
      metadata: {
        provider,
        provider_capability: "semantic",
        semantic: true,
        endpoint,
        model,
        dimensions: options.dimensions ? Number(options.dimensions) : null
      },
      async embed(text) {
        const vector = await embedOpenAiCompatibleText({ endpoint, model, apiKey, text });
        if (options.dimensions && vector.length !== Number(options.dimensions)) {
          throw new Error(`Embedding dimensions mismatch for ${provider}: expected ${options.dimensions}, got ${vector.length}`);
        }
        return normalizeVector(vector);
      }
    };
  }

  throw new Error(`Unknown vector provider: ${provider}`);
}

export async function embedQueryForVectorIndex(query, vectorIndex) {
  const providerName = vectorIndex?.provider;
  if (!providerName) {
    throw new Error("Missing vector index provider. Rebuild the vector index with a semantic embedding provider.");
  }
  const provider = createVectorProvider({
    provider: providerName,
    dimensions: vectorIndex?.dimensions,
    endpoint: vectorIndex?.provider_options?.endpoint,
    model: vectorIndex?.provider_options?.model
  });
  if (vectorIndex?.provider_options?.endpoint) {
    await assertEmbeddingModelAvailable(
      vectorIndex.provider_options.endpoint,
      vectorIndex.provider_options.model,
      process.env.GRAPHRAG_EMBEDDING_API_KEY
    );
  }
  // R1: index のメタ (prefix_policy) が在る索引にだけ query 接頭辞を付ける。
  // メタ無し (旧 index) には付けない ── document 側に接頭辞が無いのに query 側だけ
  // 付けると非対称が壊れるため、これが互換の要。
  const policy = vectorIndex?.prefix_policy ?? null;
  const prefix = policy && typeof policy.query === "string" ? policy.query : "";
  return provider.embed(`${prefix}${query}`);
}

export function describeVectorIndex(vectorIndex, fallbackProvider = null) {
  if (!vectorIndex) {
    const capability = VECTOR_PROVIDER_CAPABILITIES[fallbackProvider]?.capability ?? "unknown";
    return {
      provider: fallbackProvider ? `on-the-fly ${fallbackProvider}` : null,
      provider_capability: capability,
      semantic: Boolean(VECTOR_PROVIDER_CAPABILITIES[fallbackProvider]?.semantic),
      dimensions: null,
      rows: 0
    };
  }
  const capability = vectorIndex.provider_capability
    ?? VECTOR_PROVIDER_CAPABILITIES[vectorIndex.provider]?.capability
    ?? "unknown";
  return {
    provider: vectorIndex.provider,
    provider_capability: capability,
    semantic: vectorIndex.semantic ?? Boolean(VECTOR_PROVIDER_CAPABILITIES[vectorIndex.provider]?.semantic),
    dimensions: vectorIndex.dimensions,
    rows: vectorIndex.rows?.length ?? 0,
    model: vectorIndex.provider_options?.model ?? vectorIndex.model ?? null
  };
}

export function cosineSimilarity(left, right) {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += left[index] * right[index];
  }
  return sum;
}

export function nodeVectorText(node) {
  // node.id は識別子であって意味ではない。embedding に含めると id の canonical 化
  // (concern:→vein: 等) で埋め込みが動き検索が移行に反応するため、除外する。
  // provisional 要約 (index-codebase の機械テンプレ。実際にファイルを読んだ要約では
  // ない) は embedding に含めない。含めると "typescript" / "ソース" / import 名のような
  // 言語・構造語が埋め込みを支配し、File 同士が言語/階層で固まって縦串 (Concern) 検出が
  // 無意味化する。LLM が本物の要約に書き換え provisional を外せば自然に embedding 入りする。
  return [
    node.type,
    node.title,
    node.summary_provisional ? undefined : node.summary,
    node.description,
    node.path,
    ...(node.aliases ?? []),
    ...(node.tags ?? []),
    ...displayTextFields(node.display)
  ].filter((value) => typeof value === "string" && value.length > 0).join("\n");
}

function displayTextFields(display) {
  const fields = [];
  visitDisplayValue(display, fields);
  return fields;
}

function visitDisplayValue(value, fields) {
  if (typeof value === "string" && value.length > 0) {
    fields.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitDisplayValue(item, fields);
    return;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) visitDisplayValue(child, fields);
  }
}

async function embedOpenAiCompatibleText({ endpoint, model, apiKey, text }) {
  let response;
  try {
    response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        input: text
      })
    }, EMBEDDING_FETCH_TIMEOUT_MS);
  } catch (error) {
    const cause = error?.cause?.code ?? error?.message ?? "unknown error";
    throw new Error(
      `Embedding endpoint unavailable: ${endpoint} (${cause}). Start the configured semantic embedding server or update GRAPHRAG_EMBEDDING_ENDPOINT; lexical ngram vector fallback is disabled.`
    );
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding request failed: ${response.status} ${response.statusText} ${body.slice(0, 500)}`);
  }
  const payload = await response.json();
  const vector = payload?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("Embedding response did not include data[0].embedding");
  }
  return vector.map((value) => Number(value));
}

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

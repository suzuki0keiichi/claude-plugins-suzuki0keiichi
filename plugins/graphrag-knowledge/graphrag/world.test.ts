import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadWorldConfig,
  parseVaultProfile,
  readVaultProfile,
  vaultProfilePath,
  refreshWorldCache,
  loadWorldCache,
  buildWorldHints,
  buildWorldRefreshReport,
  countVaultNodes,
  introHint,
  worldCachePath,
  isRemoteRef
} from "./world.ts";

// --- テスト用の決定的な embedder ---------------------------------------------
// テキスト中のマーカー語で固定ベクトルを返す。ネットワーク不要・再現可能。
function fakeEmbedder(calls?: string[]) {
  return {
    id: "fake-embedding",
    metadata: { endpoint: "http://fake/v1/embeddings", model: "fake-model" },
    async embed(text: string): Promise<number[]> {
      calls?.push(text);
      if (text.includes("決済")) return [1, 0, 0];
      if (text.includes("認証")) return [0, 1, 0];
      return [0, 0, 1];
    }
  };
}

function makeWorld(structure: { [vaultName: string]: string | null }): {
  worldDir: string;
  root: string;
  vaultDirs: { [name: string]: string };
} {
  const root = mkdtempSync(path.join(tmpdir(), "grag-world-"));
  const worldDir = path.join(root, "world");
  mkdirSync(worldDir, { recursive: true });
  const vaultDirs: { [name: string]: string } = {};
  const refs: string[] = [];
  for (const [name, profile] of Object.entries(structure)) {
    const vaultDir = path.join(root, name, "vault");
    mkdirSync(vaultDir, { recursive: true });
    if (profile !== null) {
      writeFileSync(path.join(root, name, "VAULT.md"), profile);
    }
    vaultDirs[name] = vaultDir;
    refs.push(vaultDir);
  }
  writeFileSync(path.join(worldDir, "world.json"), JSON.stringify({ vaults: refs }, null, 2));
  return { worldDir, root, vaultDirs };
}

const PAYMENT_PROFILE = `---
name: payment-vault
---
決済まわりの設計判断・リスク・運用知識のグラフ。
`;

const AUTH_PROFILE = `---
name: auth-vault
---
認証・認可基盤の設計判断のグラフ。
`;

// --- world.json (住所録) ------------------------------------------------------

test("loadWorldConfig accepts path strings and {path} objects", () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-worldcfg-"));
  try {
    writeFileSync(path.join(root, "world.json"), JSON.stringify({
      vaults: ["/a/vault", { path: "/b/vault" }]
    }));
    const config = loadWorldConfig(root);
    assert.deepEqual(config.vaults, [{ path: "/a/vault" }, { path: "/b/vault" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadWorldConfig rejects entries with description (world is pointers only)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-worldcfg-"));
  try {
    writeFileSync(path.join(root, "world.json"), JSON.stringify({
      vaults: [{ path: "/a/vault", description: "決済の vault" }]
    }));
    assert.throws(() => loadWorldConfig(root), /extra keys.*description.*VAULT\.md/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadWorldConfig fails loudly when world.json is missing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-worldcfg-"));
  try {
    assert.throws(() => loadWorldConfig(root), /world\.json not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isRemoteRef detects git URLs but not local paths", () => {
  assert.equal(isRemoteRef("https://github.com/u/r.git"), true);
  assert.equal(isRemoteRef("git@github.com:u/r.git"), true);
  assert.equal(isRemoteRef("/Users/k/git/some-vault/vault"), false);
  assert.equal(isRemoteRef("../relative/vault"), false);
});

// --- VAULT.md (自己紹介の正本) -------------------------------------------------

test("parseVaultProfile reads frontmatter name and body description", () => {
  const parsed = parseVaultProfile(PAYMENT_PROFILE);
  assert.equal(parsed.name, "payment-vault");
  assert.match(parsed.description, /決済まわり/);
});

test("parseVaultProfile works without frontmatter (description only)", () => {
  const parsed = parseVaultProfile("ただの説明文。\n");
  assert.equal(parsed.name, null);
  assert.equal(parsed.description, "ただの説明文。");
});

test("vaultProfilePath is the sibling of the vault dir (next to .graphrag)", () => {
  assert.equal(vaultProfilePath("/a/b/vault"), path.join("/a/b", "VAULT.md"));
});

test("readVaultProfile falls back to parent folder name when name is missing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-profile-"));
  try {
    const vaultDir = path.join(root, "my-repo", "vault");
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(path.join(root, "my-repo", "VAULT.md"), "説明だけ。\n");
    const read = readVaultProfile(vaultDir);
    assert.equal(read?.profile.name, "my-repo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- world-refresh (写しの構築) -------------------------------------------------

test("refreshWorldCache embeds each local vault profile and writes the cache atomically", async () => {
  const { worldDir, root, vaultDirs } = makeWorld({ pay: PAYMENT_PROFILE, auth: AUTH_PROFILE });
  try {
    const cache = await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    assert.equal(cache.entries.length, 2);
    assert.ok(cache.entries.every((e) => e.status === "ok" && e.vector && e.content_hash && e.fetched_at));
    assert.equal(cache.provider, "fake-embedding");
    assert.equal(cache.provider_options?.model, "fake-model");
    const onDisk = loadWorldCache(worldDir);
    assert.deepEqual(onDisk?.entries.map((e) => e.vault_path).sort(), [
      path.resolve(vaultDirs.auth),
      path.resolve(vaultDirs.pay)
    ].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshWorldCache marks vaults without VAULT.md as no-profile (non-fatal)", async () => {
  const { worldDir, root } = makeWorld({ pay: PAYMENT_PROFILE, naked: null });
  try {
    const cache = await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    const statuses = cache.entries.map((e) => e.status).sort();
    assert.deepEqual(statuses, ["no-profile", "ok"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshWorldCache marks remote refs as remote-unsupported (loud, not silent)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-world-"));
  try {
    const worldDir = path.join(root, "world");
    mkdirSync(worldDir, { recursive: true });
    writeFileSync(path.join(worldDir, "world.json"), JSON.stringify({
      vaults: ["https://github.com/u/r.git"]
    }));
    const cache = await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    assert.equal(cache.entries[0].status, "remote-unsupported");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- world-refresh 出力強化 (mtime / ノード数 / intro_hint) -----------------------

test("refreshWorldCache records VAULT.md mtime and vault node count per entry", async () => {
  const { worldDir, root, vaultDirs } = makeWorld({ pay: PAYMENT_PROFILE, naked: null });
  try {
    writeFileSync(path.join(vaultDirs.pay, "decision-a.md"), "# a\n");
    mkdirSync(path.join(vaultDirs.pay, "Risk"), { recursive: true });
    writeFileSync(path.join(vaultDirs.pay, "Risk", "risk-b.md"), "# b\n");
    writeFileSync(path.join(vaultDirs.pay, "not-a-node.txt"), "ignored\n");
    const cache = await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    const pay = cache.entries.find((e) => e.vault_path === path.resolve(vaultDirs.pay))!;
    assert.equal(pay.node_count, 2); // .md のみ数える (1 ファイル = 1 ノード)
    assert.ok(pay.profile_mtime && !Number.isNaN(Date.parse(pay.profile_mtime)));
    // VAULT.md 無し (no-profile) でも蓄積量は見える / mtime は無いものは無い
    const naked = cache.entries.find((e) => e.vault_path === path.resolve(vaultDirs.naked))!;
    assert.equal(naked.profile_mtime, null);
    assert.equal(naked.node_count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("countVaultNodes returns null for a missing dir (absence is not zero)", () => {
  assert.equal(countVaultNodes("/no/such/vault/dir"), null);
});

test("introHint fires only when VAULT.md is older than 45 days", () => {
  const mtime = "2026-01-01T00:00:00.000Z";
  assert.equal(introHint(mtime, "2026-02-14T00:00:00.000Z"), null); // 44 日
  assert.equal(introHint(mtime, "2026-02-15T00:00:00.000Z"), null); // ちょうど 45 日
  assert.equal(
    introHint(mtime, "2026-03-02T00:00:00.000Z"), // 60 日
    "VAULT.md が 60日前から未更新。蓄積に対して自己紹介が古い可能性"
  );
  assert.equal(introHint(null, "2026-03-02T00:00:00.000Z"), null); // mtime 不明は判定しない
});

test("buildWorldRefreshReport includes mtime/node_count and attaches intro_hint to stale intros", async () => {
  const { worldDir, root, vaultDirs } = makeWorld({ pay: PAYMENT_PROFILE, auth: AUTH_PROFILE });
  try {
    writeFileSync(path.join(vaultDirs.pay, "decision-a.md"), "# a\n");
    const cache = await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    // VAULT.md はテストで今書いたばかり → 60 日後の now を注入すると全 vault が stale
    const farFuture = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const stale = buildWorldRefreshReport(worldDir, cache, { now: () => farFuture });
    const payStale = stale.vaults.find((v) => v.vault_path === path.resolve(vaultDirs.pay))!;
    assert.equal(payStale.node_count, 1);
    assert.equal(payStale.profile_mtime, cache.entries.find((e) => e.vault_path === payStale.vault_path)!.profile_mtime);
    assert.match(payStale.intro_hint ?? "", /VAULT\.md が \d+日前から未更新。蓄積に対して自己紹介が古い可能性/);
    // 今の now では新鮮 → intro_hint は付かない (ノイズを足さない)
    const fresh = buildWorldRefreshReport(worldDir, cache);
    assert.ok(fresh.vaults.every((v) => !("intro_hint" in v)));
    assert.equal(fresh.world_dir, worldDir);
    assert.equal(fresh.cache_path, worldCachePath(worldDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWorldRefreshReport tolerates pre-upgrade cache entries without the new fields", async () => {
  const { worldDir, root } = makeWorld({ pay: PAYMENT_PROFILE });
  try {
    const cache = await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    // 旧フォーマットの cache (フィールド欠落) を再現
    for (const e of cache.entries) {
      delete (e as any).profile_mtime;
      delete (e as any).node_count;
    }
    const report = buildWorldRefreshReport(worldDir, cache);
    assert.equal(report.vaults[0].profile_mtime, null);
    assert.equal(report.vaults[0].node_count, null);
    assert.ok(!("intro_hint" in report.vaults[0]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- ask 時のヒント -------------------------------------------------------------

test("buildWorldHints ranks the semantically close vault and excludes the current vault", async () => {
  const { worldDir, root, vaultDirs } = makeWorld({
    pay: PAYMENT_PROFILE,
    auth: AUTH_PROFILE,
    dev: `---\nname: dev-vault\n---\n開発プロセスの vault。\n`
  });
  try {
    await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    const result = await buildWorldHints("決済 リトライ 設計", {
      worldDir,
      currentVaultDir: vaultDirs.dev,
      queryVector: [1, 0, 0],
      queryModel: "fake-model",
      embedder: fakeEmbedder()
    });
    assert.equal(result.considered, 2); // dev (current) は除外
    assert.ok(result.hints.length >= 1);
    assert.equal(result.hints[0].vault.name, "payment-vault");
    assert.match(result.hints[0].vault.description, /決済まわり/); // 自己紹介本文も判断材料として載る
    assert.ok(result.hints[0].ask_command.includes(`--vault ${path.resolve(vaultDirs.pay)}`));
    assert.ok(result.hints.every((h) => h.vault.path !== path.resolve(vaultDirs.dev)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWorldHints reuses the local query vector when model and dimensions match", async () => {
  const { worldDir, root, vaultDirs } = makeWorld({ pay: PAYMENT_PROFILE, auth: AUTH_PROFILE });
  try {
    await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    const calls: string[] = [];
    await buildWorldHints("決済", {
      worldDir,
      currentVaultDir: vaultDirs.auth,
      queryVector: [1, 0, 0],
      queryModel: "fake-model",
      embedder: fakeEmbedder(calls)
    });
    // model 一致 → クエリの再 embedding は走らない (自己紹介の再 embedding も不要)
    assert.deepEqual(calls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWorldHints re-embeds the query when the local index model differs", async () => {
  const { worldDir, root, vaultDirs } = makeWorld({ pay: PAYMENT_PROFILE, auth: AUTH_PROFILE });
  try {
    await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    const calls: string[] = [];
    const result = await buildWorldHints("決済", {
      worldDir,
      currentVaultDir: vaultDirs.auth,
      queryVector: [0.5, 0.5], // 次元も model も違う手元 index
      queryModel: "other-model",
      embedder: fakeEmbedder(calls)
    });
    assert.deepEqual(calls, ["決済"]); // cache 側 model でクエリを embed し直す
    assert.equal(result.semantic, true);
    assert.equal(result.hints[0]?.vault.name, "payment-vault");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWorldHints builds the cache on first use when world-cache.json is absent", async () => {
  const { worldDir, root, vaultDirs } = makeWorld({ pay: PAYMENT_PROFILE, auth: AUTH_PROFILE });
  try {
    assert.equal(existsSync(worldCachePath(worldDir)), false);
    const result = await buildWorldHints("決済", {
      worldDir,
      currentVaultDir: vaultDirs.auth,
      queryVector: [1, 0, 0],
      queryModel: "fake-model",
      embedder: fakeEmbedder()
    });
    assert.equal(existsSync(worldCachePath(worldDir)), true);
    assert.equal(result.hints[0]?.vault.name, "payment-vault");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWorldHints detects a changed VAULT.md by hash and re-embeds only that vault", async () => {
  const { worldDir, root, vaultDirs } = makeWorld({ pay: PAYMENT_PROFILE, auth: AUTH_PROFILE });
  try {
    await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    // pay の自己紹介を書き換え → 内容が認証寄りに変わる
    writeFileSync(path.join(root, "pay", "VAULT.md"), `---\nname: payment-vault\n---\n実は認証も扱う。\n`);
    const calls: string[] = [];
    const result = await buildWorldHints("認証 フロー", {
      worldDir,
      currentVaultDir: vaultDirs.auth, // auth を手元にして pay だけが候補
      queryVector: [0, 1, 0],
      queryModel: "fake-model",
      embedder: fakeEmbedder(calls)
    });
    assert.equal(calls.length, 1); // 変わった pay の自己紹介だけ再 embedding
    assert.match(calls[0], /実は認証も扱う/);
    assert.equal(result.hints[0]?.vault.name, "payment-vault");
    assert.equal(result.hints[0]?.freshness.state, "refreshed");
    // cache も更新されている
    const onDisk = loadWorldCache(worldDir)!;
    const pay = onDisk.entries.find((e) => e.vault_path === path.resolve(vaultDirs.pay))!;
    assert.match(pay.profile!.description, /実は認証も扱う/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWorldHints keeps the stale copy and says so when re-embedding fails", async () => {
  const { worldDir, root, vaultDirs } = makeWorld({ pay: PAYMENT_PROFILE, auth: AUTH_PROFILE });
  try {
    await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    writeFileSync(path.join(root, "pay", "VAULT.md"), PAYMENT_PROFILE + "\n追記。\n");
    const failingEmbedder = {
      id: "fake-embedding",
      metadata: { endpoint: "http://fake/v1/embeddings", model: "fake-model" },
      async embed(): Promise<number[]> {
        throw new Error("endpoint down");
      }
    };
    const result = await buildWorldHints("決済", {
      worldDir,
      currentVaultDir: vaultDirs.auth,
      queryVector: [1, 0, 0],
      queryModel: "fake-model",
      embedder: failingEmbedder
    });
    const hint = result.hints.find((h) => h.vault.name === "payment-vault");
    assert.ok(hint);
    assert.equal(hint!.freshness.state, "stale");
    assert.match(hint!.freshness.detail ?? "", /endpoint down/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWorldHints reports vaults without profile as unavailable", async () => {
  const { worldDir, root, vaultDirs } = makeWorld({ pay: PAYMENT_PROFILE, naked: null });
  try {
    await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    const result = await buildWorldHints("決済", {
      worldDir,
      currentVaultDir: undefined,
      queryVector: [1, 0, 0],
      queryModel: "fake-model",
      embedder: fakeEmbedder()
    });
    assert.equal(result.unavailable.length, 1);
    assert.equal(result.unavailable[0].status, "no-profile");
    assert.equal(result.unavailable[0].vault_path, path.resolve(vaultDirs.naked));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 相対判定 (standout) ---------------------------------------------------------

test("buildWorldHints upgrades a clearly standing-out top1 from low to high", async () => {
  const { worldDir, root, vaultDirs } = makeWorld({ pay: PAYMENT_PROFILE, auth: AUTH_PROFILE, dev: `---\nname: dev-vault\n---\n開発プロセス。\n` });
  try {
    await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    // クエリベクトルを pay と cos=0.6 (絶対値では low) になるよう作る。
    // lexical も pay にだけ部分一致する語を含め、合算で top1 が突出する状況。
    const result = await buildWorldHints("決済 引き落とし 再実行", {
      worldDir,
      currentVaultDir: vaultDirs.dev,
      queryVector: [0.6, 0, 0],
      queryModel: "fake-model",
      embedder: fakeEmbedder()
    });
    assert.equal(result.standout, "clear");
    assert.equal(result.hints[0].vault.name, "payment-vault");
    assert.equal(result.hints[0].confidence, "high"); // vector 0.60 単体なら low → 突出で格上げ
    assert.ok((result.hints[0].gap_above_next ?? 0) >= 15);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWorldHints reports crowd (no upgrade) when candidates are neck and neck", async () => {
  const { worldDir, root, vaultDirs } = makeWorld({
    pay: PAYMENT_PROFILE,
    pay2: `---\nname: payment-vault-2\n---\n決済まわりの設計判断のグラフその2。\n`,
    dev: `---\nname: dev-vault\n---\n開発プロセス。\n`
  });
  try {
    // pay2 も「決済」マーカーで pay と同じ固定ベクトルになる → 意味も字面も横並び
    await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    const result = await buildWorldHints("決済 周辺の設計", {
      worldDir,
      currentVaultDir: vaultDirs.dev,
      queryVector: [0.6, 0.8, 0],
      queryModel: "fake-model",
      embedder: fakeEmbedder()
    });
    assert.equal(result.standout, "crowd");
    // 横並びでは格上げしない (両方 low のまま、判断材料ごと呼び手へ)
    assert.ok(result.hints.every((h) => h.confidence === "low"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWorldHints reports single when only one candidate vault exists", async () => {
  const { worldDir, root, vaultDirs } = makeWorld({ pay: PAYMENT_PROFILE, auth: AUTH_PROFILE });
  try {
    await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    const result = await buildWorldHints("決済", {
      worldDir,
      currentVaultDir: vaultDirs.auth, // 候補は pay のみ
      queryVector: [1, 0, 0],
      queryModel: "fake-model",
      embedder: fakeEmbedder()
    });
    assert.equal(result.standout, "single");
    assert.equal(result.hints[0]?.gap_above_next, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWorldHints filters out vaults with no meaningful match (confidence none)", async () => {
  const { worldDir, root, vaultDirs } = makeWorld({
    pay: PAYMENT_PROFILE,
    other: `---\nname: other-vault\n---\n営業資料の置き場。\n`
  });
  try {
    await refreshWorldCache(worldDir, { embedder: fakeEmbedder() });
    const result = await buildWorldHints("決済 リトライ", {
      worldDir,
      currentVaultDir: undefined,
      queryVector: [1, 0, 0],
      queryModel: "fake-model",
      embedder: fakeEmbedder()
    });
    // other-vault は意味も字面も遠い → ヒントに出ない
    assert.ok(result.hints.every((h) => h.vault.name !== "other-vault"));
    assert.equal(result.hints[0]?.vault.name, "payment-vault");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

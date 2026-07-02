// v1.10 upgrade rehearsal (end-to-end):
// 「1.9.1 時代の実環境を 1.10 の CLI で開いたら一連のセッションが全部通る」を
// 1 本のリハーサルで検証する。個別 fallback の unit テストは各所にあるが、
// ここでは *同時に* 全部が積まれた faithful なレイアウトを本物のサブプロセス
// (node --experimental-strip-types graphrag/cli.ts <verb>) で叩く:
//   - .graphrag/vault/ … 小さな正規 vault (JA+EN タイトル)、git commit 済み
//   - .graphrag/ 直下 (legacy 位置, cache/ でない) … noise_baseline 無しの旧
//     vector.json / 旧 ask-state.json / stale な vault.seq
//   - .graphrag/.env … GRAPHRAG_VAULT_MODE=worktree (legacy 値)
// シーケンス: inspect → ask (legacy 索引で読める / worktree は警告のみ) →
// add-decision (repo-local vault は mode 不要で書ける / commit は vault のみ) →
// vector-index 再構築 (新 cache/ へ, noise_baseline 打刻) → ask (confidence 健在) →
// 最後に「セッションが .graphrag/ の外に 1 ファイルも作らない」ゴミ回帰ガード。
//
// hermetic: HOME を空 tmp に差し替え (~/.graphrag/.env 遮断)、GRAPHRAG_* shell env は
// 明示的に unset/上書き、embedding はローカルのモック endpoint (全入力に同一ベクトル)。
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { execFile, execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
  existsSync, realpathSync, readdirSync, utimesSync
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildVaultFiles } from "./build-vault.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
const FIXED_TS = "2026-01-01T00:00:00.000Z";

/** OpenAI 互換 embedding endpoint のモック。全入力に同一ベクトル [1,0] を返す。 */
function startEmbeddingMock(): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && (req.url ?? "").includes("/models")) {
        res.end(JSON.stringify({ data: [{ id: "nomic-embed-text" }] }));
        return;
      }
      req.resume();
      req.on("end", () => {
        res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        base: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

/** 本物の CLI をサブプロセスで叩く (同期 exec はモック endpoint を塞ぐので async)。 */
function runCli(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "node", ["--experimental-strip-types", CLI, ...args],
      { cwd: opts.cwd, env: opts.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? ((err as any).code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr)
        });
      }
    );
  });
}

/** repo 内の全ファイル (相対パス集合)。.git は対象外 (vault commit で当然変わる)。 */
function listFiles(root: string): Set<string> {
  const out = new Set<string>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = path.relative(root, path.join(entry.parentPath, entry.name));
    if (rel === ".git" || rel.startsWith(`.git${path.sep}`)) continue;
    out.add(rel);
  }
  return out;
}

/** cli-ask-state.fingerprintQuestion と同じ規約 (sha1(trim) 先頭 8 hex)。 */
function fingerprintQuestion(question: string): string {
  return createHash("sha1").update(question.trim()).digest("hex").slice(0, 8);
}

const QUESTION = "認証 authentication の制約は?";
const QUESTION_2 = "JWT トークン token の判断は?";

test("upgrade rehearsal: 1.9.1 レイアウトを 1.10 CLI で開いて一連のセッションが通る", async (t) => {
  // ── fixture: faithful な pre-1.10 環境 ────────────────────────────────
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "upg-repo-")));
  const fakeHome = realpathSync(mkdtempSync(path.join(tmpdir(), "upg-home-")));
  const mock = await startEmbeddingMock();

  const graphragDir = path.join(repo, ".graphrag");
  const vaultDir = path.join(graphragDir, "vault");
  const cacheDir = path.join(graphragDir, "cache");
  const legacyVectorPath = path.join(graphragDir, "vector.json");
  const legacyAskStatePath = path.join(graphragDir, "ask-state.json");

  try {
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);

    // ソースファイル (File ノードの実体) + 小さな vault (JA+EN タイトル混在)。
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(path.join(repo, "src", "auth.ts"), "export const auth = 1;\n");
    const seedGraph = {
      generated_at: FIXED_TS,
      nodes: [
        { id: "file:s:src/app.ts", type: "File", title: "app.ts", path: "src/app.ts" },
        { id: "file:s:src/auth.ts", type: "File", title: "auth.ts", path: "src/auth.ts" },
        {
          id: "constraint:s:jwt-only", type: "Constraint",
          title: "認証は JWT のみ",
          summary: "authentication must use JWT (JWT 以外の認証方式は導入しない)"
        },
        {
          id: "goal:s:secure-auth", type: "Goal",
          title: "Secure authentication (安全な認証)",
          summary: "認証まわりの安全性を落とさない"
        }
      ],
      edges: [
        {
          id: "constraint_s_jwt-only__constrains__file_s_src_auth.ts",
          type: "constrains", from: "constraint:s:jwt-only", to: "file:s:src/auth.ts"
        }
      ]
    };
    for (const f of buildVaultFiles(seedGraph)) {
      const abs = path.join(vaultDir, f.relPath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed 1.9.1 vault"]);
    const head0 = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    // legacy 位置 (.graphrag 直下, cache/ でない) の state 一式 — 1.9.1 が残した形。
    // vector.json は旧フォーマット: rows は node_id/dimensions/vector/text_hash のみ、
    // メタに noise_baseline / vault_head / prefix_policy 無し。endpoint はモックを記録
    // (1.9.1 当時この環境が使っていた endpoint、の位置づけ)。
    writeFileSync(legacyVectorPath, JSON.stringify({
      version: 1,
      provider: "openai-compatible-embedding",
      provider_capability: "semantic",
      semantic: true,
      dimensions: 2,
      provider_options: { endpoint: `${mock.base}/embeddings`, model: "nomic-embed-text" },
      graph_version: null,
      generated_at: FIXED_TS,
      rows: seedGraph.nodes.map((n) => ({
        node_id: n.id, dimensions: 2, vector: [1, 0], text_hash: `legacy-${n.id}`
      }))
    }, null, 2));
    // 索引 mtime を vault ファイルより確実に新しくして、mtime 同着による
    // 自動再構築 (legacy を読んだ事実が消える) を決定論的に防ぐ。
    const future = new Date(Date.now() + 5_000);
    utimesSync(legacyVectorPath, future, future);

    // 旧位置の ask-state: 同じ質問を過去に 3 回聞いている (fresh な last_at)。
    // 1.10 がこれを読めていれば次の ask は call_number 4 になる。
    writeFileSync(legacyAskStatePath, JSON.stringify({
      [fingerprintQuestion(QUESTION)]: { count: 3, last_at: Date.now() }
    }, null, 2));

    // stale な vault.seq (旧位置)。偶数=安定値。1.10 の読みは cache/vault.seq を見るので
    // これが残っていても読み書きを壊さないこと自体が検証対象。
    writeFileSync(path.join(graphragDir, "vault.seq"), "42");

    // legacy 値の mode。1.10 では「未実装 → 警告して未設定扱い」(read を殺さない)。
    writeFileSync(path.join(graphragDir, ".env"), "GRAPHRAG_VAULT_MODE=worktree\n");

    // hermetic なサブプロセス env: HOME 差し替え + GRAPHRAG_* を明示制御。
    // endpoint/model は shell env (最優先) でモックに固定する。
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: fakeHome,
      GRAPHRAG_EMBEDDING_ENDPOINT: `${mock.base}/embeddings`,
      GRAPHRAG_EMBEDDING_MODEL: "nomic-embed-text"
    };
    for (const key of [
      "GRAPHRAG_VAULT_DIR", "GRAPHRAG_STATE_DIR", "GRAPHRAG_VAULT_MODE",
      "GRAPHRAG_VECTOR_INDEX_PATH", "GRAPHRAG_VECTOR_INDEX_BASE",
      "GRAPHRAG_VECTOR_PROVIDER", "GRAPHRAG_GRAPH_JSON_PATH",
      "GRAPHRAG_WORLD_DIR", "GRAPHRAG_EMBEDDING_API_KEY"
    ]) delete env[key];

    const filesBefore = listFiles(repo);

    // ── 1. inspect: vault を解決し、実効の索引パス (legacy fallback) と state_dir を報告 ──
    await t.test("inspect: legacy 索引パスと state_dir を正直に報告して exit 0", async () => {
      const r = await runCli(["inspect"], { cwd: repo, env });
      assert.equal(r.code, 0, `inspect exit 0 (stderr: ${r.stderr})`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.env.GRAPHRAG_VAULT_DIR, vaultDir, "vault を auto-discover する");
      assert.equal(parsed.vault_dir_source, "auto-discovered");
      assert.equal(parsed.env.GRAPHRAG_VAULT_MODE, "worktree", "legacy 値が env に残っている前提の環境");
      assert.equal(parsed.state_dir, graphragDir, "state_dir は repo の .graphrag");
      assert.equal(parsed.artifacts.vector_index.path, legacyVectorPath, "実効の索引パス = legacy 位置");
      assert.equal(parsed.artifacts.vector_index.exists, true);
      assert.equal(parsed.artifacts.ask_state.path, legacyAskStatePath, "ask-state も legacy を読む側で報告");
      assert.equal(parsed.vault_isolation.mode, null, "worktree は unset 扱い (エラーにしない)");
    });

    // ── 2. ask: legacy 索引から high confidence で読め、worktree は警告のみ ──
    await t.test("ask: legacy 索引で matches が返り、ask-state は cache/ へ書かれる", async () => {
      const r = await runCli(["ask", QUESTION], { cwd: repo, env });
      assert.equal(r.code, 0, `ask exit 0 (stderr: ${r.stderr})`);
      assert.match(r.stderr, /GRAPHRAG_VAULT_MODE=worktree is not implemented/, "worktree は stderr 警告のみ");
      const out = JSON.parse(r.stdout);
      assert.equal(out.call_number, 4, "legacy ask-state (count 3) を読めている → 4 回目");
      const query = out.stages[0].output.query;
      assert.ok(query.matches.length > 0, "legacy 索引から matches が返る");
      assert.equal(query.match_confidence, "high", "baseline 無し旧索引は絶対バンドで判定 (cosine 1.0 → high)");
      assert.ok(
        query.matches.some((m: any) => (m.reasons ?? []).some((x: string) => x.startsWith("vector:"))),
        "semantic スコアが付いている = 索引 (legacy) が実際に使われた"
      );
      assert.ok(!existsSync(path.join(cacheDir, "vector.json")), "read は legacy のまま (勝手に再構築しない)");
      // 書き側は新 cache/ パス、legacy は据え置きで読める。
      const cacheState = JSON.parse(readFileSync(path.join(cacheDir, "ask-state.json"), "utf8"));
      assert.equal(cacheState[fingerprintQuestion(QUESTION)].count, 4, "ask-state の書きは cache/ へ");
      const legacyState = JSON.parse(readFileSync(legacyAskStatePath, "utf8"));
      assert.equal(legacyState[fingerprintQuestion(QUESTION)].count, 3, "legacy 側は書き換えない (読み専用)");
    });

    // ── 3. add-decision: repo-local vault は mode 不要で書け、commit は vault のみ ──
    await t.test("add-decision: mode=worktree (=unset 扱い) でも repo-local vault へ書けて git commit は vault のみ", async () => {
      const r = await runCli([
        "add-decision",
        "--system", "s", "--slug", "use-jwt",
        "--title", "JWT 採用 (adopt JWT)",
        "--summary", "認証トークンは JWT に統一する",
        "--evidence", "file:s:src/auth.ts"
      ], { cwd: repo, env });
      assert.equal(r.code, 0, `add-decision exit 0 (stderr: ${r.stderr})`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.applied, true);
      assert.equal(out.result.index_status.ok, true, "post-commit 索引再構築 (モック endpoint) が成功");

      const head1 = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      assert.notEqual(head1, head0, "vault git commit が存在する");
      // core.quotepath=off: JA タイトル由来の非 ASCII ファイル名を octal エスケープ
      // させず素のパスで比較する。
      const committed = execFileSync(
        "git", ["-C", repo, "-c", "core.quotepath=off", "show", "--name-only", "--format=", "HEAD"],
        { encoding: "utf8" }
      ).split("\n").filter((line) => line.trim().length > 0);
      assert.ok(committed.length > 0);
      for (const file of committed) {
        assert.ok(
          file.startsWith(".graphrag/vault/"),
          `commit は vault ファイルのみを含む (found: ${file})`
        );
      }
      assert.ok(
        committed.some((file) => file.startsWith(".graphrag/vault/Decision/")),
        "新しい Decision ファイルが commit に入っている"
      );
    });

    // ── 4. vector-index: 新 cache/ へ noise_baseline 付きで再構築 → ask も健在 ──
    await t.test("vector-index: cache/ へ noise_baseline を打刻して再構築、後続 ask の confidence も健在", async () => {
      const r = await runCli(["vector-index"], { cwd: repo, env });
      assert.equal(r.code, 0, `vector-index exit 0 (stderr: ${r.stderr})`);
      const newIndexPath = path.join(cacheDir, "vector.json");
      assert.equal(r.stdout.trim(), newIndexPath, "書き込み先は新 cache/ パス");
      const rebuilt = JSON.parse(readFileSync(newIndexPath, "utf8"));
      assert.ok(rebuilt.noise_baseline, "noise_baseline が打刻されている");
      assert.equal(typeof rebuilt.noise_baseline.median_cosine, "number");
      assert.equal(typeof rebuilt.noise_baseline.p90_cosine, "number");
      assert.ok(typeof rebuilt.vault_head === "string" && rebuilt.vault_head.length > 0, "vault_head も打刻");
      // legacy 索引は据え置き (読み fallback 対象のまま、上書きされない)。
      assert.ok(!("noise_baseline" in JSON.parse(readFileSync(legacyVectorPath, "utf8"))));

      const ask2 = await runCli(["ask", QUESTION_2], { cwd: repo, env });
      assert.equal(ask2.code, 0, `再構築後の ask exit 0 (stderr: ${ask2.stderr})`);
      const query = JSON.parse(ask2.stdout).stages[0].output.query;
      assert.ok(query.matches.length > 0, "新索引 (cache/) から matches が返る");
      assert.equal(query.match_confidence, "high", "noise_baseline 経由のコーパス相対判定でも high (margin 0)");
    });

    // ── 5. ゴミファイル回帰ガード: セッションが作ってよいのは .graphrag/ 配下だけ ──
    await t.test("セッション全体で .graphrag/ の外に新規ファイルを 1 つも作らない", () => {
      const created = [...listFiles(repo)].filter((rel) => !filesBefore.has(rel)).sort();
      for (const rel of created) {
        assert.ok(
          rel.startsWith(`.graphrag${path.sep}`),
          `.graphrag/ の外にゴミを作らない (found: ${rel})`
        );
      }
      // 期待した新レイアウトの成果物が実際にそこにある (空振り防止)。
      assert.ok(created.includes(path.join(".graphrag", "cache", "ask-state.json")));
      assert.ok(created.includes(path.join(".graphrag", "cache", "vector.json")));
      assert.ok(created.some((rel) => rel.startsWith(path.join(".graphrag", "vault", "Decision") + path.sep)));
      // HOME (差し替え済み) にも一切作らない。
      assert.ok(!existsSync(path.join(fakeHome, ".graphrag")), "HOME 側に .graphrag を作らない");
    });
  } finally {
    await mock.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseWritePolicyField,
  readWritePolicy,
  writePolicyForAsk,
  writePolicyForInspect,
  writePolicyProfilePath,
  assertWritePolicyReadable,
  WRITE_POLICY_ASK_INLINE_MAX_CHARS,
  WRITE_POLICY_RECOMMENDED_CHARS
} from "./write-policy.ts";
import { vaultProfilePath, parseVaultProfile, readVaultProfile, profileVectorText } from "./world.ts";
import { assertVaultWriteAllowed } from "./cli-env.ts";
import { formatAskMarkdown } from "./ask-format.ts";

const fm = (body: string, rest = "本文の自己紹介") => `---\nname: demo\n${body}\n---\n${rest}\n`;

function withVault(vaultMd: string | null, fn: (vaultDir: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "write-policy-"));
  try {
    const vaultDir = path.join(root, "vault");
    mkdirSync(vaultDir);
    if (vaultMd !== null) writeFileSync(path.join(root, "VAULT.md"), vaultMd);
    fn(vaultDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- parse: 受理する形 ---------------------------------------------------------

test("absent: frontmatter なし / キーなし", () => {
  assert.deepEqual(parseWritePolicyField("ただの本文\n"), { present: false });
  assert.deepEqual(parseWritePolicyField(fm("schema: system")), { present: false });
});

test("1 行スカラー (引用符なし / 二重 / 単一、行末コメント除去)", () => {
  assert.deepEqual(parseWritePolicyField(fm("write_policy: 顧客名は書かない  # memo")), { present: true, ok: true, text: "顧客名は書かない" });
  assert.deepEqual(parseWritePolicyField(fm('write_policy: "公開 repo: 顧客名と \\"社内\\" URL は書かない"')), {
    present: true, ok: true, text: '公開 repo: 顧客名と "社内" URL は書かない'
  });
  assert.deepEqual(parseWritePolicyField(fm("write_policy: 'it''s public'")), { present: true, ok: true, text: "it's public" });
});

test("literal block (|) は改行を保持し字下げを外す", () => {
  const r = parseWritePolicyField(fm("write_policy: |\n  公開 repo。\n  - 顧客名\n  - 未発表の計画\nschema: system"));
  assert.deepEqual(r, { present: true, ok: true, text: "公開 repo。\n- 顧客名\n- 未発表の計画" });
});

test("folded block (>) は段落内の改行を空白に", () => {
  const r = parseWritePolicyField(fm("write_policy: >-\n  顧客名は\n  書かない\n\n  URL も"));
  assert.deepEqual(r, { present: true, ok: true, text: "顧客名は 書かない\nURL も" });
});

test("値なし + リスト (字下げあり / 0 桁の - どちらも) はテキストとして保持", () => {
  assert.deepEqual(parseWritePolicyField(fm("write_policy:\n  - 顧客名\n  - 社内ホスト名")), {
    present: true, ok: true, text: "- 顧客名\n- 社内ホスト名"
  });
  assert.deepEqual(parseWritePolicyField(fm("write_policy:\n- 顧客名\n- 社内ホスト名\nschema: system")), {
    present: true, ok: true, text: "- 顧客名\n- 社内ホスト名"
  });
});

// --- parse: 不正 (fail-closed の対象) --------------------------------------------

test("不正: 空 / 重複 / 閉じない引用符 / flow / 未知の indicator", () => {
  const bad = (body: string) => {
    const r = parseWritePolicyField(fm(body));
    assert.equal(r.present && !r.ok, true, `expected invalid for: ${body}`);
  };
  bad("write_policy:");
  bad('write_policy: ""');
  bad("write_policy: a\nwrite_policy: b");
  bad('write_policy: "unterminated');
  bad("write_policy: [顧客名, URL]");
  bad("write_policy: |2x\n  a");
  bad("write_policy: |\n");
});

test("不正: 本文側 / 閉じない frontmatter に write_policy がある", () => {
  const outside = parseWritePolicyField("---\nname: demo\n---\nwrite_policy: 顧客名\n");
  assert.equal(outside.present && !outside.ok, true);
  const unclosed = parseWritePolicyField("---\nname: demo\nwrite_policy: 顧客名\n");
  assert.equal(unclosed.present && !unclosed.ok, true);
});

test("不正: ブロック行が他パーサのキーに見える (schema: 等) と誤読されるので拒否", () => {
  const r = parseWritePolicyField(fm("write_policy: |\n  schema: 顧客のスキーマ名は書かない"));
  assert.equal(r.present && !r.ok, true);
});

// --- 置き場所・world-cache 非対象 -------------------------------------------------

test("置き場所は world.ts vaultProfilePath と同じ規則", () => {
  const v = path.join(tmpdir(), "x", "vault");
  assert.equal(writePolicyProfilePath(v), vaultProfilePath(v));
});

test("write_policy は world-cache のベクトル化テキスト (name + 本文) に入らない", () => {
  const content = fm("write_policy: 顧客名ACME_SECRET_CATEGORY は書かない", "決済の知識");
  const text = profileVectorText({ ...parseVaultProfile(content), name: "demo" } as any);
  assert.equal(text.includes("ACME_SECRET_CATEGORY"), false);
  assert.equal(text.includes("決済の知識"), true);
});

// --- read / ask / inspect -------------------------------------------------------

test("readWritePolicy: VAULT.md 不在 → absent、ok は hash/chars を持つ", () => {
  withVault(null, (v) => assert.deepEqual(readWritePolicy(v), { status: "absent" }));
  withVault(fm("write_policy: 顧客名は書かない"), (v) => {
    const p = readWritePolicy(v);
    assert.equal(p.status, "ok");
    if (p.status !== "ok") return;
    assert.equal(p.text, "顧客名は書かない");
    assert.match(p.hash, /^[0-9a-f]{12}$/);
    assert.equal(p.chars, 8);
    assert.equal(p.over_recommended, false);
    // 既存の VAULT.md 読み (自己紹介) は影響を受けない
    assert.equal(readVaultProfile(v)?.profile.name, "demo");
  });
});

test("writePolicyForAsk: absent は何も載せない、短文は本文同乗、長文はポインタに縮退", () => {
  assert.equal(writePolicyForAsk({ status: "absent" }), undefined);
  withVault(fm("write_policy: 顧客名は書かない"), (v) => {
    const a = writePolicyForAsk(readWritePolicy(v))!;
    assert.equal(a.text, "顧客名は書かない");
    assert.equal(a.length_warning, undefined);
  });
  const mid = "あ".repeat(WRITE_POLICY_RECOMMENDED_CHARS + 1);
  withVault(fm(`write_policy: ${mid}`), (v) => {
    const a = writePolicyForAsk(readWritePolicy(v))!;
    assert.equal(a.text, mid, "推奨超過でも切り捨てない");
    assert.equal(typeof a.length_warning, "string");
  });
  const long = "い".repeat(WRITE_POLICY_ASK_INLINE_MAX_CHARS + 1);
  withVault(fm(`write_policy: ${long}`), (v) => {
    const a = writePolicyForAsk(readWritePolicy(v))!;
    assert.equal(a.text, undefined);
    assert.equal(a.text_omitted, true);
    const i = writePolicyForInspect(readWritePolicy(v));
    assert.equal(i.text, long, "inspect は常に全文");
  });
});

test("writePolicyForAsk / Inspect: invalid は理由と書き込み拒否の旨を返す", () => {
  withVault(fm("write_policy:"), (v) => {
    const a = writePolicyForAsk(readWritePolicy(v))!;
    assert.equal(a.status, "invalid");
    assert.equal(typeof a.reason, "string");
    assert.equal(writePolicyForInspect(readWritePolicy(v)).status, "invalid");
  });
});

// --- fail-closed ---------------------------------------------------------------
// graphrag:enforces constraint:graphrag-skill-dev:write-policy-invalid-fails-closed

test("assertWritePolicyReadable / assertVaultWriteAllowed: 不正なら書き込みを拒否、absent / ok は通す", () => {
  withVault(null, (v) => assert.doesNotThrow(() => assertWritePolicyReadable(v)));
  withVault(fm("write_policy: 顧客名は書かない"), (v) => {
    assert.doesNotThrow(() => assertWritePolicyReadable(v));
    assert.doesNotThrow(() => assertVaultWriteAllowed({ cwd: path.dirname(v), vaultDir: v }));
  });
  withVault(fm('write_policy: "unterminated'), (v) => {
    assert.throws(() => assertWritePolicyReadable(v), /write_policy/);
    assert.throws(() => assertVaultWriteAllowed({ cwd: path.dirname(v), vaultDir: v }), /Refusing to write/);
  });
});

// --- ask --format md ------------------------------------------------------------

test("formatAskMarkdown: write_policy 節はマッチより前、無ければ出さない", () => {
  const base = { question: "q", final_stage: "brief", call_number: 1, stages: [] };
  assert.equal(formatAskMarkdown(base).includes("## write_policy"), false);
  const md = formatAskMarkdown({ ...base, write_policy: { status: "ok", hash: "abc", text: "顧客名は書かない", note: "N" } });
  assert.ok(md.indexOf("## write_policy") < md.indexOf("## matches"));
  assert.ok(md.includes("顧客名は書かない"));
});

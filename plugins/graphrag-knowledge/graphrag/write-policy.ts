import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

// vault 固有の収録境界 (write_policy) — VAULT.md frontmatter の任意キー。
//
// 「この vault は公開 repo にあるので顧客名・未発表の計画は書かない」のような、vault の
// 公開範囲で決まる除外方針の器。中身はプロジェクトが書き、プラグインは運ぶだけ (検閲しない)。
// 共通の content hygiene (SKILL.md §Content hygiene) とは別層で、共通側を緩めることはない。
//
// - frontmatter に置く理由: world-cache の写し対象は name + 本文だけ (world.ts profileVectorText)。
//   frontmatter の他キーは cross-vault hint に流れないので、除外カテゴリの語がヒント判定を
//   汚したり外へ写ったりしない。
// - 導線: ask の出力に本文を同乗 (WRITE_POLICY_ASK_INLINE_MAX_CHARS 超はポインタに縮退)、
//   ask を経ない書き込み経路は inspect で取得する。既読管理・ack は持たない。
// - fail-closed: キーがあるのに解釈できない時は書き込み verb を止める (assertVaultWriteAllowed)。
//   「読めない方針」を「方針なし」と扱わないための設定契約の検証で、本文の検査ではない。
//
// 依存は node 標準のみ (cli-env.ts から呼ぶため。world.ts を import すると循環する)。

/** 推奨上限。超えても切り捨てない (ルールを失うため) — 警告だけ出す。 */
export const WRITE_POLICY_RECOMMENDED_CHARS = 300;
/** ask へ本文を同乗させる上限。超えたら hash/path だけ載せ、inspect での取得に回す。 */
export const WRITE_POLICY_ASK_INLINE_MAX_CHARS = 600;

// 他の VAULT.md フィールドパーサ (parseVaultProfile / parseSchemaField / parseVaultSlug /
// parseVaultParent / parseVaultSlugAliases) は frontmatter 行を trim してから `key:` を照合する。
// ブロック内にこれらの形の行があると他パーサが誤読するので、ブロック側を不正として扱う。
const FOREIGN_KEY_RE = /^(name|schema|kind|vault_slug|vault_slug_aliases|parent)\s*:/;

export type WritePolicyField =
  | { present: false }
  | { present: true; ok: true; text: string }
  | { present: true; ok: false; reason: string };

export type WritePolicy =
  | { status: "absent" }
  | { status: "ok"; path: string; text: string; hash: string; chars: number; over_recommended: boolean }
  | { status: "invalid"; path: string; reason: string };

/** VAULT.md の置き場所。world.ts vaultProfilePath と同じ規則 (vault dir の兄弟)。 */
export function writePolicyProfilePath(vaultDir: string): string {
  return path.join(path.dirname(path.resolve(vaultDir)), "VAULT.md");
}

function unquote(raw: string): { ok: true; text: string } | { ok: false; reason: string } {
  const q = raw[0];
  if (raw.length < 2 || raw[raw.length - 1] !== q) {
    return { ok: false, reason: `unterminated ${q === '"' ? "double" : "single"}-quoted value` };
  }
  const inner = raw.slice(1, -1);
  return q === '"'
    ? { ok: true, text: inner.replace(/\\(["\\])/g, "$1") }
    : { ok: true, text: inner.replace(/''/g, "'") };
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

function fold(lines: string[]): string {
  // 空行で段落を分け、段落内の行は空白で連結 (YAML folded scalar の簡略版)。
  const paragraphs: string[][] = [[]];
  for (const l of lines) {
    if (l.trim()) paragraphs[paragraphs.length - 1].push(l.trim());
    else if (paragraphs[paragraphs.length - 1].length) paragraphs.push([]);
  }
  return paragraphs.filter((p) => p.length).map((p) => p.join(" ")).join("\n");
}

/**
 * VAULT.md 本文から write_policy を読む。受理する形:
 *   write_policy: 1 行の値 (引用符あり/なし)
 *   write_policy: |      ← literal block (改行を保持)
 *   write_policy: >      ← folded block (段落内の改行を空白に)
 *   write_policy:        ← 値なし + 続く字下げ行 / `- ` 行 (リストをそのままテキストとして保持)
 * キーが無ければ present:false。キーはあるが解釈できなければ ok:false (呼び手が fail-closed にする)。
 */
export function parseWritePolicyField(content: string): WritePolicyField {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  const outside = fm ? content.slice(fm[0].length) : content;
  if (/^write_policy\s*:/m.test(outside)) {
    return {
      present: true,
      ok: false,
      reason: fm
        ? "write_policy appears outside the frontmatter (it must be a frontmatter key)"
        : "write_policy found but VAULT.md has no closed frontmatter (--- ... ---)"
    };
  }
  if (!fm) return { present: false };

  const lines = fm[1].split(/\r?\n/);
  const keyIdx = lines.flatMap((l, i) => (/^write_policy\s*:/.test(l) ? [i] : []));
  if (keyIdx.length === 0) return { present: false };
  if (keyIdx.length > 1) return { present: true, ok: false, reason: "write_policy is declared more than once" };

  const i = keyIdx[0];
  const rest = lines[i].replace(/^write_policy\s*:/, "").trim();

  const collectBlock = (allowDashAtCol0: boolean): string[] => {
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim() || /^\s/.test(l) || (allowDashAtCol0 && /^-(\s|$)/.test(l))) block.push(l);
      else break;
    }
    while (block.length && !block[block.length - 1].trim()) block.pop();
    return block;
  };

  let text: string;
  let blockLines: string[] = [];
  if (rest.startsWith("|") || rest.startsWith(">")) {
    if (!/^[|>][+-]?(\s+#.*)?$/.test(rest)) {
      return { present: true, ok: false, reason: `unsupported block indicator "${rest}" (use | or >)` };
    }
    blockLines = collectBlock(false);
    const body = dedent(blockLines);
    text = rest.startsWith("|") ? body.join("\n") : fold(body);
  } else if (rest === "") {
    blockLines = collectBlock(true);
    text = dedent(blockLines).join("\n");
  } else if (rest.startsWith('"') || rest.startsWith("'")) {
    const u = unquote(rest);
    if (!u.ok) return { present: true, ok: false, reason: u.reason };
    text = u.text;
  } else if (rest.startsWith("[") || rest.startsWith("{")) {
    return { present: true, ok: false, reason: "flow collections ([...] / {...}) are not supported; use a block (|) or an indented list" };
  } else {
    text = rest.replace(/\s+#.*$/, "");
  }

  const foreign = blockLines.map((l) => l.trim()).find((l) => FOREIGN_KEY_RE.test(l));
  if (foreign) {
    return {
      present: true,
      ok: false,
      reason: `a write_policy block line starts like another VAULT.md key ("${foreign.split(":")[0]}:"), which other field parsers would misread — rephrase that line`
    };
  }

  text = text.trim();
  if (!text) {
    return { present: true, ok: false, reason: "write_policy is empty (remove the key to declare no policy)" };
  }
  return { present: true, ok: true, text };
}

/** vault の write_policy を解決する。VAULT.md 不在 / キー不在は absent。読み取り失敗は invalid。 */
export function readWritePolicy(vaultDir: string): WritePolicy {
  const profilePath = writePolicyProfilePath(vaultDir);
  if (!existsSync(profilePath)) return { status: "absent" };
  let content: string;
  try {
    content = readFileSync(profilePath, "utf8");
  } catch (error) {
    return { status: "invalid", path: profilePath, reason: `VAULT.md unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const field = parseWritePolicyField(content);
  if (!field.present) return { status: "absent" };
  if (!field.ok) return { status: "invalid", path: profilePath, reason: field.reason };
  const chars = [...field.text].length;
  return {
    status: "ok",
    path: profilePath,
    text: field.text,
    hash: createHash("sha256").update(field.text, "utf8").digest("hex").slice(0, 12),
    chars,
    over_recommended: chars > WRITE_POLICY_RECOMMENDED_CHARS
  };
}

const OK_NOTE =
  "Vault-specific exclusion boundary: never write matching content into this vault, in any field " +
  "(id/title/aliases/path/URL/raw_content/edges/reason). It overrides persistence, raw-content and checkpoint-rescue instructions.";
const INVALID_NOTE = "Writes to this vault are refused until VAULT.md write_policy is fixed.";
const LENGTH_WARNING =
  `write_policy is longer than the recommended ${WRITE_POLICY_RECOMMENDED_CHARS} chars — shorten it (it is never truncated).`;

/** ask に同乗させる形。absent は undefined (何も載せない = 方針なしの vault はゼロコスト)。 */
export function writePolicyForAsk(policy: WritePolicy): Record<string, unknown> | undefined {
  if (policy.status === "absent") return undefined;
  if (policy.status === "invalid") {
    return { status: "invalid", path: policy.path, reason: policy.reason, note: INVALID_NOTE };
  }
  const warning = policy.over_recommended ? { length_warning: LENGTH_WARNING } : {};
  if (policy.chars > WRITE_POLICY_ASK_INLINE_MAX_CHARS) {
    return {
      status: "ok",
      hash: policy.hash,
      chars: policy.chars,
      text_omitted: true,
      note: "Too long to inline: run `inspect` and read write_policy.text before distilling anything to write. " + OK_NOTE,
      ...warning
    };
  }
  return { status: "ok", hash: policy.hash, text: policy.text, note: OK_NOTE, ...warning };
}

/** inspect に載せる形 (常に全文)。 */
export function writePolicyForInspect(policy: WritePolicy): Record<string, unknown> {
  if (policy.status === "absent") return { status: "absent" };
  if (policy.status === "invalid") return { ...policy, note: INVALID_NOTE };
  const { over_recommended, ...rest } = policy;
  return {
    ...rest,
    recommended_chars: WRITE_POLICY_RECOMMENDED_CHARS,
    note: OK_NOTE,
    ...(over_recommended ? { length_warning: LENGTH_WARNING } : {})
  };
}

/** 書き込み verb の入口で呼ぶ。キーがあるのに解釈できなければ throw (fail-closed)。 */
export function assertWritePolicyReadable(vaultDir: string): void {
  const policy = readWritePolicy(vaultDir);
  if (policy.status !== "invalid") return;
  throw new Error(
    `VAULT.md declares write_policy but it cannot be interpreted (${policy.reason}) — ${policy.path}. ` +
    "Refusing to write: an unreadable exclusion policy is not the same as no policy. " +
    "Fix the write_policy field, or remove the key to declare that this vault has no policy."
  );
}

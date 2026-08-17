#!/usr/bin/env node
// analyze-read-phases.mjs
//
// Claude Code transcript (.jsonl) から「AI がプロジェクト知識 (graphrag vault) を
// 自発的に読みに行った瞬間」を抽出し、セッション内の位相 (冒頭 / 中盤 / 終盤) と
// その直前の「渦中度 (turmoil)」を集計する研究用スクリプト。
//
//   usage: node analyze-read-phases.mjs <file.jsonl | dir> [...]
//
// 出力は集計 JSON のみ。transcript の生テキスト (コマンド文字列・本文・ファイルパス)
// は一切出力しない。内部で同一性判定に使う文字列は全て 32bit ハッシュに畳んでから
// 保持するため、出力に復元可能な原文は残らない。
//
// Node.js >= 22, 依存なし, 行ストリーム処理 (数十 MB の transcript でも定数メモリ)。

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------- parameters

const WINDOW = 20; // 渦中度を見る「直前 N メッセージ」
const ERROR_PATTERN = /error|failed|FAIL|exception|traceback/i;

// graphrag CLI の既知 verb。ここに無い verb は "other" に畳む
// (transcript 由来の任意文字列が出力に漏れないようにするため)。
const KNOWN_VERBS = new Set([
  "ask", "grep", "show", "search", "brief", "resume", "echo", "trace",
  "neighbors", "node", "evidence", "stocktake", "constraint-check",
  "xref-check", "walker", "init", "world", "commit-mutation", "validate",
  "index", "reindex", "embed", "embedder-setup", "export", "import",
  "add-decision", "add-risk", "add-goal", "add-ok", "add-constraint",
  "add-investigation", "add-rejected", "add-component", "add-evidence",
  "close", "declare", "help", "version",
]);

// 読み取り系コマンド (vault 直接読みの判定に使う)
const READ_GREP = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
const READ_CAT = new Set(["cat", "head", "tail", "sed", "less", "more", "bat", "awk", "nl"]);

// vault っぽいパスの判定
const VAULT_HINT = /(^|[\/"'\s=])\.graphrag([\/"'\s]|$)|(^|[\/"'\s=])vault([\/"'\s]|$)|\.graphrag\/|\/vault\//i;
const VAULT_MD = /[^\s"'`;|&()]*(?:\.graphrag|vault)[^\s"'`;|&()]*\.md\b/i;
// 実験用の使い捨て vault (tmp / jobs / scratch / プラグイン自身のテストデータ)
const FIXTURE_PATH = /(^|\/)(tmp|temp|scratch|scratchpad|jobs|fixtures?|testdata|node_modules)(\/|$)|\/plugins\/(cache|marketplaces)\//i;

// ---------------------------------------------------------------- utilities

/** 文字列 -> 32bit 符号なしハッシュ (原文を保持しないための畳み込み) */
function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function collapse(s) {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * リトライ判定用のコマンド指紋。
 * 変数代入行 (CLI=... / VAULT=... のような共通プレフィクス) を落とし、
 * 絶対パスを末尾 2 セグメントに縮めてから畳み込む。
 * こうしないと「長い共通パスを持つ別コマンド」が全部同じ指紋になってしまう。
 */
function commandKey(cmd) {
  const body = cmd
    .split("\n")
    .filter((l) => !/^\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s*$/.test(l) && !/^\s*[A-Za-z_][A-Za-z0-9_]*="[^"]*"\s*$/.test(l))
    .join("\n")
    .replace(/(?:\/[^\s"'`|;&:]+){3,}/g, (p) => p.split("/").slice(-2).join("/"));
  return hash32(collapse(body).slice(0, 80));
}

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const b of content) {
      if (typeof b === "string") out += b;
      else if (b && typeof b.text === "string") out += b.text;
      else if (b && typeof b.content === "string") out += b.content;
    }
    return out;
  }
  if (content && typeof content.text === "string") return content.text;
  return "";
}

// ------------------------------------------------------- shell-ish analysis

/**
 * heredoc の本文を取り除く。
 * `cat > x.json <<'JSON' ... JSON` の本文には CLI 例や vault パスが平気で書かれており
 * (実データで確認: 訓練データ生成スクリプトや mutation-plan JSON)、
 * 剥がさないと「書いている」のに「読んだ/呼んだ」と誤検出する。
 */
function stripHeredocs(cmd) {
  const lines = cmd.split("\n");
  const out = [];
  let tag = null;
  for (const line of lines) {
    if (tag !== null) {
      if (line.trim() === tag) tag = null;
      continue;
    }
    const m = line.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/);
    out.push(line);
    if (m) tag = m[1] ?? m[2] ?? m[3];
  }
  return out.join("\n");
}

/** `VAR=value` の代入を集めて $VAR / ${VAR} / ${=VAR} を素朴に展開する */
function expandVars(cmd) {
  const vars = new Map();
  const assign = /(?:^|[\s;|&(])([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|([^\s;|&)]*))/g;
  let m;
  while ((m = assign.exec(cmd)) !== null) {
    const val = m[3] ?? m[4] ?? m[5] ?? "";
    if (val) vars.set(m[1], val);
  }
  if (vars.size === 0) return cmd;
  let out = cmd;
  for (let pass = 0; pass < 2; pass++) {
    out = out.replace(/\$\{=?([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, a, b) => {
      const name = a || b;
      return vars.has(name) ? vars.get(name) : whole;
    });
  }
  return out;
}

/**
 * パイプ / 改行 / ; / && / || でコマンドを実行単位に割る。
 * パイプの下流かどうか (piped) を保持する: `ls ... | head -3` の head は
 * ファイルを読んでいない (stdin の消費) ので、読みイベントに数えてはいけない。
 */
function splitSegments(cmd) {
  const out = [];
  let piped = false;
  let cur = "";
  let quote = null; // ' " ` の中では区切らない (grep -E 'a|b' の | で割らないため)
  const push = (isPiped) => {
    const t = cur.trim();
    if (t) out.push({ seg: t, piped: isPiped });
    cur = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote && cmd[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; cur += ch; continue; }
    if (ch === "\n" || ch === ";") { push(piped); piped = false; continue; }
    if (ch === "&" && cmd[i + 1] === "&") { push(piped); piped = false; i++; continue; }
    if (ch === "|" && cmd[i + 1] === "|") { push(piped); piped = false; i++; continue; }
    if (ch === "|") { push(piped); piped = true; continue; }
    cur += ch;
  }
  push(piped);
  return out;
}

/** セグメント先頭の実コマンド名 (env 代入・sudo・git -C ... を読み飛ばす) */
function headCommand(seg) {
  const toks = seg.split(/\s+/);
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (t === "sudo" || t === "time" || t === "command" || t === "!") { i++; continue; }
    if (t === "git") {
      // git -C <dir> grep ... のみ読み系として扱う
      let j = i + 1;
      while (j < toks.length && (toks[j] === "-C" || toks[j].startsWith("-"))) {
        j += toks[j] === "-C" ? 2 : 1;
      }
      return toks[j] === "grep" ? "grep" : (toks[j] || "git");
    }
    return t.replace(/^.*\//, ""); // basename (/usr/bin/grep -> grep)
  }
  return "";
}

/** vault 由来のパスか / 使い捨て fixture か */
function classifyVaultPath(p) {
  if (!VAULT_HINT.test(p)) return "none";
  if (FIXTURE_PATH.test(p)) return "fixture";
  return "vault";
}

/**
 * Bash command から「vault の .md を読んだ」セグメントを検出する。
 * @returns {{kinds: string[], fixtures: number}}
 */
function detectVaultReadsInBash(rawCmd) {
  const kinds = [];
  const debug = [];
  let fixtures = 0;
  const cmd = expandVars(stripHeredocs(rawCmd));

  // cd で vault 配下に入ったか。cd は「それ以降のセグメント」にしか効かないので
  // セグメントを順に見ながら状態として持ち回る (先頭の grep に後ろの cd を
  // 適用してしまう誤検出を防ぐ)。
  let cwdVault = "none";

  for (const { seg, piped } of splitSegments(cmd)) {
    const cdm = seg.match(/^cd\s+("[^"]*"|'[^']*'|[^\s;|&]+)/);
    if (cdm) {
      cwdVault = classifyVaultPath(unquote(cdm[1]));
      continue;
    }

    const head = headCommand(seg);
    const isGrep = READ_GREP.has(head);
    const isCat = READ_CAT.has(head);
    if (!isGrep && !isCat) continue;

    // 書き込み (リダイレクト) は読みではない
    if (/(^|[^0-9<>])>>?\s*\S/.test(seg)) continue;
    // sed -i (in-place 編集) も読みではない
    if (head === "sed" && /\s-i\b/.test(seg)) continue;

    // パイプ下流の grep/head/sed は stdin を読んでいるだけ (ls vault | grep ... など)。
    // 読んでいる実体は上流側なので、ここでは数えない。
    if (piped) continue;

    let verdict = "none";
    let why = "";
    const mdMatch = seg.match(VAULT_MD);

    // 明示的なパス引数 (フラグでも grep のパターンでもない "/" を含むトークン)。
    // grep 系は最初の非フラグ引数が検索パターン -> パス扱いしない
    // (`git diff --name-only | grep -vE '^\.graphrag/vault/'` を誤検出しないため)。
    const argToks = seg.split(/\s+/).slice(1).map(unquote);
    let patternDropped = !isGrep;
    const pathToks = [];
    for (const t of argToks) {
      if (!t) continue;
      if (t.startsWith("-") || /^[0-9]?[<>]/.test(t)) continue;
      if (!patternDropped) { patternDropped = true; continue; }
      if (t.includes("/")) pathToks.push(t);
    }

    const mdPathTok = pathToks.find((t) => /\.md\b/.test(t) && VAULT_HINT.test(t));
    const mdTarget = isGrep ? mdPathTok : (mdPathTok ?? (mdMatch ? mdMatch[0] : null));

    if (mdTarget) {
      verdict = classifyVaultPath(mdTarget);
      why = "explicit .md path";
    } else if (pathToks.length > 0) {
      // パス引数があるなら、それが vault かどうかだけで決める (cwd は使わない)
      const vaultTok = pathToks.find((t) => VAULT_HINT.test(t));
      if (vaultTok && isGrep) {
        verdict = classifyVaultPath(vaultTok);
        why = "vault dir arg";
      }
    } else if (cwdVault !== "none") {
      // パス引数無し + cd で vault 配下 -> vault を読んでいる
      verdict = cwdVault;
      why = "cwd is vault";
    }

    if (verdict === "fixture") fixtures++;
    else if (verdict === "vault") {
      kinds.push(isGrep ? "vault_grep" : "vault_read");
      debug.push({ head, why });
    }
  }
  return { kinds, fixtures, debug };
}

/**
 * Bash command から graphrag CLI の verb を検出する。
 * `cli.ts ask ...` / `$CLI ask ...` / `${=CLI} ask ...` に対応。
 * @returns {string[]} verb 列 (KNOWN_VERBS 以外は "other")
 */
function detectCliVerbs(rawCmd) {
  const verbs = [];
  const cmd = stripHeredocs(rawCmd);
  const cliTok = /graphrag\/cli\.ts|cli\.ts|\$\{=?CLI\}|\$CLI\b/g;
  let m;
  while ((m = cliTok.exec(cmd)) !== null) {
    // 同一行の残りのみを見る (CLI="... cli.ts" のような代入で誤検出しない)
    const rest = cmd.slice(m.index + m[0].length);
    let line = rest.split("\n")[0];
    // `node ... "$PLUGIN/graphrag/cli.ts" ask ...` のように引用で閉じてから verb が
    // 続く形がある。閉じ引用符 1 個は剥がして続きを見る (代入 `CLI="...cli.ts"` の
    // 場合は剥がした残りが空になるので verb は取れない)。
    if (/^["'`]/.test(line)) line = line.slice(1);
    const toks = line.trim().split(/\s+/);
    let verb = null;
    for (const t of toks) {
      if (!t) continue;
      if (t.startsWith("-")) continue;          // フラグは読み飛ばす
      if (/^[|;&><"'`$(]/.test(t)) break;        // 制御記号に当たったら verb 無し
      if (/^[a-z][a-z0-9-]*$/.test(t)) verb = t;
      break;
    }
    if (verb) verbs.push(KNOWN_VERBS.has(verb) ? verb : "other");
  }
  return verbs;
}

const VERB_KIND = { ask: "ask", grep: "cli_grep", show: "cli_show" };

// ------------------------------------------------------------ session pass

async function analyzeSession(file) {
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  /** @type {{isErr:number, errPat:number, edits:number[], cmds:number[]}[]} */
  const signals = [];
  /** @type {{kind:string, verb?:string, index:number, ts:number|null}[]} */
  const rawEvents = [];
  let excludedSidechain = 0;
  let parseErrors = 0;
  let fixtureHits = 0;
  const verbCounts = Object.create(null);
  let firstTs = null;
  let lastTs = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      parseErrors++;
      continue;
    }
    if (o.isSidechain === true) { excludedSidechain++; continue; }
    if (o.type !== "user" && o.type !== "assistant") continue;
    const content = o.message?.content;
    if (content === undefined || content === null) continue;

    const index = signals.length;
    const sig = { isErr: 0, errPat: 0, edits: [], cmds: [] };
    signals.push(sig);

    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    const tsv = Number.isFinite(ts) ? ts : null;
    if (tsv !== null) {
      if (firstTs === null) firstTs = tsv;
      lastTs = tsv;
    }

    const blocks = Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;

      if (b.type === "tool_result") {
        if (b.is_error === true) sig.isErr++;
        const t = textOf(b.content);
        // 1 ブロック 1 カウント (巨大ログの "FAIL" 連打でスコアが爆発しないように)
        if (t && ERROR_PATTERN.test(t)) sig.errPat++;
        continue;
      }

      if (b.type !== "tool_use") continue;
      const name = b.name;
      const input = b.input || {};

      if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
        const p = input.file_path || input.notebook_path;
        if (typeof p === "string") sig.edits.push(hash32(p));
      }

      if (name === "Bash") {
        const cmd = typeof input.command === "string" ? input.command : "";
        if (!cmd) continue;
        sig.cmds.push(commandKey(cmd));

        for (const verb of detectCliVerbs(cmd)) {
          verbCounts[verb] = (verbCounts[verb] || 0) + 1;
          const kind = VERB_KIND[verb];
          if (kind) rawEvents.push({ kind, verb, index, ts: tsv });
        }
        const { kinds, fixtures } = detectVaultReadsInBash(cmd);
        fixtureHits += fixtures;
        for (const k of kinds) rawEvents.push({ kind: k, index, ts: tsv });
        continue;
      }

      if (name === "Read") {
        const p = input.file_path;
        if (typeof p === "string" && /\.md$/i.test(p)) {
          const c = classifyVaultPath(p);
          if (c === "fixture") fixtureHits++;
          else if (c === "vault") rawEvents.push({ kind: "vault_read", index, ts: tsv });
        }
        continue;
      }

      if (name === "Grep" || name === "Glob") {
        const p = [input.path, input.glob, input.pattern].filter((x) => typeof x === "string").join(" ");
        const c = classifyVaultPath(p);
        if (c === "fixture") fixtureHits++;
        else if (c === "vault" && name === "Grep") rawEvents.push({ kind: "vault_grep", index, ts: tsv });
        continue;
      }
    }
  }

  const total = signals.length;
  const spanMs = firstTs !== null && lastTs !== null ? lastTs - firstTs : 0;

  const turmoilAt = (index) => {
    const from = Math.max(0, index - WINDOW);
    let isErr = 0, errPat = 0;
    const editSeen = new Map();
    const cmdSeen = new Map();
    for (let i = from; i < index; i++) {
      const s = signals[i];
      isErr += s.isErr;
      errPat += s.errPat;
      for (const e of s.edits) editSeen.set(e, (editSeen.get(e) || 0) + 1);
      for (const c of s.cmds) cmdSeen.set(c, (cmdSeen.get(c) || 0) + 1);
    }
    let reEdits = 0;
    for (const n of editSeen.values()) if (n >= 2) reEdits += n - 1;
    let retries = 0;
    for (const n of cmdSeen.values()) if (n >= 2) retries += n - 1;
    return {
      score: isErr + errPat + reEdits + retries,
      // hard_score: テキストマッチ (error_patterns) を除いた「行動由来」だけの渦中度。
      // ツール出力に "error" の語が出るだけで加算されるノイズを避けたい時に使う。
      hard_score: isErr + reEdits + retries,
      is_error_results: isErr,
      error_patterns: errPat,
      re_edits: reEdits,
      retries,
    };
  };

  // ベースライン: 全メッセージ位置の渦中度分布 (イベントの偏りを読むための対照)
  let baseSum = 0, baseCalm = 0, baseHardCalm = 0, baseHardSum = 0;
  const baseDeciles = new Array(10).fill(0);
  const baseScores = new Array(total);
  const baseHardScores = new Array(total);
  for (let i = 0; i < total; i++) {
    const t = turmoilAt(i);
    baseScores[i] = t.score;
    baseHardScores[i] = t.hard_score;
    baseSum += t.score;
    baseHardSum += t.hard_score;
    if (t.score === 0) baseCalm++;
    if (t.hard_score === 0) baseHardCalm++;
    baseDeciles[decile(total > 1 ? i / (total - 1) : 0)]++;
  }
  const sortedScores = [...baseScores].sort((a, b) => a - b);
  const sortedHard = [...baseHardScores].sort((a, b) => a - b);

  const events = rawEvents.map((e) => {
    const t = turmoilAt(e.index);
    // 同一セッション内の全メッセージ位置と比べて、この瞬間はどれくらい荒れていたか
    t.pct = percentileOf(sortedScores, t.score);
    t.hard_pct = percentileOf(sortedHard, t.hard_score);
    const ev = {
      kind: e.kind,
      index: e.index,
      ratio: total > 1 ? round(e.index / (total - 1)) : 0,
      turmoil: t,
    };
    if (e.verb && e.verb !== e.kind) ev.verb = e.verb;
    if (e.ts !== null && spanMs > 0) ev.time_ratio = round((e.ts - firstTs) / spanMs);
    return ev;
  });

  return {
    file: basename(file),
    total_messages: total,
    duration_minutes: spanMs > 0 ? round(spanMs / 60000, 1) : null,
    excluded_sidechain: excludedSidechain,
    excluded_fixture_vault_hits: fixtureHits,
    parse_errors: parseErrors,
    cli_verb_counts: sortObj(verbCounts),
    baseline: {
      mean_turmoil: total ? round(baseSum / total, 2) : 0,
      mean_hard_turmoil: total ? round(baseHardSum / total, 2) : 0,
      calm_share: total ? round(baseCalm / total) : 0,
      hard_calm_share: total ? round(baseHardCalm / total) : 0,
      messages_per_decile: baseDeciles,
    },
    events,
  };
}

// ------------------------------------------------------------- aggregation

/** sorted 昇順配列における v の percentile rank (v 未満の割合 + 同値の半分) */
function percentileOf(sorted, v) {
  const n = sorted.length;
  if (n === 0) return null;
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
  const below = lo;
  let hi2 = n, lo2 = below;
  while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (sorted[m] <= v) lo2 = m + 1; else hi2 = m; }
  const equal = lo2 - below;
  return round((below + equal / 2) / n);
}

function decile(r) {
  const d = Math.floor(r * 10);
  return d < 0 ? 0 : d > 9 ? 9 : d;
}

function round(x, digits = 3) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function sortObj(o) {
  return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
}

function summarize(events) {
  const n = events.length;
  const hist = new Array(10).fill(0);
  let sumRatio = 0, sumTurmoil = 0, sumHard = 0, sumPct = 0, sumHardPct = 0, calm = 0, hardCalm = 0;
  const parts = { is_error_results: 0, error_patterns: 0, re_edits: 0, retries: 0 };
  const ratios = [];
  for (const e of events) {
    hist[decile(e.ratio)]++;
    sumRatio += e.ratio;
    sumTurmoil += e.turmoil.score;
    sumHard += e.turmoil.hard_score;
    sumPct += e.turmoil.pct ?? 0;
    sumHardPct += e.turmoil.hard_pct ?? 0;
    if (e.turmoil.score === 0) calm++;
    if (e.turmoil.hard_score === 0) hardCalm++;
    for (const k of Object.keys(parts)) parts[k] += e.turmoil[k];
    ratios.push(e.ratio);
  }
  ratios.sort((a, b) => a - b);
  return {
    count: n,
    ratio_histogram_deciles: hist,
    mean_ratio: n ? round(sumRatio / n) : null,
    median_ratio: n ? round(ratios[Math.floor(n / 2)]) : null,
    first_half_share: n ? round(events.filter((e) => e.ratio < 0.5).length / n) : null,
    first_decile_share: n ? round(events.filter((e) => e.ratio < 0.1).length / n) : null,
    mean_turmoil: n ? round(sumTurmoil / n, 2) : null,
    mean_hard_turmoil: n ? round(sumHard / n, 2) : null,
    // セッション内の全メッセージ位置と比較した渦中度の順位 (0.5 = 平均的な瞬間)
    mean_turmoil_percentile: n ? round(sumPct / n) : null,
    mean_hard_turmoil_percentile: n ? round(sumHardPct / n) : null,
    calm_count: calm,
    turmoil_count: n - calm,
    calm_share: n ? round(calm / n) : null,
    hard_calm_count: hardCalm,
    hard_turmoil_count: n - hardCalm,
    turmoil_components_total: parts,
  };
}

// -------------------------------------------------------------------- main

async function collectFiles(args) {
  const files = [];
  for (const a of args) {
    const st = await stat(a);
    if (st.isDirectory()) {
      const names = await readdir(a);
      for (const nm of names.sort()) if (nm.endsWith(".jsonl")) files.push(join(a, nm));
    } else {
      files.push(a);
    }
  }
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write("usage: node analyze-read-phases.mjs <file.jsonl | dir> [...]\n");
    process.exit(2);
  }
  const files = await collectFiles(args);
  const sessions = [];
  for (const f of files) {
    try {
      sessions.push(await analyzeSession(f));
    } catch (err) {
      process.stderr.write(`skip ${basename(f)}: ${err.message}\n`);
    }
  }

  const all = sessions.flatMap((s) => s.events);
  const byKind = {};
  for (const kind of ["ask", "cli_grep", "cli_show", "vault_grep", "vault_read"]) {
    byKind[kind] = summarize(all.filter((e) => e.kind === kind));
  }
  const totalMsgs = sessions.reduce((a, s) => a + s.total_messages, 0);
  const baseMean = totalMsgs
    ? round(sessions.reduce((a, s) => a + s.baseline.mean_turmoil * s.total_messages, 0) / totalMsgs, 2)
    : null;
  const baseCalm = totalMsgs
    ? round(sessions.reduce((a, s) => a + s.baseline.calm_share * s.total_messages, 0) / totalMsgs)
    : null;
  const baseHardMean = totalMsgs
    ? round(sessions.reduce((a, s) => a + s.baseline.mean_hard_turmoil * s.total_messages, 0) / totalMsgs, 2)
    : null;
  const baseHardCalm = totalMsgs
    ? round(sessions.reduce((a, s) => a + s.baseline.hard_calm_share * s.total_messages, 0) / totalMsgs)
    : null;

  const out = {
    params: { window: WINDOW, error_pattern: String(ERROR_PATTERN) },
    sessions,
    aggregate: {
      sessions: sessions.length,
      total_messages: totalMsgs,
      total_events: all.length,
      baseline_all_messages: {
        mean_turmoil: baseMean,
        calm_share: baseCalm,
        mean_hard_turmoil: baseHardMean,
        hard_calm_share: baseHardCalm,
      },
      by_kind: byKind,
      all_events: summarize(all),
      knowledge_reads_combined: summarize(all.filter((e) => e.kind !== "cli_grep" && e.kind !== "cli_show")),
    },
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

// 直接実行された時だけ走る (検出ロジックを別スクリプトから import して
// スポットチェックできるように、副作用を main 実行に閉じる)
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(String(err?.stack || err) + "\n");
    process.exit(1);
  });
}

export { analyzeSession, detectCliVerbs, detectVaultReadsInBash, expandVars, commandKey };

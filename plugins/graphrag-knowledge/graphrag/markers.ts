/**
 * markers: `graphrag:` コメントマーカーの共有文法と、参照先の生存検証。
 *
 * マーカーはコードとグラフを繋ぐ最小の配線。コメントは「開いたファイル」からしか
 * 届かず、グラフは「引いた質問」からしか届かない — 経路が違うので代替関係にない。
 * マーカーは両者を繋ぐ: コード側 (破られやすい側) に「結論1行 + グラフ id」だけを置き、
 * 理由・経緯・却下案はグラフに置く。普通のコメントと違い、参照先の実在・生存を
 * 機械検証できるのがマーカーの存在意義:
 *
 *   - `graphrag:see <node-id>`      : 汎用参照 — この場所の判断/背景はグラフの <id> にある
 *   - `graphrag:enforces <id>`      : この検査は登記済み Constraint の enforcer である
 *                                     (双方向の配線突合は constraint-check の守備範囲のまま。
 *                                      ここでは全マーカー共通の「参照先が生きているか」だけ)
 *
 * 検証は決定的3判定 (意味判断なし):
 *   - marker-broken-ref     : 参照先ノードが vault に無く、台帳にも無い (typo / 未登記)
 *   - marker-tombstoned-ref : 参照先は削除済み (台帳が知っている)。successor が居れば
 *                             301 (張り替え先を案内)、居なければ 410
 *   - marker-superseded-ref : 参照先は生きているが superseded — 後継 (refines 逆辿り) を案内
 *
 * 呼び出し元: delta-check (diff スコープ per-file 走査 = 書く瞬間の現場検証) /
 * xref-check --root (repo 全域 git grep = 定期の参照整合)。
 */

import { execFileSync } from "node:child_process";
import { canonicalType } from "./schema.ts";
import { latestTombstones, resolveSuccessor, type TombstoneEntry } from "./tombstones.ts";

/**
 * マーカー文法: `graphrag:<verb> <node-id>`。コメント記法非依存 (`//` `#` `--` どれでも)、
 * 1 行に複数可。id は `<type>:<system>:<slug>` — 3セグメントとも typed-add の検証と同じ
 * 文字集合 `[a-z0-9._-]` に閉じる (slug は `/` を含まない = 末尾の括弧/句読点/正規表現
 * デリミタが id に吸い込まれない)。file id (パス入り) は対象外: マーカーの宛先は知識
 * ノードであって、ファイルを指したいならパスを書けばよい。constraint-check の
 * ENFORCES_MARKER_RE と同じ文字集合。
 */
export const REF_MARKER_RE = /graphrag:(see|enforces)\s+([a-z][a-z0-9_-]*:[a-z0-9._-]+:[a-z0-9._-]+)/g;

/**
 * 文字列リテラル内 (`"…"` `'…'` `` `…` ``) を潰してから走査する — テストのフィクスチャや
 * ログ文言に書かれた id を実マーカーと誤認しない (マーカーを含むテストを書くたびに warn が
 * 出る設計は alert fatigue で導線ごと死ぬ)。正当なマーカーは常にコメント内 = リテラル外に
 * あるので偽陰性は実質起きない。完璧な字句解析は不要 (hook の stripQuoted と同じ近似)。
 */
function stripQuotedInLine(line: string): string {
  return line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

export interface RefMarkerHit {
  path: string; // repo root 相対 (POSIX)
  line: number;
  marker: "see" | "enforces";
  targetId: string;
}

export interface MarkerRefFinding {
  kind: "marker-broken-ref" | "marker-tombstoned-ref" | "marker-superseded-ref";
  severity: "warn";
  marker: "see" | "enforces";
  file_path: string;
  line: number;
  target_id: string;
  detail: string;
  next_step: string;
}

/** 1 ファイルの内容からマーカーを行番号つきで走査する (文字列リテラル内は無視)。 */
export function scanMarkersInContent(relPath: string, content: string): RefMarkerHit[] {
  const hits: RefMarkerHit[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of stripQuotedInLine(lines[i]).matchAll(REF_MARKER_RE)) {
      hits.push({ path: relPath, line: i + 1, marker: m[1] as "see" | "enforces", targetId: m[2] });
    }
  }
  return hits;
}

/**
 * repo 全域のマーカーを git grep で機械走査する。-I でバイナリ除外。
 * .md は除外 (マーカーは実行されるコード側の配線であって文書ではない — 文書中の
 * コード例を誤検出しないため)。vault 配下 (.graphrag/) も除外 (知識ノード本文が
 * 規約を引用し得る)。constraint-check の走査と同じ除外規約。
 */
export function grepMarkersInRepo(root: string): RefMarkerHit[] {
  let out = "";
  try {
    out = execFileSync(
      "git",
      ["-C", root, "grep", "-n", "-I", "-E", "graphrag:(see|enforces)", "--", "."],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (e: any) {
    if (e?.status === 1) return []; // no matches
    throw e;
  }
  const hits: RefMarkerHit[] = [];
  for (const lineText of out.split("\n")) {
    if (lineText.length === 0) continue;
    const first = lineText.indexOf(":");
    const second = lineText.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    const relPath = lineText.slice(0, first);
    if (relPath.endsWith(".md") || relPath.split("/").includes(".graphrag")) continue;
    const lineNo = Number(lineText.slice(first + 1, second));
    const content = stripQuotedInLine(lineText.slice(second + 1));
    for (const m of content.matchAll(REF_MARKER_RE)) {
      hits.push({
        path: relPath,
        line: Number.isFinite(lineNo) ? lineNo : 0,
        marker: m[1] as "see" | "enforces",
        targetId: m[2]
      });
    }
  }
  return hits;
}

/**
 * マーカー参照先の生存検証。graph はロード済みを受け取る (呼び出し元が既に持っている)。
 * tombstone 台帳は vaultDir から遅延ロード (ヒットが無ければ読まない)。
 */
export function verifyMarkerRefs(
  hits: RefMarkerHit[],
  graph: { nodes?: any[]; edges?: any[] },
  vaultDir: string
): MarkerRefFinding[] {
  if (hits.length === 0) return [];
  const nodesById = new Map<string, any>();
  for (const n of graph.nodes ?? []) {
    if (typeof n?.id === "string") nodesById.set(n.id, n);
  }
  // superseded の後継: refines (新 → 旧) の逆引き。
  const refinersByTarget = new Map<string, string[]>();
  for (const e of graph.edges ?? []) {
    if (e?.type !== "refines" || typeof e.from !== "string" || typeof e.to !== "string") continue;
    if (!refinersByTarget.has(e.to)) refinersByTarget.set(e.to, []);
    refinersByTarget.get(e.to)!.push(e.from);
  }

  let tombs: Map<string, TombstoneEntry> | null = null;
  const findings: MarkerRefFinding[] = [];

  for (const hit of hits) {
    const target = nodesById.get(hit.targetId);
    if (!target) {
      tombs ??= latestTombstones(vaultDir);
      const entry = tombs.get(hit.targetId);
      if (entry) {
        const successor = resolveSuccessor(tombs, hit.targetId).final_successor;
        findings.push({
          kind: "marker-tombstoned-ref",
          severity: "warn",
          marker: hit.marker,
          file_path: hit.path,
          line: hit.line,
          target_id: hit.targetId,
          detail:
            `${hit.path}:${hit.line} references ${hit.targetId}, which was deleted ${String(entry.deleted_at)}` +
            (successor ? ` and replaced by ${successor} (301).` : " with no successor (410)."),
          next_step: successor
            ? `Update the marker to \`graphrag:${hit.marker} ${successor}\` (the ledger says that is the replacement).`
            : "The knowledge this marker points at is gone. If the fact still matters, re-register it and repoint the marker; otherwise remove the stale marker."
        });
      } else {
        findings.push({
          kind: "marker-broken-ref",
          severity: "warn",
          marker: hit.marker,
          file_path: hit.path,
          line: hit.line,
          target_id: hit.targetId,
          detail: `${hit.path}:${hit.line} references ${hit.targetId}, but no such node exists in the vault (and the deletion ledger has no record of it).`,
          next_step:
            "Fix the id if it is a typo. If the knowledge was never registered, register it (add-* / commit-mutation) or remove the marker — a marker pointing at nothing is worse than no marker."
        });
      }
      continue;
    }
    if (target.state === "superseded") {
      const successors = refinersByTarget.get(hit.targetId) ?? [];
      findings.push({
        kind: "marker-superseded-ref",
        severity: "warn",
        marker: hit.marker,
        file_path: hit.path,
        line: hit.line,
        target_id: hit.targetId,
        detail:
          `${hit.path}:${hit.line} references ${hit.targetId} ("${target.title ?? hit.targetId}"), which is superseded` +
          (successors.length > 0 ? ` — successor: ${successors.join(", ")}.` : " (no refining successor found in the graph)."),
        next_step: successors.length > 0
          ? `The decision moved on. Read ${successors.join(" / ")} and repoint the marker if the code follows the successor (or update the code if it still implements the superseded policy).`
          : "The referenced knowledge is superseded. Find the current policy (ask), then repoint the marker or update the code."
      });
    }
  }
  return findings;
}

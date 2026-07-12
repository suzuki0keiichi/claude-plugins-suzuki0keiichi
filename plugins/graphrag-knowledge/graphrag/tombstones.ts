/**
 * tombstones: ノード削除の台帳 (issue #18)。
 *
 * ゲートの node delete は関連エッジをカスケード削除するが、従来その記録は commit 結果
 * JSON にしか残らず、生きているグラフから「この ID は消えたか / いつ・なぜ / 後継はどれか」
 * を引く手段が無かった。purge-and-replace 型の書き手 (crawler) が増えて参照が vault 外
 * (レビューキュー・他 vault への薄い写し) に漏れるようになったため、削除を vault 内の
 * 台帳に記録し、切れた参照を後継 (successor / 301) へ辿れるようにする。
 *
 * 形式: `<vaultDir>/.tombstones/YYYY-MM.jsonl` (deleted_at による月シャード)。
 *   - append-only。同一 id は deleted_at が最新のエントリが勝つ (時刻 last-wins)。これにより
 *     「削除時点では後継不明 → 後から successor だけ追記」が台帳の書き換えなしにできる。
 *     行順でなく時刻で解決するのは merge=union (下記) が行順を保証しないため。
 *   - `.tombstones/.gitattributes` (`*.jsonl merge=union`) をゲートが自動同梱する。
 *     ブランチ並行の削除が同一シャードへ追記しても git が両側の行を残して自動 merge し、
 *     **利用者が台帳の競合マーカーを見ることは無い**。各行は独立した事実なので
 *     「全部残す」が常に正しい解決 (union の意味論と一致する)。
 *   - ドットディレクトリなので writeVaultDelta の孤児 .md 削除 / pruneEmptyDirs /
 *     Obsidian の走査対象にならず、gitCommitVault (`git add -- .`) には乗る
 *     (= mutation と同一コミットで確定する)。
 *   - 台帳は「リダイレクト情報 (successor)」と「修復ペイロード (cascaded_edges)」の
 *     二層寿命を持つ。肥大化したら修復済み/期限切れエントリを successor だけの
 *     redirect-only 行に圧縮してよい (シャード単位の破棄も可)。圧縮は将来の verb。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TOMBSTONES_DIR = ".tombstones";

export type TombstoneEdge = { id?: string; type?: string; from?: string; to?: string };

export type TombstoneEntry = {
  /** 削除されたノード id */
  id: string;
  type?: string;
  title?: string;
  /** ISO 8601 */
  deleted_at: string;
  /** mutation の reason (なぜ消えたか) */
  reason: string;
  /** 後継ノード id (301)。未知なら省略し、後から last-wins で追記できる */
  successor?: string;
  /** この削除でカスケード削除されたエッジの全タプル (機械修復の材料) */
  cascaded_edges?: TombstoneEdge[];
};

/** deleted_at から月シャードの vault 相対パスを返す (例 ".tombstones/2026-07.jsonl")。 */
export function tombstoneShardRel(deletedAt: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(deletedAt);
  if (!m) throw new Error(`tombstone deleted_at is not ISO 8601: ${deletedAt}`);
  return path.join(TOMBSTONES_DIR, `${m[1]}-${m[2]}.jsonl`);
}

/**
 * エントリを月シャードへ追記する (シャード全体を tmp+rename で原子書き)。
 * sink を渡すと written / created に相対パスを積む — applyMutationToVault の delta と
 * 同じ器なので、commit 失敗時の rollback (tracked は git restore、created は unlink)
 * がそのまま台帳にも効く。返り値は書いたシャードの相対パス一覧。
 */
export function appendTombstones(
  vaultDir: string,
  entries: TombstoneEntry[],
  sink?: { written: string[]; created: string[] }
): string[] {
  if (entries.length === 0) return [];
  ensureUnionMergeAttributes(vaultDir, sink);
  const byShard = new Map<string, TombstoneEntry[]>();
  for (const e of entries) {
    const rel = tombstoneShardRel(e.deleted_at);
    if (!byShard.has(rel)) byShard.set(rel, []);
    byShard.get(rel)!.push(e);
  }
  const shards: string[] = [];
  for (const [rel, list] of byShard) {
    const abs = path.join(vaultDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    const existed = existsSync(abs);
    const prev = existed ? readFileSync(abs, "utf8") : "";
    const lines = list.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const next = prev.length > 0 && !prev.endsWith("\n") ? `${prev}\n${lines}` : prev + lines;
    const tmp = `${abs}.tmp-${process.pid}`;
    writeFileSync(tmp, next);
    renameSync(tmp, abs);
    shards.push(rel);
    if (sink) {
      sink.written.push(rel);
      if (!existed) sink.created.push(rel);
    }
  }
  return shards;
}

/**
 * `.tombstones/.gitattributes` (`*.jsonl merge=union`) を無ければ書く。
 * union は git 組み込みの merge driver なので利用者側の設定は一切不要 — この1ファイルが
 * リポジトリに乗っているだけで、ブランチ双方が同一シャードへ追記しても競合マーカーが
 * 出ず両側の行が残る。台帳の各行は独立した事実なのでこれが常に正しい解決。
 * 初回 append と同じ commit に乗せるため sink (delta) にも積む。
 */
function ensureUnionMergeAttributes(
  vaultDir: string,
  sink?: { written: string[]; created: string[] }
): void {
  const rel = path.join(TOMBSTONES_DIR, ".gitattributes");
  const abs = path.join(vaultDir, rel);
  if (existsSync(abs)) return;
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, "*.jsonl merge=union\n");
  if (sink) {
    sink.written.push(rel);
    sink.created.push(rel);
  }
}

export type TombstoneReadResult = {
  entries: TombstoneEntry[];
  /** parse できなかった行 (fsck が error として報告する) */
  errors: Array<{ shard: string; line: number; error: string }>;
};

/** 全シャードを名前順 (= 時系列) に読む。行順が追記順なので last-wins 解決に使える。 */
export function readTombstones(vaultDir: string): TombstoneReadResult {
  const dir = path.join(vaultDir, TOMBSTONES_DIR);
  const result: TombstoneReadResult = { entries: [], errors: [] };
  if (!existsSync(dir)) return result;
  const shards = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  for (const shard of shards) {
    const rel = path.join(TOMBSTONES_DIR, shard);
    const text = readFileSync(path.join(dir, shard), "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (typeof e?.id !== "string" || typeof e?.deleted_at !== "string" || typeof e?.reason !== "string") {
          result.errors.push({ shard: rel, line: i + 1, error: "missing required field (id / deleted_at / reason)" });
          continue;
        }
        result.entries.push(e);
      } catch (err) {
        result.errors.push({ shard: rel, line: i + 1, error: String(err instanceof Error ? err.message : err) });
      }
    }
  }
  return result;
}

/**
 * id ごとの最新エントリ。**行順でなく deleted_at で決定的に解決する** — merge=union は
 * 競合ハンクの行順を保証しないため、ファイル上の位置に意味を持たせると merge のたびに
 * 解決結果が揺れる。同時刻の同 id は successor 持ちを優先する (301 情報を落とさない側に
 * 倒す。それも同点なら stable sort によりファイル上の後の行が勝つ)。
 */
export function latestTombstones(vaultDir: string): Map<string, TombstoneEntry> {
  const entries = [...readTombstones(vaultDir).entries];
  entries.sort((a, b) =>
    a.deleted_at < b.deleted_at
      ? -1
      : a.deleted_at > b.deleted_at
        ? 1
        : (a.successor ? 1 : 0) - (b.successor ? 1 : 0)
  );
  const map = new Map<string, TombstoneEntry>();
  for (const e of entries) map.set(e.id, e);
  return map;
}

export type SuccessorResolution = {
  /** チェーンを畳んだ最終後継 id (successor 無しなら null = 410 gone) */
  final_successor: string | null;
  /** 辿った id 列 (起点を含む) */
  chain: string[];
  /** チェーン中に循環を検出したか (検出時は final_successor を打ち切り時点で返す) */
  cycle: boolean;
};

/**
 * successor チェーン (旧→新→新') を畳む。後継自身も tombstone 済みなら更に辿る。
 * 循環は visited で打ち切り cycle:true を立てる (壊れた台帳でも無限ループしない)。
 */
export function resolveSuccessor(
  tombstones: Map<string, TombstoneEntry>,
  id: string
): SuccessorResolution {
  const chain: string[] = [id];
  const visited = new Set<string>([id]);
  let cur = tombstones.get(id);
  while (cur?.successor) {
    if (visited.has(cur.successor)) {
      return { final_successor: cur.successor, chain, cycle: true };
    }
    visited.add(cur.successor);
    chain.push(cur.successor);
    cur = tombstones.get(cur.successor);
  }
  const last = chain[chain.length - 1];
  return { final_successor: last === id ? null : last, chain, cycle: false };
}

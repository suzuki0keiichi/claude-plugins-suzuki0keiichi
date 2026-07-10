// checkpoint → /clear 復元の予約キーを ask-state.json に刻む `checkpoint-mark` verb。
//
// graphrag-checkpoint skill が退避 (A ステップ: active Investigation の raw_content 更新) を
// 書き終えた後にこれを呼ぶ。ここで active Investigation の work_state を「検証」してから、
// ask-state.json の予約キー (CHECKPOINT_STATE_KEY) に「clear されたら復元せよ」の内容を書く。
// SessionStart フック (hooks/clear-restore.mjs) が source==="clear" のときだけ one-shot で消費する。
//
// 設計 (旧「ファイルマーカー方式」からの転換):
//   - 新ファイル種を増やさない: checkpoint-pending.json を廃し ask-state.json に相乗り。
//   - 復元経路を素にする: フックは CLI 起動も graph パースも primary 選択ヒューリスティックも
//     せず、予約キーの中身をそのまま注入する。検証は「文脈が生きている checkpoint 時」に済ませる
//     ので、失敗はここで (直せる場所で) hard-error になる。
//   - compact では復元しない: 古い checkpoint の無条件再注入はミスリードなので clear 限定。
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { cacheDirForVault } from "./cli-env.ts";
import { loadGraph } from "./retrieval.ts";
import {
  CHECKPOINT_STATE_KEY,
  loadAskState,
  saveAskState,
  type CheckpointStateEntry
} from "./cli-ask-state.ts";

// 予約キーの失効窓。主の消費はフック側の one-shot 削除であり、これは「checkpoint-mark を
// 撃ったが clear しなかった」古い意図が翌日の無関係な /clear で暴発しないための保険。
// hooks/clear-restore.mjs は依存ゼロ方針でこの値を import せず複製する (相互参照コメントを両側に置く)。
export const CHECKPOINT_TTL_MS = 60 * 60 * 1000; // 60 分

// raw_content の上限。これを超える深い生ログは ConversationChunk に置くべき。
const RAW_CONTENT_MAX_BYTES = 8 * 1024; // 8KB

/**
 * `checkpoint-mark` verb 本体 (cli-headlines.ts の dispatchHeadline から呼ばれる)。
 * 引数: --investigation <id> (必須) [--vault <dir>]
 * 出力: { investigation_id, first_action, marked_at, ttl_minutes, state_path, note } の JSON。
 */
export async function runCheckpointMark(argv: string[]): Promise<void> {
  const flags = parseMarkFlags(argv);

  if (!flags.investigation) {
    throw new Error(
      "checkpoint-mark requires --investigation <id>: pass the id of the active Investigation you " +
      "updated in step A (of the graphrag-checkpoint skill). work_state is verified from this node and the restore payload built from it."
    );
  }
  const vaultDir = flags.vault ?? process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) {
    throw new Error(
      "checkpoint-mark requires a vault: pass --vault <dir> or set GRAPHRAG_VAULT_DIR " +
      "(.graphrag/.env or auto-discovery)"
    );
  }

  // cli-headlines.ts と同じ経路で graph をロードし、注入対象ノードを検証する。
  const graph = await loadGraph(vaultDir);
  const node = (graph.nodes ?? []).find((n: any) => n.id === flags.investigation);
  if (!node) {
    throw new Error(
      `checkpoint-mark: Investigation "${flags.investigation}" does not exist in the vault. ` +
      "Pass the real id of the Investigation you updated in step A (of the graphrag-checkpoint skill) (possible typo or uncommitted)."
    );
  }
  if (node.type !== "Investigation") {
    throw new Error(
      `checkpoint-mark: "${flags.investigation}" has type=${node.type}, not Investigation. ` +
      "Pass the id of the active Investigation to carry work_state."
    );
  }
  if (node.state !== "active") {
    throw new Error(
      `checkpoint-mark: Investigation "${flags.investigation}" has state=${node.state ?? "(none)"}, not active. ` +
      "Only an in-progress (state: active) focus can be restored. Set it active via op:update before checkpointing."
    );
  }

  const raw = typeof node.raw_content === "string" ? node.raw_content : "";
  if (raw.trim() === "") {
    throw new Error(
      `checkpoint-mark: Investigation "${flags.investigation}" has empty raw_content. ` +
      "Write the work state in the skill's work_state format (current focus:/next:/blocker:/touched:)."
    );
  }
  // 大文字小文字は寛容 (/mi)。行頭マッチで「current focus:」「next:」の存在を確かめる。
  if (!/^current focus:/mi.test(raw)) {
    throw new Error(
      `checkpoint-mark: raw_content has no "current focus:" line. ` +
      "Write it in the skill's work_state format (current focus:/next:/blocker:/touched:)."
    );
  }
  if (!/^next:/mi.test(raw)) {
    throw new Error(
      `checkpoint-mark: raw_content has no "next:" line. ` +
      "Write it in the skill's work_state format (current focus:/next:/blocker:/touched:)."
    );
  }

  const firstAction = extractFirstAction(raw);
  if (!firstAction) {
    throw new Error(
      `checkpoint-mark: next's first action is empty. Write a unique first action at the head of next: ` +
      "(concrete down to file:line or a runnable command). Restore resumes from this action."
    );
  }

  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > RAW_CONTENT_MAX_BYTES) {
    throw new Error(
      `checkpoint-mark: raw_content is ${bytes} bytes, over the ${RAW_CONTENT_MAX_BYTES} bytes (8KB) limit. ` +
      "Put deep raw logs in a ConversationChunk and keep work_state to a focus/next/blocker/touched summary."
    );
  }

  // 予約キーの置き場所は cacheDirForVault(vaultDir) 固定。resolveAskStateDir は使わない:
  //   - 復元フック (clear-restore.mjs) は依存ゼロのままこの規則を複製して読む: walk-up で
  //     anchor を見つけ、.graphrag/.env の GRAPHRAG_VAULT_DIR も解決して「vault の親の
  //     .graphrag/cache」に辿り着く。書き手と読み手は常にこの同一規則で揃えること —
  //     片側だけ変えると共有 vault 構成で分裂し、復元が毎回無音で失敗する (実際に起きた)。
  //   - checkpoint は vault へ知識を書く行為なので readonly モード (consumer cache) は前提にない。
  const stateDir = cacheDirForVault(vaultDir);
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

  const now = Date.now();
  const entry: CheckpointStateEntry = {
    count: 0,                              // ask 連打カウントとは無縁。0 固定 (型互換のため持たせる)。
    last_at: now,                          // ms epoch。既存 24h GC に自然に乗る (無いと不死化)。
    marked_at: new Date(now).toISOString(),
    cwd: process.cwd(),
    investigation_id: flags.investigation,
    first_action: firstAction,
    work_state: raw
  };

  // 他キー (ask 連打カウント等) を保ったまま予約キーだけ差し替える。
  const state = loadAskState(stateDir);
  state[CHECKPOINT_STATE_KEY] = entry;
  saveAskState(stateDir, state);

  const statePath = path.join(stateDir, "ask-state.json");
  // 書き込み系 verb と同じく、どの state dir へ書いたかを stderr で可視化する。
  process.stderr.write(`[graphrag] checkpoint state: ${statePath}\n`);
  process.stdout.write(JSON.stringify({
    investigation_id: flags.investigation,
    first_action: firstAction,
    marked_at: entry.marked_at,
    ttl_minutes: CHECKPOINT_TTL_MS / 60_000,
    state_path: statePath,
    note: "one-shot: the /clear restore hook consumes it exactly once. compact does not restore"
  }, null, 2) + "\n");
}

/**
 * next: の「最初の一手」を抽出する。
 *   1. `next:` と同じ行の後続テキストが非空ならそれ。
 *   2. 空なら next: 行の直後の最初の非空行 (箇条書き記号 `-` `*` `1)` `1.` 等を剥がす)。
 * 抽出できなければ "" を返す (呼び手が hard-error にする)。
 */
export function extractFirstAction(raw: string): string {
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^next:(.*)$/i.exec(lines[i]);
    if (!m) continue;
    // 1. 同一行の後続
    const inline = m[1].trim();
    if (inline) return stripBullet(inline);
    // 2. 直後の最初の非空行
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t) return stripBullet(t);
    }
    return "";
  }
  return "";
}

// 先頭の箇条書き記号 (- * • / 1) 1. 等) を 1 つ剥がす。以降のテキストはそのまま。
function stripBullet(s: string): string {
  return s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
}

function parseMarkFlags(argv: string[]): { vault?: string; investigation?: string } {
  const out: { vault?: string; investigation?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--vault" && typeof argv[i + 1] === "string") { out.vault = argv[++i]; continue; }
    if (tok === "--investigation" && typeof argv[i + 1] === "string") { out.investigation = argv[++i]; continue; }
  }
  return out;
}

// checkpoint → /clear 復元の one-shot マーカー。
//
// graphrag-checkpoint skill が退避を書き終えた後に `checkpoint-mark` verb で
// 「clear されたら復元せよ」という意図を state dir の cache に刻む。
// SessionStart フック (hooks/compact-restore.mjs) が clear/compact 時にこれを
// 読み取り、消費 (削除) する。
//
// なぜ壁時計ゲート (generated_at 10 分以内) だけでは足りないか:
//   1. checkpoint 完了 → 報告を読む → 少し会話 → /clear で 10 分は簡単に超える。
//   2. op:update は内容が実際に変わった時しか generated_at を進めない
//      (mutation-core の idempotence 維持)。同内容の再 checkpoint 直後の /clear が
//      「古い」と誤判定される。
// マーカーは「復元してほしい」という明示の意図なので、消費されるまで有効
// (暴発防止の緩い TTL のみ)。
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cacheDirForVault } from "./cli-env.ts";

export const CHECKPOINT_MARKER_FILENAME = "checkpoint-pending.json";

/** 暴発防止の TTL。one-shot 消費が主で、これは「撃ったが clear しなかった」古い意図の失効用。 */
export const CHECKPOINT_MARKER_TTL_MS = 60 * 60 * 1000; // 60 分

export type CheckpointMarker = {
  marked_at: string; // ISO 8601
  focus?: string;    // 任意: 退避した focus の一行 (人間/フックのデバッグ用)
};

export function checkpointMarkerPath(vaultDir: string): string {
  return path.join(cacheDirForVault(vaultDir), CHECKPOINT_MARKER_FILENAME);
}

export function writeCheckpointMarker(
  vaultDir: string,
  focus?: string,
  now: number = Date.now()
): { marker_path: string; marker: CheckpointMarker } {
  const markerPath = checkpointMarkerPath(vaultDir);
  mkdirSync(path.dirname(markerPath), { recursive: true });
  const marker: CheckpointMarker = {
    marked_at: new Date(now).toISOString(),
    ...(focus ? { focus } : {})
  };
  writeFileSync(markerPath, JSON.stringify(marker, null, 2));
  return { marker_path: markerPath, marker };
}

/** 壊れた/読めないマーカーは null (存在しない扱い)。 */
export function readCheckpointMarker(vaultDir: string): CheckpointMarker | null {
  const markerPath = checkpointMarkerPath(vaultDir);
  if (!existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.marked_at !== "string") return null;
    return parsed as CheckpointMarker;
  } catch {
    return null;
  }
}

/** one-shot 消費。無くても失敗しない。 */
export function consumeCheckpointMarker(vaultDir: string): void {
  try {
    unlinkSync(checkpointMarkerPath(vaultDir));
  } catch {
    // 既に無い / 消せない — 消費は best-effort
  }
}

/**
 * `checkpoint-mark` verb 本体。
 * 引数: [--focus "<一行>"] [--vault <dir>]
 * 出力: { marker_path, marked_at, ttl_minutes } の JSON。
 */
export async function runCheckpointMark(argv: string[]): Promise<void> {
  const flags = parseMarkFlags(argv);
  const vaultDir = flags.vault ?? process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) {
    throw new Error(
      "checkpoint-mark requires a vault: pass --vault <dir> or set GRAPHRAG_VAULT_DIR " +
      "(.graphrag/.env or auto-discovery)"
    );
  }
  const { marker_path, marker } = writeCheckpointMarker(vaultDir, flags.focus);
  // 書き込み系 verb と同じく、どの vault (state dir) に書いたかを stderr で可視化する。
  process.stderr.write(`[graphrag] checkpoint marker: ${marker_path}\n`);
  process.stdout.write(JSON.stringify({
    marker_path,
    marked_at: marker.marked_at,
    ttl_minutes: CHECKPOINT_MARKER_TTL_MS / 60_000,
    note: "one-shot: /clear または compact の復元フックが一度だけ消費する"
  }, null, 2) + "\n");
}

function parseMarkFlags(argv: string[]): { vault?: string; focus?: string } {
  const out: { vault?: string; focus?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--vault" && typeof argv[i + 1] === "string") { out.vault = argv[++i]; continue; }
    if (tok === "--focus" && typeof argv[i + 1] === "string") { out.focus = argv[++i]; continue; }
  }
  return out;
}

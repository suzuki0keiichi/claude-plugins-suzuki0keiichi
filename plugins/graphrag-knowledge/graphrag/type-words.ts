/**
 * type-words: 自然文 query に混ざった schema の型名 ("Decision" 等) を扱う共通の文字列処理 (issue #36)。
 *
 * 型名は通常語として lexical と embedding の両方を汚染し、本文に型名を含むだけの node を
 * high で 1 位に押し上げる。一方で型そのものを問う文 ("Risk と Decision の使い分け") では型名こそが
 * 内容なので、除去版で置き換えることはしない。prompt rail と ask は、元 query と除去版の top1 が
 * 一致するかどうかを「query 摂動への不安定性」の検知にだけ使う (正誤判定ではない)。
 */

function typeWordPattern(typeNames: readonly string[], flags: string): RegExp {
  // 境界は ASCII 英数字のみで判定する (「Decisionを」のように和文へ直結する書き方を拾う)。
  return new RegExp(`(?<![A-Za-z0-9])(?:${typeNames.join("|")})(?![A-Za-z0-9])`, flags);
}

/**
 * query から型名を除いた補助 query。型名を含まなければ null。除いた結果が空なら null
 * (型名だけの query は比較のしようがない)。
 */
export function stripTypeWords(query: string, typeNames: readonly string[]): string | null {
  if (typeNames.length === 0 || !typeWordPattern(typeNames, "i").test(query)) return null;
  const stripped = query.replace(typeWordPattern(typeNames, "gi"), " ").replace(/\s+/g, " ").trim();
  return stripped.length > 0 ? stripped : null;
}

/** query に現れた型名を schema の正規名で、出現順・重複なしで返す。 */
export function typeWordsIn(query: string, typeNames: readonly string[]): string[] {
  if (typeNames.length === 0) return [];
  const byLower = new Map(typeNames.map((t) => [t.toLowerCase(), t]));
  const found: string[] = [];
  for (const m of query.matchAll(typeWordPattern(typeNames, "gi"))) {
    const canonical = byLower.get(m[0].toLowerCase());
    if (canonical && !found.includes(canonical)) found.push(canonical);
  }
  return found;
}

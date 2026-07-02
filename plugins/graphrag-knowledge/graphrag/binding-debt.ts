// binding_debt の単一定義 (check-carving gate #9 knowledge-impl-binding-missing +
// #9 拡張 constraint-binding-missing と同値)。
//
// 以前は mutate-vault.ts / cli-headlines.ts / check-carving.ts に同じ判定式が
// 三重定義され「keep in sync」コメントで縛っていた。定義が漂流すると
// 「書けたのに後で別基準で debt 扱い」になるため、ここに一本化する。
import { canonicalType } from "./schema.ts";

/**
 * 「実装ファイルへの binding」判定: docs/knowhow / plans / docs/design-decisions の
 * File は「出所」であって実装ファイルではないので binding に数えない。
 */
export function isImplFileBinding(toId: string): boolean {
  return toId.startsWith("file:") && !/docs\/knowhow\/|plans\/|docs\/design-decisions\//.test(toId);
}

/**
 * binding_debt: bind されていない知識ノードの総数。
 * - Decision / OperationalKnowledge / Risk: 実装 File 宛の sets_policy_for または
 *   documented_by が 1 本も無ければ debt。
 * - Constraint: constrains エッジ (宛先不問) が 0 本なら debt。
 */
export function countBindingDebt(graph: { nodes?: any[]; edges?: any[] }): number {
  const outEdges = new Map<string, any[]>();
  for (const e of graph.edges ?? []) {
    const arr = outEdges.get(e.from) ?? [];
    arr.push(e);
    outEdges.set(e.from, arr);
  }
  let debt = 0;
  for (const n of graph.nodes ?? []) {
    const t = canonicalType(n.type);
    const oe = outEdges.get(n.id) ?? [];
    if (t === "Decision" || t === "OperationalKnowledge" || t === "Risk") {
      const hasPolicy = oe.some((e) => e.type === "sets_policy_for" && isImplFileBinding(e.to));
      const hasImplDoc = oe.some((e) => e.type === "documented_by" && isImplFileBinding(e.to));
      if (!hasPolicy && !hasImplDoc) debt += 1;
    } else if (t === "Constraint") {
      if (!oe.some((e) => e.type === "constrains")) debt += 1;
    }
  }
  return debt;
}

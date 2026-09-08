/** Bounded delivery of registered intent. Full bodies and references have
 * different delivery semantics; the stateful rail records only bodyIds. */
import { STRUCTURE_TYPE_ORDER, type StructureSummary } from "./crosscut-map.ts";

export const STRUCTURE_BUDGET_CHARS = 1000;
export const STRUCTURE_MAX_ITEMS = 2;

export interface StructureContext {
  context: string;
  bodyIds: string[];
  omittedIds: string[];
  unavailableIds: string[];
  chars: number;
}

/** Knowledge has its own unchanged budget. Reserve any separator in the caller
 * when this block and the knowledge block share one additionalContext. */
export function composeStructureContext(
  relPath: string,
  structures: StructureSummary[],
  delivered: ReadonlySet<string>,
  budget: number = STRUCTURE_BUDGET_CHARS
): StructureContext | null {
  const pending = structures.filter((s) => !delivered.has(s.id)).sort((a, b) =>
    STRUCTURE_TYPE_ORDER[a.type] - STRUCTURE_TYPE_ORDER[b.type] ||
    a.files_total - b.files_total || a.id.localeCompare(b.id));
  if (pending.length === 0) return null;
  const available = pending.filter((s) => !s.summary_provisional && s.summary.trim().length > 0);
  const unavailableIds = pending.filter((s) => s.summary_provisional || s.summary.trim().length === 0).map((s) => s.id);
  const maxChars = Math.min(budget, STRUCTURE_BUDGET_CHARS);
  const fileLabel = relPath.length <= 120 ? relPath : `${relPath.slice(0, 119)}…`;
  const header = `Registered intent (may be stale): ${fileLabel}`;
  const bodyIds = new Set<string>();
  const rows: string[] = [];
  const render = (content: string[], remaining: number, refs = "", unavailableRefs = "") =>
    `<graphrag structure>\n${header}\n${content.join("\n")}` +
    (remaining > 0 ? `\n${remaining} structure body/bodies not shown${refs}. Read the file scope via delta-check --files <path> --full.` : "") +
    (unavailableIds.length > 0 ? `\n${unavailableIds.length} intent(s) not authored (missing/provisional)${unavailableRefs}; no complete norm is available.` : "") +
    "\n</graphrag structure>";

  for (const s of available) {
    if (bodyIds.size >= STRUCTURE_MAX_ITEMS) break;
    // No headline clipping: the end may contain the condition or prohibition.
    const row = `- [${s.type}] ${s.id}\n${s.summary}`;
    const candidate = render([...rows, row], available.length - bodyIds.size - 1);
    if (candidate.length > maxChars) continue;
    rows.push(row);
    bodyIds.add(s.id);
  }

  const omittedIds = available.filter((s) => !bodyIds.has(s.id)).map((s) => s.id);
  let context = render(rows, omittedIds.length);
  if (context.length > maxChars) return null;
  // Add exact references only when they fit; no truncated ids masquerading as
  // usable references. Omitted ids remain available in the CLI result/log count.
  const refs = omittedIds.length ? ` (${omittedIds.slice(0, unavailableIds.length ? 1 : 2).join(", ")})` : "";
  const withRefs = render(rows, omittedIds.length, refs);
  const shownRefs = withRefs.length <= maxChars ? refs : "";
  if (shownRefs) context = withRefs;
  if (unavailableIds.length) {
    const candidate = render(rows, omittedIds.length, shownRefs, ` (${unavailableIds.slice(0, omittedIds.length ? 1 : 2).join(", ")})`);
    if (candidate.length <= maxChars) context = candidate;
  }
  return { context, bodyIds: [...bodyIds], omittedIds, unavailableIds, chars: context.length };
}

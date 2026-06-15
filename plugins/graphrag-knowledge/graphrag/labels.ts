// Pure, side-effect-free node label derivation.
// Extracted from graphrag/view.ts so the vault serializer does not
// drag in the retrieval stack. No imports, no CLI side effects.

// Canonical precedence: display[lang].short_label -> short_label ->
// display[lang].title -> title -> id.
export function deriveShortLabel(node: any, lang = "ja"): string {
  if (!node) return "(missing node)";
  return (
    pickDisplayField(node, "short_label", lang) ??
    pickDisplayField(node, "title", lang) ??
    node.title ??
    node.id
  );
}

export function pickDisplayField(node: any, field: string, lang: string): string | null {
  if (!node) return null;
  const localized = node.display?.[lang]?.[field];
  if (typeof localized === "string" && localized.length > 0) return localized;
  const canonical = node[field];
  return typeof canonical === "string" && canonical.length > 0 ? canonical : null;
}

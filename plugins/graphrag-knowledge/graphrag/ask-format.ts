/**
 * ask-format: ask 出力の LLM 可読ダイジェスト (issue #24)。
 *
 * ask の正本出力は JSON (stages[*].output の深いネスト) で、読み手 (LLM) は本体へ
 * 到達するのに jq/python を要していた (実運用で grep 空振り → python → 一時ファイルの
 * 3連続試行が常態)。`--format md` はその JSON payload を「そのまま読める」markdown に
 * 畳む。情報は落とさない方針ではなく「判断に使う分だけ」を出す — 全量が要る時は
 * 従来の JSON (既定) を使う。id は必ず載せる (次の verb 呼び出しの引数になるため)。
 */

function line(parts: (string | null | undefined)[]): string {
  return parts.filter((p) => typeof p === "string" && p.length > 0).join(" ");
}

function fmtNode(node: any): string[] {
  if (!node) return [];
  const out: string[] = [];
  out.push(line([`- id: \`${node.id}\``, node.state ? `(state: ${node.state})` : null]));
  if (node.summary) out.push(`  ${node.summary}`);
  if (node.path) out.push(`  path: ${node.path}`);
  return out;
}

function fmtRelations(relations: any[]): string[] {
  if (!Array.isArray(relations) || relations.length === 0) return [];
  const items = relations.map((r) => {
    if (r.node) {
      const t = r.node.title ?? r.node.id;
      return `${r.relation}${r.direction === "in" ? "←" : "→"} [${r.node.type}] ${t} \`${r.node.id}\``;
    }
    return `${r.relation}${r.direction === "in" ? "←" : "→"} \`${r.id ?? r.to}\``;
  });
  return [`  relations: ${items.join("; ")}`];
}

function fmtMatch(m: any, index: number): string[] {
  const node = m.node ?? {};
  const out: string[] = [];
  out.push(`### ${index + 1}. [${node.type ?? "?"}] ${node.title ?? node.id ?? "?"}${typeof m.score === "number" ? ` (score ${m.score})` : ""}`);
  out.push(...fmtNode(node));
  if (m.state_note) out.push(`  state_note: ${m.state_note}`);
  if (m.evidence_stale) {
    const paths = (m.evidence_stale.paths ?? []).map((p: any) => `${p.path} (changed ${p.changed_at})`).join(", ");
    out.push(`  evidence_stale: ${m.evidence_stale.note}${paths ? ` [${paths}]` : ""}`);
  }
  out.push(...fmtRelations(m.relations));
  return out;
}

/** runAsk が組み立てた payload (JSON 出力と同じオブジェクト) を markdown に畳む。 */
export function formatAskMarkdown(payload: any): string {
  const out: string[] = [];
  out.push(`# ask: ${payload.question ?? ""}`);

  const brief = (payload.stages ?? []).find((s: any) => s?.stage === "brief")?.output;
  const evidence = (payload.stages ?? []).find((s: any) => s?.stage === "evidence")?.output;
  const query = brief?.query;

  const headline: string[] = [];
  headline.push(line([`- final_stage: ${payload.final_stage ?? "?"}`, `(call #${payload.call_number ?? "?"})`]));
  if (query?.match_confidence) {
    headline.push(`- confidence: **${query.match_confidence}**${query.confidence_message ? ` — ${query.confidence_message}` : ""}`);
  }
  if (payload.retrieval_mode?.semantic === false) {
    headline.push(`- retrieval: **DEGRADED (lexical-only)** — ${payload.retrieval_mode.warning ?? ""}`);
  } else if (query?.vector?.model) {
    headline.push(`- retrieval: semantic (${query.vector.model}) + lexical`);
  }
  if (query?.repeat?.message) headline.push(`- repeat: ${query.repeat.message}`);
  out.push(headline.join("\n"));

  const matches = query?.matches ?? [];
  if (matches.length > 0) {
    out.push(`## matches (${matches.length})`);
    for (let i = 0; i < matches.length; i += 1) out.push(fmtMatch(matches[i], i).join("\n"));
  } else {
    out.push("## matches\n(none)");
  }

  const direct = evidence?.direct_evidence ?? [];
  if (direct.length > 0) {
    out.push(`## direct_evidence (${direct.length})${evidence?.match_confidence ? ` — confidence: ${evidence.match_confidence}` : ""}`);
    for (let i = 0; i < direct.length; i += 1) out.push(fmtMatch(direct[i], i).join("\n"));
  }

  const crosscuts = payload.area_map?.crosscuts ?? [];
  if (crosscuts.length > 0) {
    out.push(
      "## area_map\n" +
        crosscuts
          .map((c: any) => `- [${c.type}] ${c.title} \`${c.id}\` (files ${c.files_in_scope}/${c.files_total})`)
          .join("\n")
    );
  }

  if (payload.enforcement_debt) {
    out.push(`## enforcement_debt\n${payload.enforcement_debt.hint ?? JSON.stringify(payload.enforcement_debt)}`);
  }

  if (payload.next_action_hint) {
    out.push(`## next_action\n${payload.next_action_hint}`);
  }

  return out.join("\n\n") + "\n";
}

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import { importVault, importVaultFile } from "./import-vault.ts";
import { DEFAULT_SCHEMA, validateGraph, type SchemaDefinition } from "./schema.ts";

// =============================================================================
// Property-based round-trip fuzz: for EVERY schema-valid graph g,
//
//   (1) importVault(write(buildVaultFiles(g)))  ≡  normalize(g)      (bit-exact)
//   (2) buildVaultFiles(importVault(...))       ≡  buildVaultFiles(g) (byte-exact)
//
// normalize(g) is the same equivalence the existing gate (import-vault.test.ts)
// asserts: undefined-valued fields are "absent" (never serialized), and a node
// without its own generated_at inherits the graph-level stamp via the banner.
//
// All randomness is seeded (mulberry32); every assertion message carries the
// seed so any failure is reproducible with GRAPHRAG_FUZZ_SEED=<seed>.
//
// Deliberately-excluded input classes (outside the format's legal domain):
//   - NaN / Infinity / -0 numbers: the graph interchange form is JSON
//     (graph.json / commit-mutation plans), and JSON cannot carry them.
//   - lone UTF-16 surrogates in strings: not representable in well-formed
//     UTF-8 files (fs replaces them with U+FFFD before the parser ever runs).
//   - field KEYS outside [A-Za-z_][A-Za-z0-9_]*: the frontmatter grammar keys
//     are identifiers by design (importer's edge-record regex enforces it);
//     graph field names are schema vocabulary, not user prose.
//   - node fields named `links` / `graph_edges`: reserved by the vault format
//     itself (decoration / authoritative edge records) — the importer drops
//     them from nodes by contract.
//   - `generated_at` values with whitespace/newlines: system-managed banner
//     field, always written as an ISO stamp by every producer; the banner is
//     a single line and the importer recovers it as one \S+ token.
//   - non-string node/edge ids and duplicate ids, edges whose `from`/non-vault
//     `to` reference missing nodes: validateGraph rejects them (invalid graphs
//     are not part of the round-trip contract).
//   - arrays-of-objects / nested objects as edge-record values: graph_edges
//     records are flat scalar maps by design (id/type/from/to + scalar
//     extras); nodes carry the nested shapes.
// =============================================================================

type Rec = Record<string, unknown>;

// ---- seeded PRNG ------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rand {
  readonly seed: number;
  private next: () => number;
  constructor(seed: number) {
    this.seed = seed;
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
}

// ---- adversarial value pools ------------------------------------------------

const HOSTILE_STRINGS: readonly string[] = [
  "",
  " ",
  "  leading and trailing  ",
  "\t",
  "tab\there\tand\tthere",
  "key: value",
  ": leads-with-colon-space",
  "ends-with-colon:",
  "# looks-like-comment",
  "- looks-like-item",
  "-",
  "---",
  "--- \nbelow a fake fence",
  "'single quoted'",
  '"double quoted"',
  'she said "hi" and left',
  "back\\slash",
  "\\",
  "a\\nb (literal backslash-n)",
  "line1\nline2",
  "line1\n\nline3 (blank interior line)",
  "\nleading-newline",
  "trailing-newline\n",
  "trailing-newlines\n\n",
  "\n",
  "\r",
  "\r\n",
  "crlf\r\nline",
  "lone\rcarriage",
  "mixed\r\n\rnewlines\n\r\nend\r",
  "[[wikilink|display]]",
  "[bracketed]",
  "pipe|pipe",
  "<b>html</b> & entities &amp;",
  "<!-- plain html comment -->",
  "<!-- graphrag:description:begin -->",
  "<!-- graphrag:description:end -->",
  "<!-- graphrag:raw_content:begin -->",
  "<!-- gestalty:raw_content:end -->",
  "null",
  "~",
  "true",
  "false",
  "yes",
  "no",
  "0",
  "007",
  "1e5",
  "-3.14",
  "0x1F",
  "NaN",
  "Infinity",
  "2026-01-01",
  "2026-01-01T00:00:00Z",
  "12:34:56",
  "絵文字😀🎌テスト",
  "ｚｅｎｋａｋｕ　ｽﾍﾟｰｽ",
  "نص عربي من اليمين إلى اليسار",
  "עברית מימין לשמאל",
  "zero​width‍joiners",
  "​",
  "combining: café vs café",
  "line separator and para separator",
  "bell\u0007 and nul\u0000 controls",
  "x".repeat(4500),
  "long " + "y".repeat(4200) + "\nwith a second line",
  "|-",
  "|",
  ">",
  "> blockquote",
  "graph_edges:",
  "links: {}",
  'id: "spoof"\ntype: "Decision"',
  "source snapshot: 2099-12-31T23:59:59.000Z",
  '  - "array item look-alike"',
];

// JSON-representable numbers only (no NaN/Infinity/-0 — see header).
const NUMBERS: readonly number[] = [
  0, 1, -1, 42, 0.5, -3.25, 1e21, 1e-7, 9007199254740991, 3.141592653589793,
];

// generated_at is system-managed (always an ISO stamp, single \S+ token).
const STAMPS: readonly string[] = [
  "2026-01-02T03:04:05.678Z",
  "2026-01-02T03:04:05+09:00",
  "1970-01-01T00:00:00.000Z",
  "2026-12-31T23:59:59.999Z",
];

// Titles crafted to collide as filenames: identical, case-variant, and
// NFC-vs-NFD variants (APFS treats all of these as the same file name).
const COLLIDING_TITLES: readonly string[] = [
  "Collide Me",
  "collide me",
  "COLLIDE ME",
  "Café Décision", // NFC
  "Café Décision", // NFD
];

const ID_FLAVORS: readonly string[] = [
  "plain",
  "with space",
  "path/to/deep/file.ts",
  "日本語ノード",
  "v1.2...dots",
  "UPPER-Case",
  "café-nfc",
  "café-nfd",
  "trailing-space ",
  "multi:colon:seg",
  "long-" + "x".repeat(64),
];

const EXTRA_KEYS: readonly string[] = ["note", "category", "owner", "meta_field", "priority"];

let uid = 0;

function nextId(r: Rand, type: string | undefined): string {
  return `${(type ?? "untyped").toLowerCase()}:fuzz:${r.pick(ID_FLAVORS)}:${uid++}`;
}

function hostile(r: Rand): string {
  let s = r.pick(HOSTILE_STRINGS);
  const extra = r.int(3);
  for (let i = 0; i < extra; i++) {
    s += r.pick(["", " ", "\n", " — "]) + r.pick(HOSTILE_STRINGS);
  }
  return s;
}

function makeAliases(r: Rand): unknown[] {
  const n = r.int(5); // 0 → empty array
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const roll = r.float();
    if (roll < 0.15 && out.length > 0) out.push(out[0]); // duplicate-ish
    else if (roll < 0.25) out.push(r.pick(NUMBERS));
    else if (roll < 0.3) out.push(null);
    else out.push(hostile(r));
  }
  return out;
}

function makeDisplay(r: Rand): Rec {
  const ja: Rec = {};
  if (r.bool(0.8)) ja.short_label = hostile(r);
  if (r.bool(0.4)) ja.title = hostile(r);
  if (r.bool(0.3)) ja.aliases = makeAliases(r);
  const display: Rec = r.bool(0.9) ? { ja } : { ja, en: {} };
  return display;
}

function makeNode(r: Rand, type: string | undefined, schema: SchemaDefinition): Rec {
  const node: Rec = { id: nextId(r, type) };
  if (type !== undefined) node.type = type;

  const titleRoll = r.float();
  if (titleRoll < 0.15) node.title = r.pick(COLLIDING_TITLES);
  else if (titleRoll < 0.9) node.title = hostile(r);
  // else: no title (label falls back through display/id)

  if (r.bool(0.6)) node.summary = hostile(r);

  const dRoll = r.float();
  if (dRoll < 0.45) node.description = hostile(r);
  else if (dRoll < 0.5) node.description = null;
  else if (dRoll < 0.54) node.description = r.pick(["", " ", "\n", "  \r\n  ", "\t"]);

  const rcRoll = r.float();
  if (rcRoll < 0.35) node.raw_content = hostile(r);
  else if (rcRoll < 0.38) node.raw_content = null;
  else if (rcRoll < 0.41) node.raw_content = r.pick(["", "   ", "\r\n"]);
  if (r.bool(0.15)) node.raw_content_status = r.bool(0.5) ? "source" : hostile(r);

  if (r.bool(0.4)) node.aliases = makeAliases(r);
  if (r.bool(0.3)) node.path = r.pick(["src/a b/日本語 ファイル.ts", "deep/very deep/path.md", hostile(r)]);
  if (r.bool(0.3)) node.display = makeDisplay(r);
  if (r.bool(0.3)) node.confidence = r.bool() ? r.pick(NUMBERS) : String(r.pick(NUMBERS));
  if (r.bool(0.15)) node.scopes = [`system:fuzz:scope-${uid++}`];

  const vocab = type ? schema.stateVocabulary[type] : undefined;
  if (vocab && vocab.length > 0 && r.bool(0.5)) node.state = r.pick(vocab);
  else if (r.bool(0.05)) node.state = null; // null state is legal for any type

  if (r.bool(0.2)) {
    node[r.pick(EXTRA_KEYS)] = r.pick([
      null,
      true,
      false,
      r.pick(NUMBERS),
      hostile(r),
    ] as const);
  }
  if (r.bool(0.1)) node.ghost_field = undefined; // "absent" — must not resurrect as null

  if (r.bool(0.85)) node.generated_at = r.pick(STAMPS);
  return node;
}

// Expand the schema's edge rules into every concrete (edgeType, from, to)
// type triple — driven from the schema definition itself so future node/edge
// types are automatically covered.
function allEdgeTriples(schema: SchemaDefinition): [string, string, string][] {
  const asArray = (x: unknown): string[] => (Array.isArray(x) ? x : [x as string]);
  const triples: [string, string, string][] = [];
  for (const [etype, rules] of Object.entries(schema.edgeTypeRules)) {
    for (const [fromAllowed, toAllowed] of rules) {
      for (const f of asArray(fromAllowed)) {
        for (const t of asArray(toAllowed)) triples.push([etype, f, t]);
      }
    }
  }
  return triples;
}

function makeEdge(
  r: Rand,
  etype: string,
  from: string,
  to: string
): Rec {
  const edge: Rec = { id: `edge:fuzz:${etype}:${uid++}`, type: etype, from, to };
  if (r.bool(0.55)) edge.summary = hostile(r);
  if (r.bool(0.25)) edge.updated_at = r.pick(STAMPS);
  if (r.bool(0.2)) edge.weight = r.pick(NUMBERS);
  if (r.bool(0.12)) edge.flag = r.bool();
  if (r.bool(0.1)) edge.note = null;
  if (r.bool(0.06)) edge.ghost = undefined; // "absent"
  return edge;
}

function genGraph(seed: number): { generated_at: string; nodes: Rec[]; edges: Rec[] } {
  const r = new Rand(seed);
  const schema = DEFAULT_SCHEMA;
  const nNodes = 5 + r.int(36); // 5..40
  const nodes: Rec[] = [];
  for (let i = 0; i < nNodes; i++) {
    const type = r.bool(0.04) ? undefined : r.pick(schema.nodeTypes);
    nodes.push(makeNode(r, type, schema));
  }
  const byType = new Map<string, Rec[]>();
  for (const n of nodes) {
    const t = String(n.type ?? "");
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(n);
  }
  const triples = allEdgeTriples(schema);
  const edges: Rec[] = [];
  const attempts = nNodes + r.int(nNodes * 2);
  for (let i = 0; i < attempts; i++) {
    const [etype, ft, tt] = r.pick(triples);
    const froms = byType.get(ft);
    if (!froms || froms.length === 0) continue;
    const from = String(r.pick(froms).id);
    let to: string;
    if (r.bool(0.06)) {
      to = `vault:other:${etype}-${uid++}`; // cross-vault ref (legal dangling `to`)
    } else {
      const tos = byType.get(tt);
      if (!tos || tos.length === 0) continue;
      to = String(r.pick(tos).id); // may self-loop when ft === tt
    }
    edges.push(makeEdge(r, etype, from, to));
  }
  return { generated_at: r.pick(STAMPS), nodes, edges };
}

// ---- normalization + assertions ----------------------------------------------

// The equivalence the existing round-trip gate asserts: undefined fields are
// "absent", and generated_at inherits the graph-level stamp via the banner.
function normalizeGraph(g: { generated_at?: string; nodes: Rec[]; edges: Rec[] }): {
  nodes: Rec[];
  edges: Rec[];
} {
  const stripUndef = (o: Rec): Rec => {
    const out: Rec = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
    return out;
  };
  return {
    nodes: g.nodes.map((n) => {
      const out = stripUndef(n);
      if (out.generated_at === undefined) out.generated_at = g.generated_at;
      return out;
    }),
    edges: g.edges.map(stripUndef),
  };
}

function diffFields(src: Rec, got: Rec): string[] {
  const keys = new Set([...Object.keys(src), ...Object.keys(got)]);
  const diffs: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(src[k]) !== JSON.stringify(got[k])) {
      diffs.push(
        `  field ${JSON.stringify(k)}:\n    in:  ${JSON.stringify(src[k])}\n    out: ${JSON.stringify(got[k])}`
      );
    }
  }
  return diffs;
}

function assertGraphsEqual(
  expected: { nodes: Rec[]; edges: Rec[] },
  actual: { nodes: Rec[]; edges: Rec[] },
  label: string
): void {
  const eN = new Map(expected.nodes.map((n) => [String(n.id), n]));
  const aN = new Map(actual.nodes.map((n) => [String(n.id), n]));
  const missingN = [...eN.keys()].filter((k) => !aN.has(k));
  const extraN = [...aN.keys()].filter((k) => !eN.has(k));
  assert.equal(
    aN.size,
    eN.size,
    `${label}: node count ${eN.size} -> ${aN.size}` +
      (missingN.length ? ` (lost: ${missingN.slice(0, 5).join(", ")})` : "") +
      (extraN.length ? ` (phantom: ${extraN.slice(0, 5).join(", ")})` : "")
  );
  for (const [id, src] of eN) {
    const got = aN.get(id);
    assert.ok(got, `${label}: node ${id} lost through round-trip`);
    const diffs = diffFields(src, got!);
    assert.equal(
      diffs.length,
      0,
      `${label}: node ${id} corrupted through round-trip:\n${diffs.join("\n")}`
    );
  }
  const eE = new Map(expected.edges.map((e) => [String(e.id), e]));
  const aE = new Map(actual.edges.map((e) => [String(e.id), e]));
  const missingE = [...eE.keys()].filter((k) => !aE.has(k));
  assert.equal(
    aE.size,
    eE.size,
    `${label}: edge count ${eE.size} -> ${aE.size}` +
      (missingE.length ? ` (lost: ${missingE.slice(0, 5).join(", ")})` : "")
  );
  for (const [id, src] of eE) {
    const got = aE.get(id);
    assert.ok(got, `${label}: edge ${id} lost through round-trip`);
    const diffs = diffFields(src, got!);
    assert.equal(
      diffs.length,
      0,
      `${label}: edge ${id} corrupted through round-trip:\n${diffs.join("\n")}`
    );
  }
}

function assertStableSerialization(
  files1: { relPath: string; content: string }[],
  files2: { relPath: string; content: string }[],
  label: string
): void {
  const m1 = new Map(files1.map((f) => [f.relPath, f.content]));
  const m2 = new Map(files2.map((f) => [f.relPath, f.content]));
  const missing = [...m1.keys()].filter((k) => !m2.has(k));
  const extra = [...m2.keys()].filter((k) => !m1.has(k));
  assert.equal(
    m2.size,
    m1.size,
    `${label}: rebuild changed the file set` +
      (missing.length ? ` (gone: ${missing.slice(0, 5).join(", ")})` : "") +
      (extra.length ? ` (new: ${extra.slice(0, 5).join(", ")})` : "")
  );
  for (const [rel, c1] of m1) {
    const c2 = m2.get(rel);
    assert.ok(c2 !== undefined, `${label}: ${rel} disappeared on rebuild`);
    if (c1 !== c2) {
      const l1 = c1.split("\n");
      const l2 = (c2 as string).split("\n");
      let i = 0;
      while (i < l1.length && i < l2.length && l1[i] === l2[i]) i++;
      assert.fail(
        `${label}: unstable serialization in ${rel} at line ${i + 1}:\n` +
          `  pass1: ${JSON.stringify(l1[i])}\n  pass2: ${JSON.stringify(l2[i])}`
      );
    }
  }
}

function writeVault(dir: string, files: { relPath: string; content: string }[]): void {
  rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const abs = path.join(dir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
}

// The full property for one graph: valid premise → disk round-trip equivalence
// → serialization stability (build ∘ import ∘ build byte-identical).
function assertRoundTrip(
  graph: { generated_at: string; nodes: Rec[]; edges: Rec[] },
  dir: string,
  label: string
): void {
  const premise = validateGraph(graph as any);
  assert.deepEqual(premise, [], `${label}: generator premise broken — graph is schema-invalid`);
  const files = buildVaultFiles(graph);
  writeVault(dir, files);
  const imported = importVault(dir);
  assertGraphsEqual(normalizeGraph(graph), imported as any, label);
  const files2 = buildVaultFiles(imported);
  assertStableSerialization(files, files2, label);
}

// ---- tests --------------------------------------------------------------------

test("fuzz coverage: every node type, every schema-allowed edge pair, every state value round-trips", () => {
  const schema = DEFAULT_SCHEMA;
  const r = new Rand(0xa11ce);
  const nodes: Rec[] = [];
  const pool = new Map<string, string[]>();
  for (const t of schema.nodeTypes) {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const n = makeNode(r, t, schema);
      delete n.state; // states are added exhaustively below
      nodes.push(n);
      ids.push(String(n.id));
    }
    pool.set(t, ids);
  }
  for (const [t, vocab] of Object.entries(schema.stateVocabulary)) {
    for (const s of vocab ?? []) {
      const n = makeNode(r, t, schema);
      n.state = s;
      nodes.push(n);
      pool.get(t)!.push(String(n.id));
    }
  }
  const triples = allEdgeTriples(schema);
  assert.ok(triples.length > 0, "schema must define edge rules");
  const edges: Rec[] = [];
  let selfLooped = false;
  for (const [etype, ft, tt] of triples) {
    edges.push(makeEdge(r, etype, pool.get(ft)![0], pool.get(tt)![1]));
    if (!selfLooped && ft === tt) {
      edges.push(makeEdge(r, etype, pool.get(ft)![0], pool.get(ft)![0]));
      selfLooped = true;
    }
  }
  // One cross-vault (dangling `to`) edge per edge type reachable from the rules.
  for (const etype of schema.edgeTypes) {
    const rule = triples.find(([e]) => e === etype);
    if (!rule) continue;
    edges.push(makeEdge(r, etype, pool.get(rule[1])![0], `vault:other:xref-${uid++}`));
  }
  const graph = { generated_at: STAMPS[0], nodes, edges };
  const dir = mkdtempSync(path.join(tmpdir(), "graphrag-fuzz-cov-"));
  try {
    assertRoundTrip(graph, path.join(dir, "g"), `coverage(seed=${r.seed})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fuzz corpus: every adversarial string survives in every string field", () => {
  const nodes: Rec[] = [];
  const edges: Rec[] = [];
  HOSTILE_STRINGS.forEach((s, i) => {
    nodes.push({
      id: `decision:corpus:${i}`,
      type: "Decision",
      title: s,
      summary: s,
      description: s,
      raw_content: s,
      raw_content_status: s,
      aliases: [s, s],
      path: s,
      note: s,
      display: { ja: { short_label: s } },
      generated_at: STAMPS[i % STAMPS.length],
    });
  });
  for (let i = 0; i + 1 < nodes.length; i++) {
    edges.push({
      id: `edge:corpus:${i}`,
      type: "refines",
      from: nodes[i].id,
      to: nodes[i + 1].id,
      summary: HOSTILE_STRINGS[i],
    });
  }
  const graph = { generated_at: STAMPS[0], nodes, edges };
  const dir = mkdtempSync(path.join(tmpdir(), "graphrag-fuzz-corpus-"));
  try {
    assertRoundTrip(graph, path.join(dir, "g"), "corpus");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fuzz: colliding filenames (identical / case-variant / NFC-NFD titles) lose no node on a real filesystem", () => {
  const titles = [...COLLIDING_TITLES, COLLIDING_TITLES[0]]; // + exact duplicate
  const nodes: Rec[] = titles.map((t, i) => ({
    id: `decision:collide:${i}`,
    type: "Decision",
    title: t,
    summary: `node ${i}`,
    generated_at: STAMPS[0],
  }));
  const graph = { generated_at: STAMPS[0], nodes, edges: [] as Rec[] };
  const dir = mkdtempSync(path.join(tmpdir(), "graphrag-fuzz-collide-"));
  try {
    // Assert distinctness at the filesystem's granularity, not just string
    // inequality: APFS/NTFS-equivalent names must not overwrite each other.
    const files = buildVaultFiles(graph);
    const fsKeys = new Set(files.map((f) => f.relPath.normalize("NFC").toLowerCase()));
    assert.equal(
      fsKeys.size,
      nodes.length,
      `filenames must stay distinct under case/normalization folding: ${files
        .map((f) => f.relPath)
        .join(", ")}`
    );
    assertRoundTrip(graph, path.join(dir, "g"), "collide");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy vault bytes: `- |-` block scalars in arrays and edge records import intact", () => {
  // Vault files written by builds BEFORE the inline-only edge emission carried
  // multi-line aliases and edge values as `- |-` / `key: |-` block scalars.
  // The old parser returned the literal string "|-" and leaked the content
  // lines into the enclosing mapping; these bytes must now parse losslessly
  // (on-disk backward compatibility of the vault format).
  const legacy = [
    "---",
    'id: "decision:legacy:1"',
    'type: "Decision"',
    'title: "T"',
    "aliases:",
    "  - |-",
    "    line one",
    "    line two",
    '  - "plain"',
    "graph_edges:",
    '  - id: "e:legacy:1"',
    '    type: "refines"',
    '    from: "decision:legacy:1"',
    '    to: "decision:legacy:2"',
    "    summary: |-",
    "      multi",
    "      line",
    "links: {}",
    "---",
    "",
    "> 生成物 — 直接編集しない。正本は vault (この markdown 自身)。source snapshot: 2026-01-01T00:00:00.000Z",
    "",
    "# T",
    "",
  ].join("\n");
  const { node, edges } = importVaultFile(legacy);
  assert.deepEqual(node, {
    id: "decision:legacy:1",
    type: "Decision",
    title: "T",
    aliases: ["line one\nline two", "plain"],
    generated_at: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(edges, [
    {
      id: "e:legacy:1",
      type: "refines",
      from: "decision:legacy:1",
      to: "decision:legacy:2",
      summary: "multi\nline",
    },
  ]);
});

const ITERATIONS = Number(process.env.GRAPHRAG_FUZZ_ITERATIONS ?? 400);
const BASE_SEED = Number(process.env.GRAPHRAG_FUZZ_SEED ?? 0xc0ffee);

test(`fuzz property: ${ITERATIONS} seeded random schema-valid graphs round-trip bit-exact (base seed ${BASE_SEED})`, () => {
  const root = mkdtempSync(path.join(tmpdir(), "graphrag-fuzz-"));
  try {
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = BASE_SEED + i;
      const graph = genGraph(seed);
      assertRoundTrip(
        graph,
        path.join(root, "g"), // reused per iteration (writeVault clears it)
        `seed=${seed} (rerun: GRAPHRAG_FUZZ_SEED=${seed} GRAPHRAG_FUZZ_ITERATIONS=1)`
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { resolveSchema, registerPreset, getPreset, listPresets } from "./schema-registry.ts";
import { DEFAULT_SCHEMA, validateGraph, type SchemaDefinition } from "./schema.ts";

const FAKE_PRESET: SchemaDefinition = {
  id: "test-preset",
  nodeTypes: ["File", "TestNode"],
  edgeTypes: ["test_edge"],
  edgeTypeRules: { test_edge: [[["TestNode"], "File"]] },
  stateVocabulary: {},
  requiredFields: {},
  aliases: {},
  categories: {
    knowledge: ["TestNode"],
    crosscut: [],
    distilled: [],
    duplicateCheck: ["TestNode"],
    staleness: [],
    premiseCandidate: [],
    relation: [],
  },
  llmReference: "test schema"
};

describe("schema-registry", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "schema-reg-"));
    registerPreset(FAKE_PRESET);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("listPresets includes system and registered presets", () => {
    const ids = listPresets();
    assert.ok(ids.includes("system"));
    assert.ok(ids.includes("test-preset"));
  });

  it("getPreset returns registered preset", () => {
    assert.strictEqual(getPreset("system"), DEFAULT_SCHEMA);
    assert.strictEqual(getPreset("test-preset"), FAKE_PRESET);
    assert.strictEqual(getPreset("nonexistent"), undefined);
  });

  it("resolveSchema returns DEFAULT_SCHEMA when no VAULT.md", () => {
    const vaultDir = path.join(tmpDir, "no-profile", "vault");
    mkdirSync(vaultDir, { recursive: true });
    assert.strictEqual(resolveSchema(vaultDir), DEFAULT_SCHEMA);
  });

  it("resolveSchema returns DEFAULT_SCHEMA when VAULT.md has no schema field", () => {
    const base = path.join(tmpDir, "no-schema");
    const vaultDir = path.join(base, "vault");
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(path.join(base, "VAULT.md"), "---\nname: test\nkind: system\n---\nsome description\n");
    assert.strictEqual(resolveSchema(vaultDir), DEFAULT_SCHEMA);
  });

  it("resolveSchema returns matching preset when schema field is set", () => {
    const base = path.join(tmpDir, "with-schema");
    const vaultDir = path.join(base, "vault");
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(path.join(base, "VAULT.md"), "---\nname: test\nkind: project\nschema: test-preset\n---\nsome description\n");
    assert.strictEqual(resolveSchema(vaultDir), FAKE_PRESET);
  });

  it("resolveSchema throws on unknown preset", () => {
    const base = path.join(tmpDir, "bad-schema");
    const vaultDir = path.join(base, "vault");
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(path.join(base, "VAULT.md"), "---\nname: test\nschema: nonexistent-preset\n---\n");
    assert.throws(() => resolveSchema(vaultDir), /no preset with that id exists/);
  });

  it("resolveSchema handles quoted schema values", () => {
    const base = path.join(tmpDir, "quoted");
    const vaultDir = path.join(base, "vault");
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(path.join(base, "VAULT.md"), '---\nname: test\nschema: "test-preset"\n---\n');
    assert.strictEqual(resolveSchema(vaultDir), FAKE_PRESET);
  });

  it("validateGraph works with custom schema", () => {
    const graph = {
      nodes: [
        { id: "testnode:x:a", type: "TestNode" },
        { id: "file:x:b", type: "File" }
      ],
      edges: [
        { id: "e1", type: "test_edge", from: "testnode:x:a", to: "file:x:b" }
      ]
    };
    const failures = validateGraph(graph, FAKE_PRESET);
    assert.deepStrictEqual(failures, []);
  });

  it("validateGraph rejects types not in custom schema", () => {
    const graph = {
      nodes: [{ id: "decision:x:a", type: "Decision" }],
      edges: []
    };
    const failures = validateGraph(graph, FAKE_PRESET);
    assert.ok(failures.some(f => f.includes("unknown node type")));
  });
});

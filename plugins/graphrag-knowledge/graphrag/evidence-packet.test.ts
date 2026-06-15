import assert from "node:assert/strict";
import test from "node:test";
import { collectReferencedIds, parseArgs } from "./evidence-packet.ts";

test("evidence parseArgs reads --vault / GRAPHRAG_VAULT_DIR", () => {
  assert.equal(parseArgs(["--request", "r", "--vault", "/v"]).vault, "/v");
  const prev = process.env.GRAPHRAG_VAULT_DIR;
  process.env.GRAPHRAG_VAULT_DIR = "/env/v";
  try {
    assert.equal(parseArgs(["--request", "r"]).vault, "/env/v");
  } finally {
    if (prev === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = prev;
  }
});

test("collectReferencedIds dedups match nodes + neighbor endpoints", () => {
  const matches = [{ node: { id: "decision:s:a" } }, { node: { id: "goal:s:b" } }];
  const neighborEdges = [
    { from: { id: "decision:s:a" }, to: { id: "risk:s:c" } },
    { from: { id: "goal:s:b" }, to: { id: "goal:s:b" } }
  ];
  assert.deepEqual(collectReferencedIds(matches, neighborEdges).sort(), ["decision:s:a", "goal:s:b", "risk:s:c"]);
});

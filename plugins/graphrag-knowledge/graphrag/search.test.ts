import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./search.ts";

test("search parseArgs reads --vault / GRAPHRAG_VAULT_DIR", () => {
  assert.equal(parseArgs(["--query", "q", "--vault", "/v"]).vault, "/v");
  const prev = process.env.GRAPHRAG_VAULT_DIR;
  process.env.GRAPHRAG_VAULT_DIR = "/env/v";
  try {
    assert.equal(parseArgs(["--query", "q"]).vault, "/env/v");
  } finally {
    if (prev === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = prev;
  }
});

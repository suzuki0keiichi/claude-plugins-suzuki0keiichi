import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./branch-merge.ts";

test("branch-merge parseArgs reads --vault / --branch and defaults --main to main", () => {
  const a = parseArgs(["--vault", "/v", "--branch", "kb/x"]);
  assert.equal(a.vault, "/v");
  assert.equal(a.branch, "kb/x");
  assert.equal(a.main, "main");
  assert.equal(a.vector, undefined);
});

test("branch-merge parseArgs honors an explicit --main and --vector", () => {
  const a = parseArgs(["--vault", "/v", "--branch", "kb/y", "--main", "trunk", "--vector", "/idx.json"]);
  assert.equal(a.main, "trunk");
  assert.equal(a.vector, "/idx.json");
});

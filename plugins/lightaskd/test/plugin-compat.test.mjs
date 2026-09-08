import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");

const readJson = (...segments) => JSON.parse(readFileSync(path.join(...segments), "utf8"));

test("Claude Code and Codex manifests share one plugin identity and skill tree", () => {
  const claude = readJson(pluginRoot, ".claude-plugin", "plugin.json");
  const codex = readJson(pluginRoot, ".codex-plugin", "plugin.json");

  assert.equal(claude.name, "lightaskd");
  assert.equal(codex.name, claude.name);
  assert.equal(codex.version, claude.version);
  assert.equal(codex.skills, "./skills/");
  assert.equal(codex.interface.displayName, "lightaskd");
  assert.equal(claude.hooks, undefined, "lightaskd must not install hooks: it is explicit-invocation only");
  assert.equal(codex.hooks, undefined);
});

test("both marketplaces list lightaskd with a local source", () => {
  const claudeMarketplace = readJson(repoRoot, ".claude-plugin", "marketplace.json");
  const claudeEntry = claudeMarketplace.plugins.find((plugin) => plugin.name === "lightaskd");
  assert.ok(claudeEntry, "Claude marketplace must list lightaskd");
  assert.equal(claudeEntry.source, "./plugins/lightaskd");

  const codexMarketplace = readJson(repoRoot, ".agents", "plugins", "marketplace.json");
  const codexEntry = codexMarketplace.plugins.find((plugin) => plugin.name === "lightaskd");
  assert.ok(codexEntry, "Codex marketplace must list lightaskd");
  assert.deepEqual(codexEntry.source, { source: "local", path: "./plugins/lightaskd" });
  assert.deepEqual(codexEntry.policy, { installation: "AVAILABLE", authentication: "ON_INSTALL" });
});

test("the skill stays explicit-invocation only on both providers", () => {
  const skill = readFileSync(path.join(pluginRoot, "skills", "lightaskd", "SKILL.md"), "utf8");
  const frontmatter = skill.split("---")[1];
  assert.match(frontmatter, /^name: lightaskd$/m);
  assert.match(frontmatter, /^disable-model-invocation: true$/m);

  const openai = readFileSync(path.join(pluginRoot, "skills", "lightaskd", "agents", "openai.yaml"), "utf8");
  assert.match(openai, /allow_implicit_invocation:\s*false/);
});

test("the skill resolves the CLI from the plugin root, not from the working directory", () => {
  const skill = readFileSync(path.join(pluginRoot, "skills", "lightaskd", "SKILL.md"), "utf8");
  assert.match(skill, /CLAUDE_PLUGIN_ROOT/);
  assert.match(skill, /bin\/lightaskd\.mjs/);
});

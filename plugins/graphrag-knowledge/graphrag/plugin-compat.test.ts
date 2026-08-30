import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Claude Code and Codex manifests share one plugin identity and skill tree", () => {
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  const codex = JSON.parse(readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));

  assert.equal(codex.name, claude.name);
  assert.equal(codex.version, claude.version);
  assert.equal(codex.skills, "./skills/");
  assert.equal(codex.hooks, undefined);
});

test("Claude hooks stay explicit and Codex has no default hook path to discover", () => {
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));

  assert.equal(claude.hooks, "./claude-hooks/hooks.json");
  assert.equal(existsSync(path.join(pluginRoot, "claude-hooks", "hooks.json")), true);
  assert.equal(existsSync(path.join(pluginRoot, "hooks", "hooks.json")), false);
});

test("shared skills do not depend on the Claude-only CLI path", () => {
  const skillsDir = path.join(pluginRoot, "skills");
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skill = readFileSync(path.join(skillsDir, entry.name, "SKILL.md"), "utf8");
    assert.doesNotMatch(
      skill,
      /\$\{CLAUDE_PLUGIN_ROOT\}\/graphrag\/cli\.ts/,
      `${entry.name} must use the shared launcher`
    );
  }
});

test("provider-neutral launcher forwards CLI arguments", () => {
  const launcher = path.join(pluginRoot, "bin", "graphrag.mjs");
  const result = spawnSync(process.execPath, [launcher, "--help"], {
    cwd: pluginRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /headline verbs/);
  assert.match(result.stderr, /inspect/);
  assert.match(result.stderr, /fsck/);
});

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(absolute);
  }
  return out;
}

function hookCommands(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(hookCommands);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "command" && typeof child === "string" ? [child] : hookCommands(child)
  );
}

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
  const hooksPath = path.join(pluginRoot, "claude-hooks", "hooks.json");

  assert.equal(claude.hooks, "./claude-hooks/hooks.json");
  assert.equal(existsSync(hooksPath), true);
  assert.equal(existsSync(path.join(pluginRoot, "hooks", "hooks.json")), false);

  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  for (const command of hookCommands(hooks)) {
    const match = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+\.mjs)/);
    assert.ok(match, `hook command must use a plugin-root-relative .mjs path: ${command}`);
    assert.equal(existsSync(path.join(pluginRoot, match[1])), true, `hook target must exist: ${match[1]}`);
  }
});

test("shared skills and references use the provider-neutral launcher", () => {
  const docs = [
    ...markdownFiles(path.join(pluginRoot, "skills")),
    ...markdownFiles(path.join(pluginRoot, "references"))
  ];
  for (const file of docs) {
    const contents = readFileSync(file, "utf8");
    assert.doesNotMatch(
      contents,
      /(?:\$\{?CLAUDE_PLUGIN_ROOT\}?|<PLUGIN_ROOT>)\/graphrag\/cli\.ts|node(?:\s+--experimental-strip-types)?\s+graphrag\/cli\.ts/,
      `${path.relative(pluginRoot, file)} must use the shared launcher`
    );
  }
});

test("provider-neutral launcher forwards CLI arguments", () => {
  const launcher = path.join(pluginRoot, "bin", "graphrag.mjs");
  const result = spawnSync(process.execPath, [launcher, "--help"], {
    cwd: pluginRoot,
    encoding: "utf8"
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /headline verbs/);
  assert.match(result.stderr, /inspect/);
  assert.match(result.stderr, /fsck/);
});

test("provider-neutral launcher preserves CLI failures", () => {
  const launcher = path.join(pluginRoot, "bin", "graphrag.mjs");
  const result = spawnSync(process.execPath, [launcher, "definitely-not-a-verb"], {
    cwd: pluginRoot,
    encoding: "utf8"
  });

  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown verb: definitely-not-a-verb/);
});

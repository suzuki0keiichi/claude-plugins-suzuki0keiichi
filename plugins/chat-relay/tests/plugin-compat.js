#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');

const claude = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
const codex = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));

assert.equal(codex.name, claude.name);
assert.equal(codex.version, claude.version);
assert.equal(codex.skills, './skills/');
assert.equal(codex.interface.displayName, 'Chat Relay');

const marketplace = JSON.parse(
  fs.readFileSync(path.join(repoRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8')
);
const entry = marketplace.plugins.find((plugin) => plugin.name === 'chat-relay');
assert.ok(entry, 'Codex marketplace must list chat-relay');
assert.deepEqual(entry.source, { source: 'local', path: './plugins/chat-relay' });
assert.deepEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });

for (const relative of [
  'README.md',
  'docs/design.md',
  'skills/chat-relay/SKILL.md',
  'skills/chat-relay/HELP.md',
]) {
  const contents = fs.readFileSync(path.join(pluginRoot, relative), 'utf8');
  assert.doesNotMatch(
    contents,
    /node\s+"\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/cchat"/,
    `${relative} must use the provider-neutral launcher instructions`
  );
}

const cliSource = fs.readFileSync(path.join(pluginRoot, 'bin', 'cchat'), 'utf8');
assert.match(cliSource, /process\.env\.CODEX_THREAD_ID/);
assert.match(cliSource, /process\.env\.CODEX_SESSION_ID/);
assert.match(cliSource, /Claude Code and Codex sessions/);

process.stdout.write('chat-relay plugin compatibility checks passed\n');

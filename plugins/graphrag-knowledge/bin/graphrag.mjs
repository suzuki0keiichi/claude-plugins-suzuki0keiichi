#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../graphrag/cli.ts", import.meta.url));
const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", cliPath, ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env }
);

if (result.error) {
  process.stderr.write(`[graphrag] launcher failed: ${result.error.message}\n`);
  process.exitCode = 1;
} else if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exitCode = result.status ?? 1;
}

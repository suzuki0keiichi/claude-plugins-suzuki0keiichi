#!/usr/bin/env node
import { reportError, runCli } from "../src/cli.mjs";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  process.exitCode = reportError(error);
}

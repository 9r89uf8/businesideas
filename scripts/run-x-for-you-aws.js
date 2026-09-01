#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAwsCollectorCommand } from "../src/lib/x/for-you/aws-runner.js";
import { parseCollectorArguments } from "../src/lib/x/for-you/command.js";
import { createStructuredLogger } from "../src/lib/x/for-you/logging.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

let mode;
try {
  mode = parseCollectorArguments(process.argv.slice(2));
} catch {
  process.stderr.write(
    "Usage: npm run x:for-you:aws:collect | npm run x:for-you:aws:check\n",
  );
  process.exitCode = 2;
}

if (mode === "help") {
  process.stdout.write(
    "Usage: npm run x:for-you:aws:collect | npm run x:for-you:aws:check\n",
  );
} else if (mode) {
  const result = await runAwsCollectorCommand({
    mode,
    env: process.env,
    repositoryRoot,
    log: createStructuredLogger(),
  });
  if (result.errorCode === "BROWSER_CLOSE_FAILED") {
    setImmediate(() => process.exit(result.exitCode));
  } else {
    process.exitCode = result.exitCode;
  }
}

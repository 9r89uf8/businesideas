#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  executeCollectorCommand,
  parseCollectorArguments,
} from "../src/lib/x/for-you/command.js";
import { createStructuredLogger } from "../src/lib/x/for-you/logging.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Existing process variables win. Loading .env.local first gives it normal
// local-development precedence without ever echoing a parsed value.
for (const fileName of [".env.local", ".env"]) {
  const filePath = path.join(repositoryRoot, fileName);
  if (existsSync(filePath)) process.loadEnvFile(filePath);
}

let mode;
try {
  mode = parseCollectorArguments(process.argv.slice(2));
} catch {
  process.stderr.write("Usage: npm run x:for-you:collect | npm run x:for-you:check\n");
  process.exitCode = 2;
}

if (mode === "help") {
  process.stdout.write("Usage: npm run x:for-you:collect | npm run x:for-you:check\n");
} else if (mode) {
  const result = await executeCollectorCommand({
    mode,
    env: process.env,
    repositoryRoot,
    log: createStructuredLogger(),
  });
  if (result.errorCode === "BROWSER_CLOSE_FAILED") {
    // A stuck transport can keep child-process handles alive even after the
    // bounded shutdown attempt. Output and metadata cleanup have completed at
    // this point, and command.js has deliberately retained the profile lock.
    setImmediate(() => process.exit(result.exitCode));
  } else {
    process.exitCode = result.exitCode;
  }
}

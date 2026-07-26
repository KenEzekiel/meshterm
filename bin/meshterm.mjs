#!/usr/bin/env bun
import { runCli } from "../packages/cli/index.ts";

try {
  await runCli();
} catch (error) {
  console.error(error instanceof Error ? error.message : "command failed");
  process.exit(1);
}

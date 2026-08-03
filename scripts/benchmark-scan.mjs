#!/usr/bin/env node

import {
  BENCHMARK_USAGE,
  parseBenchmarkArgs,
  runScanBenchmark
} from "./benchmark-scan-lib.mjs";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(BENCHMARK_USAGE);
    return;
  }
  const result = await runScanBenchmark(parseBenchmarkArgs(args));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

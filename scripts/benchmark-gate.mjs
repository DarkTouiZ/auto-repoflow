#!/usr/bin/env node

// Accuracy regression gate for the external MileMesh known-gap benchmark.
//
// The MileMesh ledger lives in a separate checkout (github.com/DarkTouiZ/
// milemesh-mock) and is not part of this repository, so this gate cannot run in
// CI without an explicit --target. When --target is omitted it SKIPs loudly
// (exit 0) so it can sit inside `npm run check` without breaking the build.
//
// When a target is supplied it runs the standard rules-only benchmark and fails
// unless precision === 100, recall === 100, and detected === EXPECTED_FINDINGS.
// On mismatch it prints the added/removed finding-ID lists so each delta can be
// classified as a new true positive (add to ledger) or a regression (fix code).
//
// Usage:
//   node scripts/benchmark-gate.mjs \
//     --target /path/to/milemesh-mock \
//     --ledger /path/to/milemesh-mock/benchmark/expected-findings.json \
//     [--label milemesh] [--runs 3]

import { resolve } from "node:path";
import { runScanBenchmark } from "./benchmark-scan-lib.mjs";

const EXPECTED_FINDINGS = 22;

function parseFlags(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, "true");
    }
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  if (!flags.has("target")) {
    console.log(
      "SKIP benchmark-gate: no --target supplied (external MileMesh checkout not present)."
    );
    console.log(
      "      Run locally with: node scripts/benchmark-gate.mjs --target <milemesh-mock> --ledger <ledger>"
    );
    return;
  }

  if (!flags.has("ledger")) {
    throw new Error("--ledger is required when --target is supplied");
  }

  const target = resolve(flags.get("target"));
  const ledgerPath = resolve(flags.get("ledger"));
  const label = flags.get("label") ?? "milemesh";
  const runs = Number(flags.get("runs") ?? "3");

  const result = await runScanBenchmark({
    sourcePath: target,
    label,
    runs,
    cliPath: resolve("apps/cli/dist/main.js"),
    ledgerPath
  });

  const score = result.knownGapScore;
  if (!score) {
    throw new Error("Benchmark produced no known-gap score; is the ledger valid?");
  }

  console.log(
    `benchmark-gate: detected=${score.detected} expected=${score.expected} ` +
      `precision=${score.precision}% recall=${score.recall}%`
  );

  const ok =
    score.precision === 100 &&
    score.recall === 100 &&
    score.detected === EXPECTED_FINDINGS;

  if (ok) {
    console.log(
      `PASS benchmark-gate: ${EXPECTED_FINDINGS}/${EXPECTED_FINDINGS} at 100% precision/recall.`
    );
    return;
  }

  console.error("FAIL benchmark-gate: accuracy regression against MileMesh ledger.");
  console.error(
    `  truePositive=${score.truePositive} falsePositive=${score.falsePositive} ` +
      `falseNegative=${score.falseNegative}`
  );
  console.error("  findings by rule:");
  for (const [ruleId, count] of Object.entries(result.findings.byRule).sort()) {
    console.error(`    ${ruleId}: ${count}`);
  }
  console.error(
    "  For the exact added/removed finding-ID delta, re-run:\n" +
      `    node scripts/benchmark-scan.mjs ${target} --label ${label} --ledger ${ledgerPath}`
  );
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

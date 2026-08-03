import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const supportedFlags = new Set(["label", "ledger", "runs", "cli"]);

export const BENCHMARK_USAGE = `Usage:
  npm run benchmark:scan -- <repository> --label <public-label> [options]

Options:
  --label <label>    Public or anonymized target label (required)
  --ledger <file>    Optional schema-v2 known-gap ledger
  --runs <count>     Repeated scans used for timing (default: 3, max: 20)
  --cli <file>       CLI entry point (default: apps/cli/dist/main.js)

The JSON result never stores the repository path, finding identities, source
filenames, or source hashes. Raw snapshots must be removed by every scan.`;

function parseValues(values) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    const name = value.slice(2, equals > 2 ? equals : undefined);
    if (!supportedFlags.has(name)) {
      throw new Error(`Unknown benchmark option: --${name}`);
    }
    const next = equals > 2 ? value.slice(equals + 1) : values[index + 1];
    if (!next || (equals < 0 && next.startsWith("--"))) {
      throw new Error(`Missing value for --${name}`);
    }
    flags.set(name, next);
    if (equals < 0) index += 1;
  }
  return { flags, positionals };
}

export function parseBenchmarkArgs(
  values,
  { cwd = process.cwd(), root = repositoryRoot } = {}
) {
  const { flags, positionals } = parseValues(values);
  if (positionals.length !== 1) {
    throw new Error("Benchmark requires exactly one repository path");
  }
  const label = flags.get("label");
  if (!label || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(label)) {
    throw new Error(
      "--label must be 1-80 characters using letters, numbers, dot, underscore, or hyphen"
    );
  }
  const runs = Number(flags.get("runs") ?? "3");
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) {
    throw new Error("--runs must be an integer from 1 to 20");
  }
  return {
    sourcePath: resolve(cwd, positionals[0]),
    label,
    runs,
    cliPath: resolve(cwd, flags.get("cli") ?? join(root, "apps/cli/dist/main.js")),
    ledgerPath: flags.has("ledger")
      ? resolve(cwd, flags.get("ledger"))
      : undefined
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function percent(numerator, denominator) {
  if (denominator === 0) return 100;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

export function median(values) {
  if (values.length === 0) throw new Error("Median requires at least one value");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function scoreKnownGapLedger(findingIds, ledger) {
  if (ledger?.schemaVersion !== 2 || !Array.isArray(ledger.gaps)) {
    throw new Error("Benchmark scoring requires a schema-v2 known-gap ledger");
  }
  const expectedIds = ledger.gaps.map((gap) => gap.findingId);
  if (
    expectedIds.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(expectedIds).size !== expectedIds.length
  ) {
    throw new Error("Known-gap ledger finding IDs must be unique strings");
  }
  const expected = new Set(expectedIds);
  const detected = new Set(findingIds);
  const truePositive = [...detected].filter((id) => expected.has(id)).length;
  const falsePositive = [...detected].filter((id) => !expected.has(id)).length;
  const falseNegative = [...expected].filter((id) => !detected.has(id)).length;
  return {
    ledgerSchemaVersion: 2,
    matchMode: "finding-id",
    expected: expected.size,
    detected: detected.size,
    truePositive,
    falsePositive,
    falseNegative,
    precision: percent(truePositive, truePositive + falsePositive),
    recall: percent(truePositive, truePositive + falseNegative)
  };
}

function runCli(cliPath, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 50 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Auto-RepoFlow exited ${result.status}: ${(result.stderr || result.stdout).trim()}`
    );
  }
  return result.stdout.trim();
}

function assertCleanGitTarget(sourcePath) {
  const revision = spawnSync("git", ["-C", sourcePath, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 5_000
  });
  if (revision.error || revision.status !== 0) {
    throw new Error("Benchmark target must be a Git repository with a pinned commit");
  }
  const status = spawnSync(
    "git",
    [
      "-C",
      sourcePath,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored"
    ],
    { encoding: "utf8", timeout: 5_000 }
  );
  if (status.error || status.status !== 0) {
    throw new Error("Unable to verify the benchmark target working tree");
  }
  if (status.stdout.trim()) {
    throw new Error(
      "Benchmark target must be a pristine checkout without tracked, untracked, or ignored changes"
    );
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function countBy(values) {
  return Object.fromEntries(
    [...values.reduce((counts, value) => {
      counts.set(value, (counts.get(value) ?? 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right))
  );
}

function rounded(value) {
  return Number(value.toFixed(1));
}

export async function runScanBenchmark(input) {
  const sourcePath = await realpath(input.sourcePath);
  if (!(await stat(sourcePath)).isDirectory()) {
    throw new Error("Benchmark target must be a directory");
  }
  assertCleanGitTarget(sourcePath);
  const version = runCli(input.cliPath, ["--version"]);
  const records = [];

  for (let index = 0; index < input.runs; index += 1) {
    const startedAt = performance.now();
    const reportText = runCli(input.cliPath, [
      "scan",
      sourcePath,
      "--project",
      input.label,
      "--format",
      "json"
    ]);
    const durationMs = performance.now() - startedAt;
    const report = JSON.parse(reportText);
    if (
      report.projectName !== input.label ||
      report.privacy?.sourceRootStored !== false ||
      report.privacy?.publicExportSafe !== true
    ) {
      throw new Error("Scan report violated the benchmark privacy contract");
    }

    const evaluationDirectory = join(
      homedir(),
      ".autorepoflow-private",
      "evaluations",
      report.evaluationId
    );
    const manifestText = await readFile(
      join(evaluationDirectory, "manifest.json"),
      "utf8"
    );
    if (reportText.includes(sourcePath) || manifestText.includes(sourcePath)) {
      throw new Error("Benchmark artifacts contained the absolute source path");
    }
    if (await pathExists(join(evaluationDirectory, "snapshot"))) {
      throw new Error("Benchmark scan retained a raw source snapshot");
    }

    const manifest = JSON.parse(manifestText);
    const evidenceIdentity = manifest.files
      .map((file) => `${file.relativePath}\0${file.sha256}`)
      .sort();
    const findingIdentity = report.findings.map((finding) => finding.id).sort();
    records.push({
      durationMs,
      report,
      manifest,
      evidenceFingerprint: sha256(JSON.stringify(evidenceIdentity)),
      findingFingerprint: sha256(JSON.stringify(findingIdentity))
    });
  }

  const evidenceStable = new Set(
    records.map((record) => record.evidenceFingerprint)
  ).size === 1;
  const findingIdentityStable = new Set(
    records.map((record) => record.findingFingerprint)
  ).size === 1;
  const summaryStable = new Set(
    records.map((record) => JSON.stringify(record.report.summary))
  ).size === 1;
  if (!evidenceStable || !findingIdentityStable || !summaryStable) {
    throw new Error("Repeated scans produced inconsistent evidence or findings");
  }

  const first = records[0];
  const durations = records.map((record) => rounded(record.durationMs));
  const excludedDecisions = first.manifest.decisions.filter(
    (decision) => decision.decision === "EXCLUDED"
  );
  const findingsByRule = countBy(
    first.report.findings.map((finding) => finding.ruleId)
  );
  let knownGapScore;
  if (input.ledgerPath) {
    const ledgerText = await readFile(input.ledgerPath, "utf8");
    knownGapScore = {
      ledgerSha256: sha256(ledgerText),
      ...scoreKnownGapLedger(
        first.report.findings.map((finding) => finding.id),
        JSON.parse(ledgerText)
      )
    };
  }

  return {
    schemaVersion: 1,
    kind: "auto-repoflow-scan-benchmark",
    generatedAt: new Date().toISOString(),
    tool: { name: "auto-repoflow", version },
    target: {
      label: input.label,
      sourceRootStored: false,
      revisionStored: false
    },
    protocol: {
      mode: "rules",
      runs: input.runs,
      requiresCleanGitTarget: true,
      rawSnapshotRetention: "purged-after-success"
    },
    performance: {
      durationMs: {
        samples: durations,
        min: Math.min(...durations),
        median: rounded(median(durations)),
        max: Math.max(...durations)
      }
    },
    evidence: {
      includedFiles: first.report.privacy.includedFiles,
      includedBytes: first.manifest.files.reduce(
        (total, file) => total + file.bytes,
        0
      ),
      excludedFiles: first.report.privacy.excludedFiles,
      exclusionsByReason: countBy(
        excludedDecisions.map((decision) => decision.reason)
      )
    },
    findings: {
      total: first.report.findings.length,
      summary: first.report.summary,
      byRule: findingsByRule
    },
    coverage: first.report.coverage.map((metric) => ({
      id: metric.id,
      covered: metric.covered,
      total: metric.total,
      percentage: metric.percentage
    })),
    repeatability: {
      evidenceStable,
      findingIdentityStable,
      summaryStable
    },
    privacy: {
      absoluteSourcePathAbsent: true,
      rawSnapshotsRemoved: true,
      sourceRootStored: false
    },
    ...(knownGapScore ? { knownGapScore } : {})
  };
}

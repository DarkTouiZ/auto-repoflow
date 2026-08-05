import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { EvaluationReport } from "@auto-repoflow/domain";
import { getPrivateRoot } from "./privacy.js";

interface LocalRunMetric {
  schemaVersion: 1;
  recordedAt: string;
  mode: EvaluationReport["mode"];
  aiRequestedMode: EvaluationReport["aiExecution"]["requestedMode"];
  aiProvider: EvaluationReport["aiExecution"]["provider"];
  aiStatus: EvaluationReport["aiExecution"]["status"];
  aiLatencyMs: number;
  candidateBatches: number;
  suggestionsAccepted: number;
  suggestionsRejected: number;
  findingCounts: EvaluationReport["summary"];
  evidenceMaturity: EvaluationReport["evidenceMaturity"];
  coverage: Array<{ id: string; covered: number; total: number }>;
}

export interface LocalMetricsSummary {
  schemaVersion: 1;
  generatedAt: string;
  runs: number;
  byAiStatus: Record<string, number>;
  byProvider: Record<string, number>;
  totals: {
    findings: EvaluationReport["summary"];
    suggestionsAccepted: number;
    suggestionsRejected: number;
    aiLatencyMs: number;
  };
  privacy: {
    remoteTelemetry: false;
    projectIdentifiersStored: false;
    pathsStored: false;
    sourceStored: false;
  };
}

async function metricsPath(): Promise<string> {
  return `${await getPrivateRoot()}/metrics.ndjson`;
}

export async function recordLocalMetric(report: EvaluationReport): Promise<void> {
  const metric: LocalRunMetric = {
    schemaVersion: 1,
    recordedAt: report.createdAt,
    mode: report.mode,
    aiRequestedMode: report.aiExecution.requestedMode,
    aiProvider: report.aiExecution.provider,
    aiStatus: report.aiExecution.status,
    aiLatencyMs: report.aiExecution.durationMs,
    candidateBatches: report.aiExecution.batches,
    suggestionsAccepted: report.aiExecution.suggestionsAccepted,
    suggestionsRejected: report.aiExecution.suggestionsRejected,
    findingCounts: report.summary,
    evidenceMaturity: report.evidenceMaturity,
    coverage: report.coverage.map(({ id, covered, total }) => ({
      id,
      covered,
      total
    }))
  };
  const file = await open(await metricsPath(), "a", 0o600);
  try {
    await file.write(`${JSON.stringify(metric)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readLocalMetrics(): Promise<LocalRunMetric[]> {
  try {
    const contents = await readFile(await metricsPath(), "utf8");
    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LocalRunMetric);
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

export async function summarizeLocalMetrics(): Promise<LocalMetricsSummary> {
  const metrics = await readLocalMetrics();
  const zero = { pass: 0, fail: 0, unverified: 0, humanReviewRequired: 0 };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runs: metrics.length,
    byAiStatus: Object.fromEntries(
      [...new Set(metrics.map((item) => item.aiStatus))]
        .sort()
        .map((status) => [
          status,
          metrics.filter((item) => item.aiStatus === status).length
        ])
    ),
    byProvider: Object.fromEntries(
      [...new Set(metrics.map((item) => item.aiProvider ?? "rules"))]
        .sort()
        .map((provider) => [
          provider,
          metrics.filter((item) => (item.aiProvider ?? "rules") === provider)
            .length
        ])
    ),
    totals: {
      findings: metrics.reduce(
        (total, item) => ({
          pass: total.pass + item.findingCounts.pass,
          fail: total.fail + item.findingCounts.fail,
          unverified: total.unverified + item.findingCounts.unverified,
          humanReviewRequired:
            total.humanReviewRequired +
            item.findingCounts.humanReviewRequired
        }),
        zero
      ),
      suggestionsAccepted: metrics.reduce(
        (total, item) => total + item.suggestionsAccepted,
        0
      ),
      suggestionsRejected: metrics.reduce(
        (total, item) => total + item.suggestionsRejected,
        0
      ),
      aiLatencyMs: metrics.reduce(
        (total, item) => total + item.aiLatencyMs,
        0
      )
    },
    privacy: {
      remoteTelemetry: false,
      projectIdentifiersStored: false,
      pathsStored: false,
      sourceStored: false
    }
  };
}

export async function exportLocalMetrics(destination: string): Promise<string> {
  const path = resolve(destination);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(await summarizeLocalMetrics(), null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  return path;
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { EvaluationReport } from "@auto-repoflow/domain";
import {
  createSemanticLinkProvider,
  verifyAiSuggestions
} from "./ai.js";
import {
  buildEvaluationReport,
  createPublicReport,
  scoreKnownGaps,
  type KnownGapLedger
} from "./evaluate.js";
import { extractArtifacts } from "./extract.js";
import {
  createPrivateSnapshot,
  getPrivateRoot,
  privacyDecisionFor,
  sha256,
  type SnapshotManifest
} from "./privacy.js";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export class EvaluationService {
  async snapshot(input: {
    sourcePath: string;
    projectName: string;
    evaluationId?: string;
  }) {
    return createPrivateSnapshot(input);
  }

  async run(input: {
    evaluationId: string;
    mode?: "rules" | "local-ai";
    scopePrefix?: string;
  }): Promise<EvaluationReport> {
    const root = await getPrivateRoot();
    const directory = join(root, "evaluations", input.evaluationId);
    const manifest = await readJson<SnapshotManifest>(
      join(directory, "manifest.json")
    );
    const project = await readJson<{ projectName: string }>(
      join(directory, "project.json")
    );
    const extracted = await extractArtifacts(
      join(directory, "snapshot"),
      manifest.files
    );
    let report = buildEvaluationReport({
      evaluationId: input.evaluationId,
      projectName: project.projectName,
      mode: input.mode ?? "rules",
      manifest,
      extracted,
      scopePrefix: input.scopePrefix
    });
    if (input.mode === "local-ai") {
      const provider = createSemanticLinkProvider();
      try {
        const suggestions = await provider.suggestLinks(report.nodes);
        report = verifyAiSuggestions(report, suggestions);
      } catch (error) {
        report.findings.push({
          id: "finding:ARF-AI-001:local-provider-unavailable",
          ruleId: "ARF-AI-001",
          severity: "MEDIUM",
          status: "UNVERIFIED",
          title: "Local AI provider did not produce verified suggestions",
          explanation:
            error instanceof Error
              ? error.message
              : "Unknown local provider error",
          evidence: [],
          suggestedAction:
            "Start Ollama on loopback or use ARF_AI_PROVIDER=mock for deterministic rules-only behavior."
        });
        report.summary.unverified += 1;
      }
    }
    await writeFile(
      join(directory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 }
    );
    return report;
  }

  async validate(evaluationId: string): Promise<{
    valid: boolean;
    checkedFiles: number;
    errors: string[];
  }> {
    const root = await getPrivateRoot();
    const directory = join(root, "evaluations", evaluationId);
    const manifest = await readJson<SnapshotManifest>(
      join(directory, "manifest.json")
    );
    const errors: string[] = [];
    for (const file of manifest.files) {
      try {
        const contents = await readFile(join(directory, "snapshot", file.relativePath));
        const { sha256 } = await import("./privacy.js");
        if (sha256(contents) !== file.sha256) {
          errors.push(`hash_mismatch:${file.relativePath}`);
        }
      } catch {
        errors.push(`missing:${file.relativePath}`);
      }
    }
    return {
      valid: errors.length === 0,
      checkedFiles: manifest.files.length,
      errors
    };
  }

  async attachEvidence(input: {
    evaluationId: string;
    filePath: string;
    alias: string;
  }): Promise<{
    evaluationId: string;
    relativePath: string;
    sha256: string;
    manifestSha256: string;
  }> {
    if (
      basename(input.alias) !== input.alias ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.alias)
    ) {
      throw new Error("Evidence alias must be a safe filename without directories");
    }
    const relativePath = `.evaluation-input/${input.alias}`;
    const decision = privacyDecisionFor(relativePath);
    if (decision.decision !== "INCLUDED") {
      throw new Error(`Evidence rejected by privacy policy: ${decision.reason}`);
    }
    const root = await getPrivateRoot();
    const directory = join(root, "evaluations", input.evaluationId);
    const manifestPath = join(directory, "manifest.json");
    const manifest = await readJson<SnapshotManifest>(manifestPath);
    const contents = await readFile(input.filePath);
    const destinationDirectory = join(directory, "snapshot", ".evaluation-input");
    const destination = join(destinationDirectory, input.alias);
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    await writeFile(destination, contents, { flag: "wx", mode: 0o600 });
    const digest = sha256(contents);
    manifest.files.push({
      relativePath,
      sha256: digest,
      bytes: contents.byteLength
    });
    manifest.files.sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath)
    );
    manifest.decisions.push({
      relativePath,
      decision: "INCLUDED",
      reason: "explicit_external_evidence"
    });
    const { manifestSha256: _previousHash, ...manifestCore } = manifest;
    manifest.manifestSha256 = sha256(JSON.stringify(manifestCore));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600
    });
    return {
      evaluationId: input.evaluationId,
      relativePath,
      sha256: digest,
      manifestSha256: manifest.manifestSha256
    };
  }

  async createAndRun(input: {
    sourcePath: string;
    projectName: string;
    mode?: "rules" | "local-ai";
  }): Promise<EvaluationReport> {
    const evaluationId = randomUUID();
    await this.snapshot({ ...input, evaluationId });
    return this.run({ evaluationId, mode: input.mode });
  }

  async report(evaluationId: string): Promise<EvaluationReport> {
    const root = await getPrivateRoot();
    return readJson<EvaluationReport>(
      join(root, "evaluations", evaluationId, "report.json")
    );
  }

  async exportPublic(evaluationId: string): Promise<{
    path: string;
    report: ReturnType<typeof createPublicReport>;
  }> {
    const root = await getPrivateRoot();
    const report = await this.report(evaluationId);
    const publicReport = createPublicReport(report);
    const path = join(
      root,
      "evaluations",
      evaluationId,
      "public-report.json"
    );
    await writeFile(path, `${JSON.stringify(publicReport, null, 2)}\n`, {
      mode: 0o600
    });
    return { path, report: publicReport };
  }

  async score(evaluationId: string, ledgerPath: string) {
    const report = await this.report(evaluationId);
    const ledger = await readJson<KnownGapLedger>(ledgerPath);
    return scoreKnownGaps(report, ledger);
  }

  async purgeArtifacts(evaluationId: string): Promise<void> {
    const root = await getPrivateRoot();
    await rm(join(root, "evaluations", evaluationId, "snapshot"), {
      recursive: true,
      force: false
    });
  }

  async purgeExpiredRawArtifacts(maxAgeDays = 7): Promise<{
    maxAgeDays: number;
    purgedEvaluationIds: string[];
  }> {
    if (!Number.isFinite(maxAgeDays) || maxAgeDays < 1) {
      throw new Error("Retention days must be at least 1");
    }
    const root = await getPrivateRoot();
    const evaluationsDirectory = join(root, "evaluations");
    let entries;
    try {
      entries = await readdir(evaluationsDirectory, { withFileTypes: true });
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { maxAgeDays, purgedEvaluationIds: [] };
      }
      throw error;
    }
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const purgedEvaluationIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const project = await readJson<{ createdAt: string }>(
          join(evaluationsDirectory, entry.name, "project.json")
        );
        if (new Date(project.createdAt).getTime() >= cutoff) continue;
        await rm(join(evaluationsDirectory, entry.name, "snapshot"), {
          recursive: true,
          force: true
        });
        purgedEvaluationIds.push(entry.name);
      } catch {
        // Invalid evaluation metadata is retained for manual inspection.
      }
    }
    return { maxAgeDays, purgedEvaluationIds };
  }
}

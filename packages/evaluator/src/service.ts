import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  AiProviderName,
  AiRequestMode,
  EvaluationReport
} from "@auto-repoflow/domain";
import {
  buildAiEvidenceArtifacts,
  classifyAiError,
  createAiProvider,
  evidenceDraftPayloadSha256,
  executeAiEnrichment,
  type SemanticLinkProvider
} from "./ai.js";
import {
  buildEvaluationReport,
  createPublicReport,
  scoreKnownGaps,
  type KnownGapLedger
} from "./evaluate.js";
import { extractArtifacts } from "./extract.js";
import { generatePrivateEvidenceDrafts } from "./drafts.js";
import { recordLocalMetric } from "./metrics.js";
import {
  createPrivateSnapshot,
  getPrivateRoot,
  privacyDecisionFor,
  sha256,
  type SnapshotManifest
} from "./privacy.js";
import {
  loadEvaluationPipelineConfig,
  preflightEvaluationPipelineConfig,
  resolveScopedRepositoryPath
} from "./pipeline.js";
import {
  assertCloudAuthorization,
  assertProviderAllowed,
  DEFAULT_AUTOMATION_POLICY,
  modelForProvider,
  type AutomationPolicy
} from "./policy.js";
import { runQualityChecks } from "./quality.js";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function assertEvaluationId(evaluationId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      evaluationId
    )
  ) {
    throw new Error("Invalid evaluation id");
  }
  return evaluationId;
}

export interface AiRunOptions {
  requestedMode: AiRequestMode;
  provider?: AiProviderName;
  model?: string;
  policy?: AutomationPolicy;
  allowCloudMetadata?: boolean;
  providerInstance?: SemanticLinkProvider;
  onEgressSummary?: Parameters<typeof executeAiEnrichment>[0]["onEgressSummary"];
}

export class EvaluationService {
  async runPipeline(configPath: string) {
    const configContents = await readFile(configPath);
    const config = await loadEvaluationPipelineConfig(configPath);
    await preflightEvaluationPipelineConfig(config);

    const snapshot = await this.snapshot({
      sourcePath: config.sourcePath,
      projectName: config.projectName
    });
    const attachedEvidence: Array<{
      alias: string;
      sha256: string;
    }> = [];
    let manifestSha256 = snapshot.manifest.manifestSha256;
    for (const item of config.evidence) {
      const attached = await this.attachEvidence({
        evaluationId: snapshot.evaluationId,
        filePath: item.filePath,
        alias: item.alias
      });
      attachedEvidence.push({
        alias: item.alias,
        sha256: attached.sha256
      });
      manifestSha256 = attached.manifestSha256;
    }

    const validation = await this.validate(snapshot.evaluationId);
    if (!validation.valid) {
      throw new Error(
        `Pipeline manifest validation failed with ${validation.errors.length} error(s)`
      );
    }
    const pipelineBase = {
      schemaVersion: 1 as const,
      configSha256: sha256(configContents),
      evaluationId: snapshot.evaluationId,
      manifestSha256,
      includedFiles: snapshot.manifest.files.length + attachedEvidence.length,
      excludedFiles: snapshot.manifest.decisions.filter(
        (item) => item.decision === "EXCLUDED"
      ).length,
      attachedEvidence,
      validation
    };
    let quality:
      | {
          passed: boolean;
          evidencePath: string;
          checks: Array<{
            id: string;
            tool: string;
            required: boolean;
            passed: boolean;
            exitCode: number | null;
            timedOut: boolean;
            durationMs: number;
          }>;
        }
      | undefined;
    if (config.quality) {
      const qualityResult = await runQualityChecks({
        sourcePath: config.sourcePath,
        evaluationDirectory: snapshot.evaluationDirectory,
        quality: config.quality
      });
      const evidencePath = join(
        snapshot.evaluationDirectory,
        "quality-results.json"
      );
      await writeFile(
        evidencePath,
        `${JSON.stringify(qualityResult, null, 2)}\n`,
        { mode: 0o600 }
      );
      quality = {
        passed: qualityResult.passed,
        evidencePath,
        checks: qualityResult.checks.map((item) => ({
          id: item.id,
          tool: item.tool,
          required: item.required,
          passed: item.passed,
          exitCode: item.exitCode,
          timedOut: item.timedOut,
          durationMs: item.durationMs
        }))
      };
      if (!qualityResult.passed) {
        return {
          ...pipelineBase,
          status: "QUALITY_FAILED" as const,
          quality,
          summary: undefined,
          coverage: [],
          publicReportPath: undefined
        };
      }
    }
    const report = await this.run({
      evaluationId: snapshot.evaluationId,
      mode: config.mode,
      scopePrefix: config.scopePrefix
    });
    const publicExport = config.exportPublic
      ? await this.exportPublic(snapshot.evaluationId)
      : undefined;

    return {
      ...pipelineBase,
      status: report.status,
      quality,
      summary: report.summary,
      coverage: report.coverage,
      publicReportPath: publicExport?.path
    };
  }

  async snapshot(input: {
    sourcePath: string;
    projectName: string;
    evaluationId?: string;
  }) {
    if (input.evaluationId) assertEvaluationId(input.evaluationId);
    return createPrivateSnapshot(input);
  }

  async run(input: {
    evaluationId: string;
    mode?: "rules" | "local-ai";
    scopePrefix?: string;
    ai?: AiRunOptions;
  }): Promise<EvaluationReport> {
    assertEvaluationId(input.evaluationId);
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
    const policy = input.ai?.policy ?? DEFAULT_AUTOMATION_POLICY;
    const requestedMode =
      input.ai?.requestedMode ?? (input.mode === "local-ai" ? "local" : "off");
    const providerInstance = (provider: AiProviderName): SemanticLinkProvider => {
      const instance = input.ai?.providerInstance ?? createAiProvider(provider);
      if (input.ai) input.ai.providerInstance = instance;
      return instance;
    };
    try {
      if (requestedMode === "auto") {
        const model = modelForProvider(
          policy,
          "ollama",
          input.ai?.model ?? process.env.ARF_OLLAMA_MODEL
        );
        if (!model || !policy.ai.allowedProviders.includes("ollama")) {
          report.aiExecution = {
            ...report.aiExecution,
            requestedMode: "auto",
            provider: "ollama",
            status: "fallback",
            fallbackUsed: true,
            errorCode: model
              ? "AI_PROVIDER_NOT_ALLOWED"
              : "AI_MODEL_NOT_CONFIGURED"
          };
        } else {
          report = await executeAiEnrichment({
            report,
            provider: providerInstance("ollama"),
            model,
            requestedMode: "auto",
            policy,
            allowFallback: true,
            onEgressSummary: input.ai?.onEgressSummary
          });
        }
      } else if (requestedMode === "local") {
        const provider = input.ai?.provider ?? "ollama";
        if (provider !== "ollama") {
          throw new Error("Local AI mode supports only the Ollama provider");
        }
        assertProviderAllowed(policy, provider);
        const model = modelForProvider(
          policy,
          provider,
          input.ai?.model ?? process.env.ARF_OLLAMA_MODEL
        );
        if (!model) throw new Error("A model is required for local AI mode");
        report = await executeAiEnrichment({
          report,
          provider: providerInstance(provider),
          model,
          requestedMode: "local",
          policy,
          allowFallback: false,
          onEgressSummary: input.ai?.onEgressSummary
        });
      } else if (requestedMode === "cloud") {
        const provider = input.ai?.provider;
        if (!provider || provider === "ollama") {
          throw new Error(
            "Cloud AI mode requires openai, anthropic, or google provider"
          );
        }
        const model = assertCloudAuthorization({
          policy,
          provider,
          allowCloudMetadata: input.ai?.allowCloudMetadata === true,
          model: input.ai?.model
        });
        report = await executeAiEnrichment({
          report,
          provider: providerInstance(provider),
          model,
          requestedMode: "cloud",
          policy,
          allowFallback: false,
          onEgressSummary: input.ai?.onEgressSummary
        });
      }
      if (report.aiExecution.status === "used") report.mode = "local-ai";
    } catch (error) {
      if (report.aiExecution.status === "disabled") {
        report.aiExecution = {
          ...report.aiExecution,
          requestedMode,
          provider:
            requestedMode === "cloud"
              ? input.ai?.provider ?? null
              : requestedMode === "off"
                ? null
                : "ollama",
          model: input.ai?.model ?? null,
          status: "failed",
          errorCode: classifyAiError(error)
        };
      }
      await writeFile(
        join(directory, "report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        { mode: 0o600 }
      );
      throw error;
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
    assertEvaluationId(evaluationId);
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
    assertEvaluationId(input.evaluationId);
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
    return this.scan(input);
  }

  async scan(input: {
    sourcePath: string;
    projectName?: string;
    mode?: "rules" | "local-ai";
    retainSnapshot?: boolean;
    ai?: AiRunOptions;
    generateEvidence?: "none" | "missing" | "all";
  }): Promise<EvaluationReport> {
    const sourcePath = await resolveScopedRepositoryPath(input.sourcePath);
    const evaluationId = randomUUID();
    await this.snapshot({
      sourcePath,
      projectName: input.projectName?.trim() || basename(sourcePath),
      evaluationId
    });
    const validation = await this.validate(evaluationId);
    if (!validation.valid) {
      throw new Error(
        `Snapshot validation failed with ${validation.errors.length} error(s)`
      );
    }
    const report = await this.run({
      evaluationId,
      mode: input.mode,
      ai: input.ai ?? {
        requestedMode: "auto",
        policy: DEFAULT_AUTOMATION_POLICY
      }
    });
    let draftSeeds: Awaited<
      ReturnType<SemanticLinkProvider["generateEvidenceDrafts"]>
    >["drafts"] = [];
    const requestedDraftMode = input.generateEvidence ?? "missing";
    const aiProvider = input.ai?.providerInstance;
    if (
      requestedDraftMode !== "none" &&
      report.aiExecution.status === "used" &&
      report.aiExecution.model &&
      aiProvider?.capabilities.evidenceDraftSeeds
    ) {
      const evidenceInput = {
        artifacts: buildAiEvidenceArtifacts(
          report,
          aiProvider.cloud,
          input.ai?.policy?.ai.batchSize
            ? input.ai.policy.ai.batchSize * input.ai.policy.ai.maxBatches
            : 250
        ),
        missingKinds: ["design-flow", "test-plan"] as Array<
          "design-flow" | "test-plan"
        >,
        model: report.aiExecution.model,
        timeoutMs:
          (input.ai?.policy ?? DEFAULT_AUTOMATION_POLICY).ai.timeoutSeconds *
          1_000,
        retries: (input.ai?.policy ?? DEFAULT_AUTOMATION_POLICY).ai.retries
      };
      try {
        if (aiProvider.cloud && aiProvider.name !== "mock") {
          await input.ai?.onEgressSummary?.({
            stage: "evidence-drafts",
            provider: aiProvider.name as Exclude<AiProviderName, "ollama">,
            candidateCount: evidenceInput.artifacts.length,
            payloadSha256: evidenceDraftPayloadSha256(evidenceInput),
            fields: [
              "anonymous artifact IDs",
              "artifact kinds",
              "sanitized names",
              "API locators"
            ]
          });
        }
        const generated = await aiProvider.generateEvidenceDrafts(evidenceInput);
        draftSeeds = generated.drafts;
        const previousUsage = report.aiExecution.usage ?? {};
        if (generated.usage) {
          report.aiExecution.usage = {
            inputTokens:
              (previousUsage.inputTokens ?? 0) +
              (generated.usage.inputTokens ?? 0),
            outputTokens:
              (previousUsage.outputTokens ?? 0) +
              (generated.usage.outputTokens ?? 0)
          };
        }
        report.aiExecution.payloadSha256 = sha256(
          `${report.aiExecution.payloadSha256 ?? ""}:${generated.payloadSha256}`
        );
      } catch (error) {
        report.aiExecution.errorCode = classifyAiError(error);
        if (report.aiExecution.requestedMode === "auto") {
          report.edges = report.edges.filter((edge) => edge.source !== "LOCAL_AI");
          report.aiExecution.status = "fallback";
          report.aiExecution.fallbackUsed = true;
          report.aiExecution.suggestionsAccepted = 0;
          report.summary.pass = report.edges.filter(
            (edge) => edge.status === "PASS"
          ).length;
          report.summary.humanReviewRequired =
            report.edges.filter(
              (edge) => edge.status === "HUMAN_REVIEW_REQUIRED"
            ).length +
            report.findings.filter(
              (finding) => finding.status === "HUMAN_REVIEW_REQUIRED"
            ).length;
          report.evidenceMaturity.unresolvedReviewGates =
            report.summary.humanReviewRequired;
        } else {
          report.aiExecution.status = "failed";
          const root = await getPrivateRoot();
          await writeFile(
            join(root, "evaluations", evaluationId, "report.json"),
            `${JSON.stringify(report, null, 2)}\n`,
            { mode: 0o600 }
          );
          throw error;
        }
      }
    }
    const drafts = await generatePrivateEvidenceDrafts({
      report,
      mode: requestedDraftMode,
      seeds: draftSeeds
    });
    if (drafts.length > 0) {
      report.evidenceMaturity.generated += drafts.length;
      report.evidenceMaturity.unresolvedReviewGates += drafts.length;
      const root = await getPrivateRoot();
      await writeFile(
        join(root, "evaluations", evaluationId, "report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        { mode: 0o600 }
      );
    }
    await recordLocalMetric(report);
    if (input.retainSnapshot === false) {
      await this.purgeArtifacts(evaluationId);
    }
    return report;
  }

  async report(evaluationId: string): Promise<EvaluationReport> {
    assertEvaluationId(evaluationId);
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
    assertEvaluationId(evaluationId);
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

  async purgeExpiredArtifacts(
    policy: AutomationPolicy
  ): Promise<{
    failedSnapshotRetentionHours: number;
    artifactRetentionDays: number;
    rawSnapshotsPurged: string[];
    evaluationsPurged: string[];
  }> {
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
        return {
          failedSnapshotRetentionHours:
            policy.evidence.failedSnapshotRetentionHours,
          artifactRetentionDays: policy.evidence.artifactRetentionDays,
          rawSnapshotsPurged: [],
          evaluationsPurged: []
        };
      }
      throw error;
    }
    const failedCutoff =
      Date.now() -
      policy.evidence.failedSnapshotRetentionHours * 60 * 60 * 1000;
    const artifactCutoff =
      Date.now() - policy.evidence.artifactRetentionDays * 24 * 60 * 60 * 1000;
    const rawSnapshotsPurged: string[] = [];
    const evaluationsPurged: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(evaluationsDirectory, entry.name);
      let createdAt: number;
      try {
        const project = await readJson<{ createdAt: string }>(
          join(directory, "project.json")
        );
        createdAt = new Date(project.createdAt).getTime();
      } catch {
        continue;
      }
      if (createdAt < artifactCutoff) {
        await rm(directory, { recursive: true, force: true });
        evaluationsPurged.push(entry.name);
        continue;
      }
      if (createdAt >= failedCutoff) continue;
      let failed = false;
      try {
        const report = await readJson<EvaluationReport>(
          join(directory, "report.json")
        );
        failed = report.aiExecution.status === "failed";
      } catch {
        failed = true;
      }
      if (!failed) continue;
      await rm(join(directory, "snapshot"), { recursive: true, force: true });
      rawSnapshotsPurged.push(entry.name);
    }
    return {
      failedSnapshotRetentionHours:
        policy.evidence.failedSnapshotRetentionHours,
      artifactRetentionDays: policy.evidence.artifactRetentionDays,
      rawSnapshotsPurged,
      evaluationsPurged
    };
  }
}

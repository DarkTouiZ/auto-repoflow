import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile
} from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type { EvaluationReport } from "@auto-repoflow/domain";
import type { ProviderEvidenceDraftSeed } from "./ai.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  assertEvidenceExportAllowed,
  type AutomationPolicy
} from "./policy.js";
import { getPrivateRoot } from "./privacy.js";

const reviewStatus = "draft_generated_requires_team_review" as const;
const draftKindSchema = z.enum(["design-flow", "test-plan"]);

const draftRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    draftId: z.string().uuid(),
    evaluationId: z.string().uuid(),
    kind: draftKindSchema,
    generatedAt: z.string().datetime(),
    generator: z.enum(["rules", "local-ai", "cloud-ai"]),
    provider: z
      .enum(["ollama", "openai", "anthropic", "google"])
      .nullable(),
    model: z.string().min(1).max(200).nullable(),
    reviewStatus: z.literal(reviewStatus),
    sourceReportSha256: z.string().regex(/^[0-9a-f]{64}$/),
    content: z.record(z.unknown()),
    sha256: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict();

export type EvidenceDraft = z.infer<typeof draftRecordSchema>;

export const evidenceReviewManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    draftId: z.string().uuid(),
    draftSha256: z.string().regex(/^[0-9a-f]{64}$/),
    reviewerId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/),
    decision: z.enum(["approved", "rejected"]),
    reviewedAt: z.string().datetime()
  })
  .strict();

export type EvidenceReviewManifest = z.infer<
  typeof evidenceReviewManifestSchema
>;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function draftCore(
  draft: Omit<EvidenceDraft, "sha256">
): Omit<EvidenceDraft, "sha256"> {
  return draft;
}

function signDraft(draft: Omit<EvidenceDraft, "sha256">): EvidenceDraft {
  return {
    ...draft,
    sha256: sha256(JSON.stringify(draftCore(draft)))
  };
}

function validateSignedDraft(value: unknown): EvidenceDraft {
  const draft = draftRecordSchema.parse(value);
  const { sha256: digest, ...core } = draft;
  if (sha256(JSON.stringify(core)) !== digest) {
    throw new Error("Evidence draft hash does not match its content");
  }
  return draft;
}

async function evaluationDraftDirectory(evaluationId: string): Promise<string> {
  z.string().uuid().parse(evaluationId);
  const root = await getPrivateRoot();
  const directory = join(root, "evaluations", evaluationId, "drafts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function safeId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return normalized || "generated-item";
}

function designFlowContent(
  report: EvaluationReport,
  seeds: ProviderEvidenceDraftSeed[]
): Record<string, unknown> {
  const actions = report.nodes
    .filter((item) => item.kind === "UI_ACTION")
    .map((item) => ({
      id: safeId(item.name),
      label: item.name,
      api_operation:
        typeof item.attributes?.apiOperation === "string"
          ? item.attributes.apiOperation
          : null,
      requires_review: true
    }));
  const apiCandidates = report.nodes
    .filter((item) => item.kind === "API_OPERATION")
    .slice(0, 100)
    .map((item) => ({
      id: safeId(item.locator),
      label: `Review ${item.locator}`,
      api_operation: item.locator,
      requires_review: true
    }));
  const aiCandidates =
    seeds
      .find((seed) => seed.kind === "design-flow")
      ?.items.map((item) => ({
        id: safeId(`${item.artifactToken}-${item.title}`),
        label: item.title,
        artifact_token: item.artifactToken,
        acceptance_criteria: item.acceptanceCriteria,
        requires_review: true
      })) ?? [];
  return {
    schema_version: 1,
    review_status: reviewStatus,
    source: "auto_repoflow_generated_metadata",
    privacy: "metadata_only",
    screens: [
      {
        id: "generated-review-surface",
        name: "Generated review surface",
        acceptance_criteria_required: true,
        acceptance_criteria: [],
        states: [],
        actions:
          actions.length > 0
            ? [...actions, ...aiCandidates]
            : [...apiCandidates, ...aiCandidates]
      }
    ]
  };
}

function testPlanContent(
  report: EvaluationReport,
  seeds: ProviderEvidenceDraftSeed[]
): Record<string, unknown> {
  const tests = report.nodes.filter((item) => item.kind === "TEST_CASE");
  const operations = report.nodes
    .filter((item) => item.kind === "API_OPERATION")
    .slice(0, 200);
  const aiCases =
    seeds
      .find((seed) => seed.kind === "test-plan")
      ?.items.map((item) => ({
        id: safeId(`${item.artifactToken}-${item.title}`),
        name: item.title,
        artifact_token: item.artifactToken,
        level: "review-draft",
        existing_executable_evidence: false,
        scenarios: item.acceptanceCriteria
      })) ?? [];
  return {
    schema_version: 1,
    review_status: reviewStatus,
    privacy: "metadata_only",
    data_policy: "local_or_mock_only",
    scope: {
      operations: operations.length,
      executable_tests_created: 0
    },
    test_cases: [...operations.map((operation) => {
      const linked = report.edges.some(
        (edge) =>
          edge.kind === "VERIFIED_BY" &&
          edge.from === operation.id &&
          tests.some((test) => test.id === edge.to)
      );
      return {
        id: safeId(operation.locator),
        name: `${operation.locator} evidence plan`,
        api_operation: operation.locator,
        level: "integration",
        existing_executable_evidence: linked,
        scenarios: linked
          ? []
          : [
              "successful response",
              "invalid input does not return success",
              "authorization boundary is reviewed"
            ]
      };
    }), ...aiCases]
  };
}

function generatorFor(
  report: EvaluationReport,
  seeds: ProviderEvidenceDraftSeed[]
): Pick<
  EvidenceDraft,
  "generator" | "provider" | "model"
> {
  if (
    seeds.length === 0 ||
    report.aiExecution.status !== "used" ||
    !report.aiExecution.provider
  ) {
    return { generator: "rules", provider: null, model: null };
  }
  return {
    generator:
      report.aiExecution.provider === "ollama" ? "local-ai" : "cloud-ai",
    provider: report.aiExecution.provider,
    model: report.aiExecution.model
  };
}

export async function generatePrivateEvidenceDrafts(input: {
  report: EvaluationReport;
  mode: "none" | "missing" | "all";
  seeds?: ProviderEvidenceDraftSeed[];
}): Promise<EvidenceDraft[]> {
  if (input.mode === "none") return [];
  const hasReviewedDesign = input.report.nodes.some(
    (item) =>
      item.kind === "SCREEN" &&
      ["human_reviewed", "approved_for_synthetic_benchmark"].includes(
        String(item.attributes?.reviewStatus ?? "")
      )
  );
  const hasTestPlan = input.report.nodes.some(
    (item) => item.attributes?.source === "test-plan"
  );
  const kinds = (
    input.mode === "all"
      ? ["design-flow", "test-plan"]
      : [
          ...(hasReviewedDesign ? [] : ["design-flow"]),
          ...(hasTestPlan ? [] : ["test-plan"])
        ]
  ) as Array<"design-flow" | "test-plan">;
  if (kinds.length === 0) return [];
  const directory = await evaluationDraftDirectory(input.report.evaluationId);
  const seeds = input.seeds ?? [];
  const generator = generatorFor(input.report, seeds);
  const drafts: EvidenceDraft[] = [];
  for (const kind of kinds) {
    const unsigned = {
      schemaVersion: 1 as const,
      draftId: randomUUID(),
      evaluationId: input.report.evaluationId,
      kind,
      generatedAt: new Date().toISOString(),
      ...generator,
      reviewStatus,
      sourceReportSha256: input.report.snapshotSha256,
      content:
        kind === "design-flow"
          ? designFlowContent(input.report, seeds)
          : testPlanContent(input.report, seeds)
    };
    const draft = signDraft(unsigned);
    await writeFile(
      join(directory, `${kind}.json`),
      `${JSON.stringify(draft, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
    drafts.push(draft);
  }
  return drafts;
}

export async function listEvidenceDrafts(
  evaluationId: string
): Promise<EvidenceDraft[]> {
  const directory = await evaluationDraftDirectory(evaluationId);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json") && !name.endsWith(".approval.json"))
    .sort();
  const drafts: EvidenceDraft[] = [];
  for (const name of names) {
    drafts.push(
      validateSignedDraft(JSON.parse(await readFile(join(directory, name), "utf8")))
    );
  }
  return drafts;
}

export async function validateEvidenceDraftFile(
  filePath: string
): Promise<EvidenceDraft> {
  if (extname(filePath).toLowerCase() !== ".json") {
    throw new Error("Canonical evidence drafts must be JSON files");
  }
  return validateSignedDraft(JSON.parse(await readFile(filePath, "utf8")));
}

export async function approveEvidenceDraft(input: {
  evaluationId: string;
  manifestPath: string;
}): Promise<{ draft: EvidenceDraft; review: EvidenceReviewManifest }> {
  const review = evidenceReviewManifestSchema.parse(
    parseYaml(await readFile(input.manifestPath, "utf8"))
  );
  if (/^(?:ai|auto|ollama|openai|anthropic|google)(?:-|_|$)/i.test(review.reviewerId)) {
    throw new Error("AI providers cannot approve generated evidence");
  }
  const drafts = await listEvidenceDrafts(input.evaluationId);
  const draft = drafts.find((item) => item.draftId === review.draftId);
  if (!draft || review.draftSha256 !== draft.sha256) {
    throw new Error("Review manifest does not match an immutable draft hash");
  }
  const directory = await evaluationDraftDirectory(input.evaluationId);
  await writeFile(
    join(directory, `${draft.kind}.approval.json`),
    `${JSON.stringify(review, null, 2)}\n`,
    { flag: "wx", mode: 0o600 }
  );
  const root = await getPrivateRoot();
  const reportPath = join(
    root,
    "evaluations",
    input.evaluationId,
    "report.json"
  );
  const report = JSON.parse(
    await readFile(reportPath, "utf8")
  ) as EvaluationReport;
  report.evidenceMaturity.unresolvedReviewGates = Math.max(
    0,
    report.evidenceMaturity.unresolvedReviewGates - 1
  );
  if (review.decision === "approved") {
    report.evidenceMaturity.generated = Math.max(
      0,
      report.evidenceMaturity.generated - 1
    );
    report.evidenceMaturity.reviewed += 1;
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600
  });
  return { draft, review };
}

async function approvalFor(
  evaluationId: string,
  draft: EvidenceDraft
): Promise<EvidenceReviewManifest | undefined> {
  const directory = await evaluationDraftDirectory(evaluationId);
  try {
    const review = evidenceReviewManifestSchema.parse(
      JSON.parse(
        await readFile(join(directory, `${draft.kind}.approval.json`), "utf8")
      )
    );
    if (review.draftId !== draft.draftId || review.draftSha256 !== draft.sha256) {
      throw new Error("Stored approval no longer matches the draft hash");
    }
    return review;
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function exportEvidenceDrafts(input: {
  evaluationId: string;
  destination: string;
  policy: AutomationPolicy;
}): Promise<Array<{ kind: EvidenceDraft["kind"]; filename: string }>> {
  const destination = assertEvidenceExportAllowed(
    input.policy,
    input.destination
  );
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const actualDestination = await realpath(destination);
  const actualRoots = (
    await Promise.all(
      input.policy.evidence.exportRoots.map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return undefined;
        }
      })
    )
  ).filter((root): root is string => Boolean(root));
  if (
    !actualRoots.some((root) => {
      const rel = relative(root, actualDestination);
      return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
    })
  ) {
    throw new Error(
      "Evidence export destination resolves outside policy export roots"
    );
  }
  const drafts = await listEvidenceDrafts(input.evaluationId);
  const exported: Array<{ kind: EvidenceDraft["kind"]; filename: string }> = [];
  for (const draft of drafts) {
    const approval = await approvalFor(input.evaluationId, draft);
    const content = {
      ...draft.content,
      review_status:
        approval?.decision === "approved" ? "human_reviewed" : reviewStatus,
      x_auto_repoflow: {
        draft_id: draft.draftId,
        draft_sha256: draft.sha256,
        maturity:
          approval?.decision === "approved" ? "REVIEWED" : "GENERATED",
        reviewer_id: approval?.reviewerId ?? null,
        reviewed_at: approval?.reviewedAt ?? null
      }
    };
    const filename = `${draft.kind}.yaml`;
    await writeFile(join(destination, filename), stringifyYaml(content), {
      flag: "wx",
      mode: 0o600
    });
    exported.push({ kind: draft.kind, filename: basename(filename) });
  }
  return exported;
}

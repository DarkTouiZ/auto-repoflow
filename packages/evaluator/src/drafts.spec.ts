import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveEvidenceDraft,
  exportEvidenceDrafts,
  listEvidenceDrafts,
  validateEvidenceDraftFile
} from "./drafts.js";
import { automationPolicySchema } from "./policy.js";
import { EvaluationService } from "./service.js";

const previousHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = previousHome;
});

describe("private generated evidence", () => {
  it("keeps GENERATED separate from hash-bound human REVIEWED evidence", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-drafts-"));
    process.env.HOME = join(sandbox, "home");
    const source = join(sandbox, "repository");
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "routes.ts"),
      'router.get("/api/widgets", listWidgets); export function listWidgets() {}'
    );
    const report = await new EvaluationService().scan({
      sourcePath: source,
      ai: { requestedMode: "off" },
      generateEvidence: "missing"
    });
    const drafts = await listEvidenceDrafts(report.evaluationId);
    expect(drafts).toHaveLength(2);
    expect(drafts.every((draft) => draft.reviewStatus === "draft_generated_requires_team_review")).toBe(true);
    expect(report.evidenceMaturity).toMatchObject({ generated: 2, reviewed: 0 });

    const canonicalPath = join(
      process.env.HOME,
      ".autorepoflow-private",
      "evaluations",
      report.evaluationId,
      "drafts",
      `${drafts[0].kind}.json`
    );
    await expect(validateEvidenceDraftFile(canonicalPath)).resolves.toMatchObject({
      sha256: drafts[0].sha256
    });

    const manifest = join(sandbox, "review.json");
    await writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        draftId: drafts[0].draftId,
        draftSha256: drafts[0].sha256,
        reviewerId: "reviewer_7",
        decision: "approved",
        reviewedAt: new Date().toISOString()
      })
    );
    await expect(
      approveEvidenceDraft({ evaluationId: report.evaluationId, manifestPath: manifest })
    ).resolves.toMatchObject({ review: { decision: "approved" } });
    await expect(new EvaluationService().report(report.evaluationId)).resolves.toMatchObject({
      evidenceMaturity: { generated: 1, reviewed: 1 }
    });

    const exportRoot = join(sandbox, "exports");
    const destination = join(exportRoot, "reviewed-evidence");
    const policy = automationPolicySchema.parse({
      schemaVersion: 1,
      evidence: { exportRoots: [exportRoot] }
    });
    await exportEvidenceDrafts({
      evaluationId: report.evaluationId,
      destination,
      policy
    });
    const exported = await readFile(join(destination, `${drafts[0].kind}.yaml`), "utf8");
    expect(exported).toContain("review_status: human_reviewed");
    await expect(
      exportEvidenceDrafts({ evaluationId: report.evaluationId, destination, policy })
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects AI identities and a review manifest for the wrong hash", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-draft-review-"));
    process.env.HOME = join(sandbox, "home");
    const source = join(sandbox, "repository");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "README.md"), "# Requirement: list widgets");
    const report = await new EvaluationService().scan({
      sourcePath: source,
      ai: { requestedMode: "off" }
    });
    const [draft] = await listEvidenceDrafts(report.evaluationId);
    const manifest = join(sandbox, "ai-review.json");
    await writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        draftId: draft.draftId,
        draftSha256: "f".repeat(64),
        reviewerId: "openai-agent",
        decision: "approved",
        reviewedAt: new Date().toISOString()
      })
    );
    await expect(
      approveEvidenceDraft({ evaluationId: report.evaluationId, manifestPath: manifest })
    ).rejects.toThrow(/AI providers cannot approve/);
  });
});

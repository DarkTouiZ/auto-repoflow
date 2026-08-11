import type { EvaluationReport, Finding } from "@auto-repoflow/domain";
import { isCodeFile, isTestFilePath } from "./extract.js";
import {
  changeSetDiff,
  resolveChangeSet,
  type ChangeSet,
  type ChangeSetOptions
} from "./gitdiff.js";
import { EvaluationService } from "./service.js";
import { estimateTokens, type ArtifactSize } from "./tokens.js";

export interface ReviewOptions extends ChangeSetOptions {
  projectName?: string;
}

export interface ReviewResult {
  changeSet: ChangeSet;
  /** Findings that touch the changed files (plus all ARF-CHANGE-* findings). */
  scopedFindings: Finding[];
  /** Findings that exist in the repo but fall outside this change. */
  outOfScopeCount: number;
  changedSourceFiles: string[];
  changedTestFiles: string[];
  report: EvaluationReport;
  baselines: {
    gitDiff: ArtifactSize;
    changedFiles: ArtifactSize;
  };
}

const NON_SOURCE_SUFFIX = /(?:\.d\.ts|\.config\.[cm]?[jt]s|\.stories\.[cm]?[jt]sx?)$/;

function isReviewableSource(path: string): boolean {
  return isCodeFile(path) && !isTestFilePath(path) && !NON_SOURCE_SUFFIX.test(path);
}

function findingTouchesFiles(finding: Finding, files: Set<string>): boolean {
  return finding.evidence.some((ref) => files.has(ref.relativePath));
}

function isChangeRule(ruleId: string): boolean {
  return ruleId.startsWith("ARF-CHANGE-");
}

/**
 * Run a deterministic scan and scope its findings to a git change set, adding
 * change-oriented rules. This is the "verify what your agent just wrote" path:
 * it reports only what is relevant to the diff, and it is honest about how many
 * pre-existing findings it is deliberately hiding.
 */
export async function reviewRepository(
  service: EvaluationService,
  sourcePath: string,
  options: ReviewOptions
): Promise<ReviewResult> {
  const changeSet = await resolveChangeSet(sourcePath, options);

  const report = await service.scan({
    sourcePath,
    projectName: options.projectName,
    ai: { requestedMode: "off" },
    generateEvidence: "none"
  });

  const changedFiles = new Set(changeSet.files.map((file) => file.path));
  const changedSourceFiles = changeSet.files
    .filter((file) => file.status !== "deleted" && isReviewableSource(file.path))
    .map((file) => file.path);
  const changedTestFiles = changeSet.files
    .filter((file) => file.status !== "deleted" && isTestFilePath(file.path))
    .map((file) => file.path);

  const changeFindings: Finding[] = [];

  // ARF-CHANGE-UNTESTED-001: source changed without any test motion. One
  // finding per change set, listing the untested source files. Suppressed when
  // there are no reviewable source changes.
  if (changedSourceFiles.length > 0 && changedTestFiles.length === 0) {
    changeFindings.push({
      id: "finding:ARF-CHANGE-UNTESTED-001:changed-source-without-tests",
      ruleId: "ARF-CHANGE-UNTESTED-001",
      severity: "MEDIUM",
      status: "UNVERIFIED",
      title: `${changedSourceFiles.length} source file(s) changed with no test changes`,
      explanation:
        "Source files were modified but no test file was added or changed in this diff. Code an agent just wrote is unverified until a test exercises it.",
      evidence: changedSourceFiles.map((path) => ({
        artifactId: `change:${path}`,
        relativePath: path,
        sha256: ""
      })),
      suggestedAction:
        "Add or update a test that exercises the changed behaviour."
    });
  }

  const allFindings = [...report.findings, ...changeFindings];
  const scopedFindings = allFindings.filter(
    (finding) =>
      isChangeRule(finding.ruleId) ||
      findingTouchesFiles(finding, changedFiles)
  );
  const outOfScopeCount = allFindings.length - scopedFindings.length;

  const diffText = await changeSetDiff(changeSet, options);
  const gitDiffSize: ArtifactSize = {
    bytes: Buffer.byteLength(diffText),
    estimatedTokens: estimateTokens(diffText),
    estimator: "bytes-div-4"
  };

  // Size the full text of the changed files at their current (HEAD/worktree)
  // state — a realistic proxy for what an agent handed a diff ends up reading.
  let changedFilesBytes = 0;
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  for (const file of changeSet.files) {
    if (file.status === "deleted") continue;
    try {
      const contents = await readFile(join(changeSet.root, file.path), "utf8");
      changedFilesBytes += Buffer.byteLength(contents);
    } catch {
      // Unreadable/binary files contribute nothing to the estimate.
    }
  }
  const changedFilesSize: ArtifactSize = {
    bytes: changedFilesBytes,
    estimatedTokens: Math.ceil(changedFilesBytes / 4),
    estimator: "bytes-div-4"
  };

  return {
    changeSet,
    scopedFindings,
    outOfScopeCount,
    changedSourceFiles,
    changedTestFiles,
    report,
    baselines: {
      gitDiff: gitDiffSize,
      changedFiles: changedFilesSize
    }
  };
}

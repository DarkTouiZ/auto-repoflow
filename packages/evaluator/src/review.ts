import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EvaluationReport, Finding } from "@auto-repoflow/domain";
import { loadCoverage, uncoveredAddedLines } from "./coverage.js";
import { extractArtifacts, isCodeFile, isTestFilePath } from "./extract.js";
import { sha256 } from "./privacy.js";
import {
  addedLineRanges,
  changeSetDiff,
  resolveChangeSet,
  showBaseFile,
  type ChangeSet,
  type ChangeSetOptions
} from "./gitdiff.js";
import { EvaluationService } from "./service.js";
import { estimateTokens, type ArtifactSize } from "./tokens.js";

/**
 * Route locators (e.g. "GET /api/orders") present at the base revision within
 * the changed code files. Used to tell a newly added endpoint from a
 * pre-existing one without re-scanning the whole base tree.
 */
async function baseRouteLocators(
  changeSet: ChangeSet
): Promise<Set<string>> {
  const codeFiles = changeSet.files.filter(
    (file) => file.status !== "added" && isCodeFile(file.path)
  );
  if (codeFiles.length === 0) return new Set();
  const dir = await mkdtemp(join(tmpdir(), "arf-base-"));
  try {
    const descriptors = [];
    for (const file of codeFiles) {
      const contents = await showBaseFile(changeSet, file.path);
      if (contents === null) continue;
      const absolute = join(dir, file.path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, contents);
      descriptors.push({
        relativePath: file.path,
        sha256: sha256(contents),
        bytes: Buffer.byteLength(contents)
      });
    }
    const extracted = await extractArtifacts(dir, descriptors);
    return new Set(
      extracted.nodes
        .filter((node) => node.kind === "API_OPERATION")
        .map((node) => node.locator)
    );
  } finally {
    // The base snapshot contains repository source. Never retain it after the
    // comparison, including when extraction fails.
    await rm(dir, { recursive: true, force: true });
  }
}

export interface ReviewOptions extends ChangeSetOptions {
  projectName?: string;
  /** Explicit coverage report path; auto-discovered when omitted. */
  coveragePath?: string;
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
  return ruleId.startsWith("ARF-CHANGE-") || ruleId.startsWith("ARF-COVERAGE-");
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

  // ARF-CHANGE-COVERAGE-001: added lines a coverage report shows as never run.
  // Deterministic and guarded by staleness. It defeats the assertion-free
  // test, whose empty body contributes zero line hits, and catches changed
  // source that is absent from the coverage report entirely.
  const coverage = await loadCoverage(changeSet.root, options.coveragePath);
  if (coverage) {
    let newestChangedMtime = 0;
    for (const file of changeSet.files) {
      if (file.status === "deleted") continue;
      try {
        const info = await stat(join(changeSet.root, file.path));
        newestChangedMtime = Math.max(newestChangedMtime, info.mtimeMs);
      } catch {
        // ignore unreadable files
      }
    }
    if (coverage.generatedAt.getTime() < newestChangedMtime) {
      changeFindings.push({
        id: "finding:ARF-COVERAGE-STALE-001:coverage-older-than-changes",
        ruleId: "ARF-COVERAGE-STALE-001",
        severity: "INFO",
        status: "UNVERIFIED",
        title: "Coverage report is older than the changed files",
        explanation:
          "The coverage report predates the current changes, so line-level coverage of the diff cannot be trusted. Re-run tests with coverage to enable ARF-CHANGE-COVERAGE-001.",
        evidence: [],
        suggestedAction: "Regenerate the coverage report against the current code."
      });
    } else {
      const ranges = await addedLineRanges(changeSet, options);
      for (const path of changedSourceFiles) {
        const added = ranges.get(path) ?? [];
        if (!coverage.files.has(path)) {
          const firstAddedLine = added[0]?.[0];
          changeFindings.push({
            id: `finding:ARF-CHANGE-COVERAGE-001:${path}:missing`,
            ruleId: "ARF-CHANGE-COVERAGE-001",
            severity: "HIGH",
            status: "FAIL",
            title: `Changed source is absent from coverage: ${path}`,
            explanation:
              "The fresh coverage report contains no entry for this changed source file. A changed or newly added file outside the report is unverified even when another test file changed.",
            evidence: [
              {
                artifactId: `change:${path}`,
                relativePath: path,
                ...(firstAddedLine ? { line: firstAddedLine } : {}),
                sha256: ""
              }
            ],
            suggestedAction:
              "Run the coverage command over this file and add a test that executes the changed behaviour."
          });
          continue;
        }
        const uncovered = uncoveredAddedLines(
          coverage,
          path,
          added
        );
        if (uncovered.length > 0) {
          changeFindings.push({
            id: `finding:ARF-CHANGE-COVERAGE-001:${path}`,
            ruleId: "ARF-CHANGE-COVERAGE-001",
            severity: "HIGH",
            status: "FAIL",
            title: `${uncovered.length} added line(s) never executed in ${path}`,
            explanation:
              "These added lines are not executed by any test in the coverage report — a well-titled but assertion-free test cannot hide this.",
            evidence: [
              {
                artifactId: `change:${path}`,
                relativePath: path,
                line: uncovered[0],
                sha256: ""
              }
            ],
            suggestedAction:
              "Add a test that executes the added lines, or remove dead code."
          });
        }
      }
    }
  }

  // ARF-CHANGE-TEST-001: an endpoint added in this change that has no test.
  // A brand-new untested endpoint is higher priority than a pre-existing one.
  const baseRoutes = await baseRouteLocators(changeSet);
  const verifiedLocators = new Set(
    report.edges
      .filter((edge) => edge.kind === "VERIFIED_BY")
      .map((edge) => edge.from)
  );
  for (const node of report.nodes) {
    if (node.kind !== "API_OPERATION") continue;
    if (!changedFiles.has(node.evidence.relativePath)) continue;
    if (baseRoutes.has(node.locator)) continue; // pre-existing endpoint
    if (verifiedLocators.has(node.id)) continue; // already tested
    changeFindings.push({
      id: `finding:ARF-CHANGE-TEST-001:${node.locator}`,
      ruleId: "ARF-CHANGE-TEST-001",
      severity: "HIGH",
      status: "FAIL",
      title: `New endpoint has no test: ${node.locator}`,
      explanation:
        "This endpoint was added in the current change and no test exercises it. New endpoints an agent writes are the most likely to ship untested.",
      evidence: [node.evidence],
      suggestedAction: "Add an operation-level test for the new endpoint."
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

import type {
  ArtifactNode,
  CoverageMetric,
  EvaluationReport,
  Finding,
  TraceEdge
} from "@auto-repoflow/domain";
import { randomUUID } from "node:crypto";
import type { ExtractedArtifacts } from "./extract.js";
import type { SnapshotManifest } from "./privacy.js";

function percent(covered: number, total: number): number {
  return total === 0 ? 0 : Math.round((covered / total) * 1000) / 10;
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(
        (part) =>
          part.length >= 3 &&
          ![
            "api",
            "param",
            "backoffice",
            "get",
            "post",
            "put",
            "patch",
            "delete"
          ].includes(part)
      )
  );
}

function overlap(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  const common = [...a].filter((value) => b.has(value)).length;
  return common / Math.max(a.size, b.size);
}

function normalizedScenario(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isDeferredScenarioStatus(value: unknown): boolean {
  const status = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return [
    "deferred",
    "deferred_future",
    "future",
    "external",
    "out_of_scope"
  ].includes(status);
}

function finding(
  ruleId: string,
  status: Finding["status"],
  title: string,
  explanation: string,
  evidence: Finding["evidence"],
  suggestedAction?: string
): Finding {
  return {
    id: `finding:${ruleId}:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    ruleId,
    severity: status === "FAIL" ? "HIGH" : "MEDIUM",
    status,
    title,
    explanation,
    evidence,
    suggestedAction
  };
}

function makeEdge(
  kind: TraceEdge["kind"],
  from: ArtifactNode,
  to: ArtifactNode,
  confidence: number,
  rationale: string
): TraceEdge {
  return {
    id: `edge:${kind}:${from.id}:${to.id}`,
    kind,
    from: from.id,
    to: to.id,
    confidence,
    source: "RULE",
    status: confidence >= 0.85 ? "PASS" : "HUMAN_REVIEW_REQUIRED",
    rationale
  };
}

function apiOperationMatch(
  route: ArtifactNode,
  requirement: ArtifactNode
): number {
  const routeMethod = String(route.attributes?.method ?? "");
  const requirementMethod = String(requirement.attributes?.method ?? "");
  const routePath = String(route.attributes?.path ?? "");
  const requirementPath = String(requirement.attributes?.path ?? "");
  if (!routeMethod || routeMethod !== requirementMethod) return 0;
  if (routePath === requirementPath) return 1;
  if (routePath === "/" || requirementPath === "/") return 0;
  const routeParts = routePath.split("/").filter(Boolean);
  const requirementParts = requirementPath.split("/").filter(Boolean);
  const segmentsMatch = (left: string, right: string) =>
    left === right || left === ":param" || right === ":param";
  if (
    routeParts.length === requirementParts.length &&
    routeParts.every((part, index) =>
      segmentsMatch(part, requirementParts[index])
    )
  ) {
    return 1;
  }
  const comparable = Math.min(routeParts.length, requirementParts.length);
  if (comparable < 1) return 0;
  let matchingSuffix = 0;
  for (let offset = 1; offset <= comparable; offset += 1) {
    if (
      !segmentsMatch(
        routeParts.at(-offset) ?? "",
        requirementParts.at(-offset) ?? ""
      )
    ) {
      break;
    }
    matchingSuffix += 1;
  }
  const shorterLength = Math.min(routeParts.length, requirementParts.length);
  if (matchingSuffix === shorterLength) return 0.85;
  return 0;
}

function isDraftReviewStatus(value: unknown): boolean {
  const status = String(value ?? "").toLowerCase();
  return status.startsWith("draft") || status.includes("requires_review");
}

export function buildEvaluationReport(input: {
  evaluationId: string;
  projectName: string;
  mode: "rules" | "local-ai";
  manifest: SnapshotManifest;
  extracted: ExtractedArtifacts;
  scopePrefix?: string;
}): EvaluationReport {
  const { nodes, routePaths, postmanPaths } = input.extracted;
  const allRoutes = nodes.filter(
    (item) =>
      item.kind === "API_OPERATION" &&
      item.attributes?.source === "express-route"
  );
  const allRequirements = nodes.filter(
    (item) =>
      item.kind === "REQUIREMENT" && item.attributes?.source === "postman"
  );
  const inScope = (item: ArtifactNode): boolean => {
    if (!input.scopePrefix) return true;
    return String(item.attributes?.path ?? "").startsWith(input.scopePrefix);
  };
  const routes = allRoutes.filter(inScope);
  const requirements = allRequirements.filter(inScope);
  const reviewedRequirements = requirements.filter(
    (item) => !isDraftReviewStatus(item.attributes?.reviewStatus)
  );
  const draftRequirements = requirements.filter((item) =>
    isDraftReviewStatus(item.attributes?.reviewStatus)
  );
  const tests = nodes.filter(
    (item) =>
      item.kind === "TEST_CASE" && item.attributes?.source === "test"
  );
  const plannedTests = nodes.filter(
    (item) =>
      item.kind === "TEST_CASE" && item.attributes?.source === "test-plan"
  );
  const roadmapScenarios = nodes.filter(
    (item) =>
      item.kind === "TEST_CASE" &&
      item.attributes?.source === "test-plan-scenario" &&
      !isDraftReviewStatus(item.attributes?.reviewStatus) &&
      (!input.scopePrefix ||
        String(item.attributes?.apiOperation ?? "").includes(input.scopePrefix))
  );
  const plannedScenarios = roadmapScenarios.filter(
    (item) => !isDeferredScenarioStatus(item.attributes?.scenarioStatus)
  );
  const symbols = nodes.filter((item) => item.kind === "CODE_SYMBOL");
  const findings: Finding[] = [];
  const edges: TraceEdge[] = [];

  let routeWithSpec = 0;
  let routeWithAnySpec = 0;
  let routeWithTest = 0;
  let routeWithTestPlan = 0;
  let plannedScenarioWithTest = 0;
  let roadmapScenarioWithTest = 0;
  let routeWithImplementation = 0;
  let actionsWithApi = 0;
  const screens = nodes.filter((item) => item.kind === "SCREEN");
  const states = nodes.filter((item) => item.kind === "UI_STATE");
  const approvedReviewStatuses = new Set([
    "human_reviewed",
    "approved_for_synthetic_benchmark"
  ]);
  const draftScreens = screens.filter(
    (screen) =>
      !approvedReviewStatuses.has(String(screen.attributes?.reviewStatus ?? ""))
  );
  if (draftScreens.length > 0) {
    findings.push(
      finding(
        "ARF-DESIGN-001",
        "HUMAN_REVIEW_REQUIRED",
        "Design-flow mapping is still a draft",
        "UI-to-API links were inferred from static design evidence and require human approval.",
        [
          ...new Map(
            draftScreens.map((screen) => [
              screen.evidence.artifactId,
              screen.evidence
            ])
          ).values()
        ],
        "Review each action and mark the design flow as human_reviewed."
      )
    );
  }

  for (const screen of screens) {
    if (
      screen.attributes?.acceptanceCriteriaRequired === true &&
      screen.attributes?.acceptanceCriteriaCount === 0
    ) {
      findings.push(
        finding(
          "ARF-ACCEPTANCE-001",
          "UNVERIFIED",
          `Acceptance criteria are absent: ${screen.name}`,
          "The reviewed design flow marks acceptance criteria as required but none are recorded.",
          [screen.evidence],
          "Review and record testable acceptance criteria with the product and engineering team."
        )
      );
    }
  }

  for (const action of nodes.filter((item) => item.kind === "UI_ACTION")) {
    const operation =
      typeof action.attributes?.apiOperation === "string"
        ? action.attributes.apiOperation
        : undefined;
    const route = operation
      ? routes.find((candidate) => candidate.locator === operation)
      : undefined;
    if (route) {
      actionsWithApi += 1;
      const reviewStatus = String(action.attributes?.reviewStatus ?? "");
      const reviewed = approvedReviewStatuses.has(reviewStatus);
      edges.push(
        makeEdge(
          "TRIGGERS",
          action,
          route,
          reviewed ? 1 : 0.6,
          reviewed
            ? "Reviewed design-flow declares the exact API operation"
            : "Draft design-flow declares the operation; human approval is required"
        )
      );
    } else {
      findings.push(
        finding(
          "ARF-UI-001",
          "UNVERIFIED",
          `UI action is not connected: ${action.name}`,
          operation
            ? `The declared operation ${operation} was not found in implemented routes.`
            : "The reviewed design flow does not declare an API operation for this action.",
          [action.evidence],
          "Confirm whether the action is local-only, external/future, or served by an API."
        )
      );
    }
    if (
      action.attributes?.responseMappingRequired === true &&
      action.attributes?.responseFieldCount === 0
    ) {
      findings.push(
        finding(
          "ARF-DATA-001",
          "UNVERIFIED",
          `Response-to-screen mapping is absent: ${action.name}`,
          "This UI action requires response-field mapping, but no reviewed fields are recorded.",
          [action.evidence],
          "Map visible UI values to response fields and data entities."
        )
      );
    }
    const screenId =
      typeof action.attributes?.screen === "string"
        ? action.attributes.screen
        : "";
    const screenStates = states
      .filter((state) => state.attributes?.screen === screenId)
      .map((state) => state.name.toLowerCase());
    if (
      action.attributes?.confirmationRequired === true &&
      !screenStates.some((state) => state.includes("confirm"))
    ) {
      findings.push(
        finding(
          "ARF-UI-STATE-001",
          "UNVERIFIED",
          `Confirmation state is absent: ${action.name}`,
          "The action is marked confirmation-required but the screen has no reviewed confirmation state.",
          [action.evidence]
        )
      );
    }
    if (
      action.attributes?.permissionStateRequired === true &&
      !screenStates.some((state) => state.includes("permission"))
    ) {
      findings.push(
        finding(
          "ARF-UI-STATE-001",
          "UNVERIFIED",
          `Permission state is absent: ${action.name}`,
          "The action is marked permission-sensitive but the screen has no reviewed permission state.",
          [action.evidence]
        )
      );
    }
  }

  for (const route of routes) {
    const operation = route.locator;
    const requirementMatch = reviewedRequirements
      .map((requirement) => ({
        requirement,
        score: apiOperationMatch(route, requirement)
      }))
      .sort((a, b) => b.score - a.score)[0];
    if (requirementMatch && requirementMatch.score > 0) {
      routeWithSpec += 1;
      routeWithAnySpec += 1;
      edges.push(
        makeEdge(
          "SERVED_BY",
          requirementMatch.requirement,
          route,
          requirementMatch.score,
          requirementMatch.score === 1
            ? "Exact method and normalized path"
            : "Method and mounted-route suffix match"
        )
      );
    } else {
      const draftMatch = draftRequirements
        .map((requirement) => ({
          requirement,
          score: apiOperationMatch(route, requirement)
        }))
        .sort((a, b) => b.score - a.score)[0];
      if (draftMatch && draftMatch.score > 0) {
        routeWithAnySpec += 1;
        edges.push(
          makeEdge(
            "SERVED_BY",
            draftMatch.requirement,
            route,
            0.6,
            "Draft API specification matches the implemented route and requires API-owner review"
          )
        );
        findings.push(
          finding(
            "ARF-API-DRAFT-001",
            "HUMAN_REVIEW_REQUIRED",
            `Draft API specification requires review for ${operation}`,
            "A generated Postman request closes the structural gap but is not approved specification evidence.",
            [route.evidence, draftMatch.requirement.evidence],
            "Review request parameters, headers, response shape, errors, and examples."
          )
        );
      } else {
        findings.push(
          finding(
            "ARF-API-001",
            "UNVERIFIED",
            `No API specification evidence for ${operation}`,
            "An implemented route has no matching Postman request by method and normalized path.",
            [route.evidence],
            "Add or review a matching API specification request."
          )
        );
      }
    }

    const implementation = symbols
      .map((symbol) => ({
        symbol,
        score:
          symbol.attributes?.operation === route.locator
            ? 1
            : overlap(route.locator, symbol.locator)
      }))
      .sort((a, b) => b.score - a.score)[0];
    if (implementation && implementation.score > 0) {
      routeWithImplementation += 1;
      edges.push(
        makeEdge(
          "IMPLEMENTED_BY",
          route,
          implementation.symbol,
          Math.max(0.5, implementation.score),
          "Shared route and code-symbol vocabulary"
        )
      );
    } else {
      findings.push(
        finding(
          "ARF-CODE-001",
          "HUMAN_REVIEW_REQUIRED",
          `Implementation chain needs review for ${operation}`,
          "The rules engine could not link this route to a named code symbol.",
          [route.evidence]
        )
      );
    }

    const test = tests
      .map((candidate) => ({
        candidate,
        score:
          candidate.attributes?.method && candidate.attributes?.path
            ? apiOperationMatch(route, candidate)
            : overlap(route.locator, candidate.name)
      }))
      .sort((a, b) => b.score - a.score)[0];
    if (test && test.score > 0) {
      routeWithTest += 1;
      edges.push(
        makeEdge(
          "VERIFIED_BY",
          route,
          test.candidate,
          Math.max(0.5, test.score),
          test.candidate.attributes?.operation
            ? "Exact HTTP method and normalized path from the test title"
            : "Shared operation and test vocabulary"
        )
      );
    } else {
      findings.push(
        finding(
          "ARF-TEST-001",
          "UNVERIFIED",
          `No test evidence for ${operation}`,
          "No test title can be linked to this API operation. This is not treated as a pass.",
          [route.evidence],
          "Add an operation-level unit or integration test."
        )
      );
    }

    const plannedTest = plannedTests.find(
      (candidate) => candidate.attributes?.apiOperation === route.locator
    );
    if (plannedTest) {
      routeWithTestPlan += 1;
      const reviewedPlan = !isDraftReviewStatus(
        plannedTest.attributes?.reviewStatus
      );
      edges.push(
        makeEdge(
          "REQUIRES",
          route,
          plannedTest,
          reviewedPlan ? 1 : 0.6,
          reviewedPlan
            ? "Reviewed test plan covers this operation"
            : "Draft test plan covers this operation and requires team review"
        )
      );
    }
  }

  for (const requirement of requirements) {
    const operation = String(requirement.attributes?.operation ?? requirement.name);
    if (routes.some((route) => apiOperationMatch(route, requirement) > 0)) continue;
    const draft = isDraftReviewStatus(requirement.attributes?.reviewStatus);
    findings.push(
      finding(
        draft ? "ARF-API-DRAFT-002" : "ARF-API-002",
        draft ? "HUMAN_REVIEW_REQUIRED" : "FAIL",
        `${draft ? "Draft specified" : "Specified"} operation not found: ${operation}`,
        draft
          ? "A draft Postman operation has no implemented route and requires scope review."
          : "A Postman operation has no exact implemented route in the snapshot.",
        [requirement.evidence],
        draft
          ? "Confirm the route or classify the draft request as external/future."
          : "Implement the route or mark the request as external/future."
      )
    );
  }

  for (const plannedScenario of roadmapScenarios) {
    const operation = String(plannedScenario.attributes?.apiOperation ?? "");
    const scenario = normalizedScenario(plannedScenario.attributes?.scenario);
    const deferred = isDeferredScenarioStatus(
      plannedScenario.attributes?.scenarioStatus
    );
    const executableTest = tests.find(
      (candidate) =>
        String(candidate.attributes?.operation ?? "") === operation &&
        normalizedScenario(candidate.attributes?.scenario) === scenario
    );
    if (executableTest) {
      roadmapScenarioWithTest += 1;
      if (!deferred) {
        plannedScenarioWithTest += 1;
      }
      edges.push(
        makeEdge(
          "VERIFIED_BY",
          plannedScenario,
          executableTest,
          1,
          "Exact API operation and reviewed scenario label"
        )
      );
    } else if (!deferred) {
      findings.push(
        finding(
          "ARF-TEST-SCENARIO-001",
          "UNVERIFIED",
          `No executable test for planned scenario: ${plannedScenario.name}`,
          "The reviewed scenario is not linked to an executable test title. Todo and skipped tests are not treated as coverage.",
          [plannedScenario.evidence],
          "Implement the scenario or record the external boundary that blocks it."
        )
      );
    }
  }

  const qualityNodes = nodes.filter((item) => item.kind === "QUALITY_CHECK");
  for (const required of ["test", "build"]) {
    if (
      qualityNodes.some(
        (item) =>
          item.name === required || item.name.startsWith(`${required}:`)
      )
    ) {
      continue;
    }
    findings.push(
      finding(
        "ARF-QUALITY-001",
        "FAIL",
        `Missing ${required} quality command`,
        `The root package does not expose a ${required} script.`,
        [],
        `Add a deterministic npm ${required} script.`
      )
    );
  }
  if (!qualityNodes.some((item) => /lint|typecheck/.test(item.name))) {
    findings.push(
      finding(
        "ARF-QUALITY-002",
        "UNVERIFIED",
        "Static analysis is not evidenced",
        "No root lint or typecheck command was found.",
        [],
        "Expose a runnable lint or typecheck command in the root package."
      )
    );
  }
  const ciNodes = qualityNodes.filter(
    (item) => item.attributes?.source === "ci-workflow"
  );
  if (
    routePaths.size > 0 &&
    (ciNodes.length === 0 ||
      !ciNodes.some((item) => item.attributes?.containsContractCheck === true))
  ) {
    findings.push(
      finding(
        "ARF-CI-001",
        "UNVERIFIED",
        "API contract check is absent from CI",
        "No CI workflow evidence references an API contract, OpenAPI, or Postman check.",
        ciNodes.map((item) => item.evidence),
        "Add a deterministic API contract validation step to CI."
      )
    );
  }

  const coverage: CoverageMetric[] = [
    {
      id: "api-spec",
      label: "Routes with reviewed API specification",
      covered: routeWithSpec,
      total: routes.length,
      percentage: percent(routeWithSpec, routes.length)
    },
    {
      id: "api-spec-readiness",
      label: "Routes with reviewed or draft API specification",
      covered: routeWithAnySpec,
      total: routes.length,
      percentage: percent(routeWithAnySpec, routes.length)
    },
    {
      id: "implementation",
      label: "Routes linked to implementation",
      covered: routeWithImplementation,
      total: routes.length,
      percentage: percent(routeWithImplementation, routes.length)
    },
    {
      id: "test",
      label: "Routes linked to executable tests",
      covered: routeWithTest,
      total: routes.length,
      percentage: percent(routeWithTest, routes.length)
    },
    {
      id: "test-plan",
      label: "Routes covered by a test plan",
      covered: routeWithTestPlan,
      total: routes.length,
      percentage: percent(routeWithTestPlan, routes.length)
    },
    {
      id: "test-scenario",
      label: "Current-scope reviewed scenarios linked to executable tests",
      covered: plannedScenarioWithTest,
      total: plannedScenarios.length,
      percentage: percent(plannedScenarioWithTest, plannedScenarios.length)
    },
    {
      id: "test-scenario-roadmap",
      label: "Full-roadmap reviewed scenarios linked to executable tests",
      covered: roadmapScenarioWithTest,
      total: roadmapScenarios.length,
      percentage: percent(roadmapScenarioWithTest, roadmapScenarios.length)
    },
    {
      id: "ui-api",
      label: "UI actions linked to API",
      covered: actionsWithApi,
      total: nodes.filter((item) => item.kind === "UI_ACTION").length,
      percentage: percent(
        actionsWithApi,
        nodes.filter((item) => item.kind === "UI_ACTION").length
      )
    }
  ];

  const languageByExtension: Record<string, string> = {
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "typescript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".swift": "swift"
  };
  const detectedLanguages = [
    ...new Set(
      input.manifest.files
        .map((file) => {
          const match = file.relativePath.toLowerCase().match(/\.[a-z0-9]+$/);
          return match ? languageByExtension[match[0]] : undefined;
        })
        .filter((value): value is string => Boolean(value))
    )
  ].sort();
  const hasCertifiedLanguage = detectedLanguages.some((language) =>
    ["javascript", "typescript"].includes(language)
  );
  const hasUnsupportedLanguage = detectedLanguages.some(
    (language) => !["javascript", "typescript"].includes(language)
  );
  const languageStatus = hasCertifiedLanguage
    ? hasUnsupportedLanguage
      ? "partial"
      : "supported"
    : "unsupported";
  if (languageStatus !== "supported") {
    findings.push({
      id: `finding:ARF-LANGUAGE-001:${languageStatus}`,
      ruleId: "ARF-LANGUAGE-001",
      severity: "INFO",
      status: "UNVERIFIED",
      title:
        languageStatus === "partial"
          ? "Repository contains languages outside stable v0.2 coverage"
          : "No JavaScript or TypeScript source was detected",
      explanation:
        "Auto-RepoFlow v0.2 certifies extraction coverage only for JavaScript and TypeScript; other language results must not be interpreted as complete coverage.",
      evidence: [],
      suggestedAction:
        "Treat this report as partial/unsupported and review language-specific evidence manually."
    });
  }
  const statuses = [...edges.map((item) => item.status), ...findings.map((item) => item.status)];
  const evidenceMaturity = nodes.reduce(
    (summary, item) => {
      const source = String(item.attributes?.source ?? "");
      const reviewStatus = String(item.attributes?.reviewStatus ?? "");
      if (["human_reviewed", "approved_for_synthetic_benchmark"].includes(reviewStatus)) {
        summary.reviewed += 1;
      } else if (source.startsWith("generated-")) {
        summary.generated += 1;
      } else if (
        [
          "postman",
          "mermaid-erd",
          "world-contract",
          "test-plan",
          "test-plan-scenario",
          "reviewed-design-flow",
          "markdown-requirement",
          "openapi"
        ].includes(source)
      ) {
        summary.declared += 1;
      } else {
        summary.observed += 1;
      }
      return summary;
    },
    {
      observed: 0,
      declared: 0,
      generated: 0,
      reviewed: 0,
      unresolvedReviewGates: findings.filter(
        (item) => item.status === "HUMAN_REVIEW_REQUIRED"
      ).length
    }
  );
  return {
    schemaVersion: 2,
    evaluationId: input.evaluationId,
    projectName: input.projectName,
    mode: input.mode,
    status: "REPORT_READY",
    createdAt: new Date().toISOString(),
    snapshotSha256: input.manifest.manifestSha256,
    nodes,
    edges,
    findings,
    coverage,
    privacy: {
      sourceRootStored: false,
      includedFiles: input.manifest.files.length,
      excludedFiles: input.manifest.decisions.filter(
        (item) => item.decision === "EXCLUDED"
      ).length,
      decisionsFile: "manifest.json",
      publicExportSafe: true
    },
    summary: {
      pass: statuses.filter((item) => item === "PASS").length,
      fail: statuses.filter((item) => item === "FAIL").length,
      unverified: statuses.filter((item) => item === "UNVERIFIED").length,
      humanReviewRequired: statuses.filter(
        (item) => item === "HUMAN_REVIEW_REQUIRED"
      ).length
    },
    aiExecution: {
      requestedMode: "off",
      provider: null,
      model: null,
      status: "disabled",
      fallbackUsed: false,
      batches: 0,
      suggestionsReceived: 0,
      suggestionsAccepted: 0,
      suggestionsRejected: 0,
      durationMs: 0,
      promptVersion: "arf-semantic-links-v2",
      outputSchemaVersion: 1,
      payloadSha256: null
    },
    evidenceMaturity,
    languageSupport: {
      certified: ["javascript", "typescript"],
      detected: detectedLanguages,
      status: languageStatus
    }
  };
}

export function createPublicReport(report: EvaluationReport) {
  return {
    schemaVersion: 2,
    evaluationId: `public-${randomUUID()}`,
    project: "anonymized-project",
    mode: report.mode,
    status: report.status,
    createdAt: report.createdAt,
    coverage: report.coverage.map(({ id, label, covered, total, percentage }) => ({
      id,
      label,
      covered,
      total,
      percentage
    })),
    findingsByStatus: {
      fail: report.summary.fail,
      unverified: report.summary.unverified,
      humanReviewRequired: report.summary.humanReviewRequired
    },
    ai: {
      requestedMode: report.aiExecution.requestedMode,
      provider: report.aiExecution.provider,
      status: report.aiExecution.status,
      fallbackUsed: report.aiExecution.fallbackUsed
    },
    evidenceMaturity: report.evidenceMaturity,
    languageSupport: report.languageSupport,
    privacy: {
      companyIdentifiers: 0,
      sourcePaths: 0,
      endpoints: 0,
      tablesAndFields: 0,
      screenshots: 0,
      codeExcerpts: 0
    }
  };
}

export function createCompatibleReport(
  report: EvaluationReport,
  compat: "v1" | "v2"
): EvaluationReport | Omit<
  EvaluationReport,
  "schemaVersion" | "aiExecution" | "evidenceMaturity" | "languageSupport"
> & { schemaVersion: 1 } {
  if (compat === "v2") return report;
  const {
    aiExecution: _aiExecution,
    evidenceMaturity: _evidenceMaturity,
    languageSupport: _languageSupport,
    ...legacy
  } = report;
  return { ...legacy, schemaVersion: 1 };
}

export interface KnownGapLedgerV1 {
  schemaVersion: 1;
  gaps: Array<{ id: string; ruleId: string; subject: string }>;
}

export interface KnownGapLedgerV2 {
  schemaVersion: 2;
  gaps: Array<{
    id: string;
    ruleId: string;
    subject: string;
    findingId: string;
  }>;
}

export type KnownGapLedger = KnownGapLedgerV1 | KnownGapLedgerV2;

export function scoreKnownGaps(
  report: EvaluationReport,
  ledger: KnownGapLedger
) {
  if (ledger.schemaVersion === 2) {
    const gapIds = ledger.gaps.map((gap) => gap.id);
    const expectedFindingIds = ledger.gaps.map((gap) => gap.findingId);
    if (new Set(gapIds).size !== gapIds.length) {
      throw new Error("Known-gap ledger contains duplicate gap IDs");
    }
    if (new Set(expectedFindingIds).size !== expectedFindingIds.length) {
      throw new Error("Known-gap ledger contains duplicate finding IDs");
    }

    const expectedByFindingId = new Map(
      ledger.gaps.map((gap) => [gap.findingId, gap])
    );
    const detectedFindingIds = new Set(report.findings.map((item) => item.id));
    const matchedGaps = ledger.gaps.filter((gap) =>
      detectedFindingIds.has(gap.findingId)
    );
    const unexpectedFindingIds = report.findings
      .filter((item) => !expectedByFindingId.has(item.id))
      .map((item) => item.id);
    const missedGapIds = ledger.gaps
      .filter((gap) => !detectedFindingIds.has(gap.findingId))
      .map((gap) => gap.id);
    const truePositive = matchedGaps.length;
    const falsePositive = unexpectedFindingIds.length;
    const falseNegative = missedGapIds.length;
    return {
      ledgerSchemaVersion: ledger.schemaVersion,
      matchMode: "finding-id" as const,
      expected: ledger.gaps.length,
      detected: report.findings.length,
      truePositive,
      falsePositive,
      falseNegative,
      precision: percent(truePositive, truePositive + falsePositive),
      recall: percent(truePositive, truePositive + falseNegative),
      matchedGapIds: matchedGaps.map((gap) => gap.id),
      missedGapIds,
      unexpectedFindingIds
    };
  }

  const expectedByRule = new Map<string, number>();
  const detectedByRule = new Map<string, number>();
  for (const gap of ledger.gaps) {
    expectedByRule.set(gap.ruleId, (expectedByRule.get(gap.ruleId) ?? 0) + 1);
  }
  for (const item of report.findings) {
    detectedByRule.set(
      item.ruleId,
      (detectedByRule.get(item.ruleId) ?? 0) + 1
    );
  }
  const truePositive = [...expectedByRule].reduce(
    (total, [ruleId, count]) =>
      total + Math.min(count, detectedByRule.get(ruleId) ?? 0),
    0
  );
  const detected = [...detectedByRule.values()].reduce(
    (total, value) => total + value,
    0
  );
  const expected = ledger.gaps.length;
  const falsePositive = Math.max(0, detected - truePositive);
  const falseNegative = Math.max(0, expected - truePositive);
  return {
    ledgerSchemaVersion: ledger.schemaVersion,
    matchMode: "rule-count" as const,
    expected,
    detected,
    truePositive,
    falsePositive,
    falseNegative,
    precision: percent(truePositive, truePositive + falsePositive),
    recall: percent(truePositive, truePositive + falseNegative)
  };
}

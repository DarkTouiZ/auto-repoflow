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
    status: confidence >= 0.5 ? "PASS" : "HUMAN_REVIEW_REQUIRED",
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
  const tests = nodes.filter((item) => item.kind === "TEST_CASE");
  const symbols = nodes.filter((item) => item.kind === "CODE_SYMBOL");
  const findings: Finding[] = [];
  const edges: TraceEdge[] = [];

  let routeWithSpec = 0;
  let routeWithTest = 0;
  let routeWithImplementation = 0;
  let actionsWithApi = 0;
  const screens = nodes.filter((item) => item.kind === "SCREEN");
  const states = nodes.filter((item) => item.kind === "UI_STATE");

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
      edges.push(
        makeEdge(
          "TRIGGERS",
          action,
          route,
          1,
          "Reviewed design-flow declares the exact API operation"
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
    const requirementMatch = requirements
      .map((requirement) => ({
        requirement,
        score: apiOperationMatch(route, requirement)
      }))
      .sort((a, b) => b.score - a.score)[0];
    if (requirementMatch && requirementMatch.score > 0) {
      routeWithSpec += 1;
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
      .map((candidate) => ({ candidate, score: overlap(route.locator, candidate.name) }))
      .sort((a, b) => b.score - a.score)[0];
    if (test && test.score > 0) {
      routeWithTest += 1;
      edges.push(
        makeEdge(
          "VERIFIED_BY",
          route,
          test.candidate,
          Math.max(0.5, test.score),
          "Shared operation and test vocabulary"
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
  }

  for (const requirement of requirements) {
    const operation = String(requirement.attributes?.operation ?? requirement.name);
    if (routes.some((route) => apiOperationMatch(route, requirement) > 0)) continue;
    findings.push(
      finding(
        "ARF-API-002",
        "FAIL",
        `Specified operation not found: ${operation}`,
        "A Postman operation has no exact implemented route in the snapshot.",
        [requirement.evidence],
        "Implement the route or mark the request as external/future."
      )
    );
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
    ciNodes.length === 0 ||
    !ciNodes.some((item) => item.attributes?.containsContractCheck === true)
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
      label: "Routes with API specification",
      covered: routeWithSpec,
      total: routes.length,
      percentage: percent(routeWithSpec, routes.length)
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
      label: "Routes linked to tests",
      covered: routeWithTest,
      total: routes.length,
      percentage: percent(routeWithTest, routes.length)
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

  const statuses = [...edges.map((item) => item.status), ...findings.map((item) => item.status)];
  return {
    schemaVersion: 1,
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
    }
  };
}

export function createPublicReport(report: EvaluationReport) {
  return {
    schemaVersion: 1,
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

export interface KnownGapLedger {
  schemaVersion: 1;
  gaps: Array<{ id: string; ruleId: string; subject: string }>;
}

export function scoreKnownGaps(
  report: EvaluationReport,
  ledger: KnownGapLedger
) {
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
    expected,
    detected,
    truePositive,
    falsePositive,
    falseNegative,
    precision: percent(truePositive, truePositive + falsePositive),
    recall: percent(truePositive, truePositive + falseNegative)
  };
}

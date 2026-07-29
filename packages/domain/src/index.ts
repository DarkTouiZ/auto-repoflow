export const runStatuses = [
  "REGISTERING",
  "WORLD_DRAFT",
  "WORLD_REVIEW_REQUIRED",
  "READY",
  "INTAKE",
  "NEEDS_CLARIFICATION",
  "IMPACT",
  "PLANNING",
  "PLAN_APPROVAL_REQUIRED",
  "IMPLEMENTING",
  "VERIFYING",
  "REPAIRING",
  "REVIEW_REQUIRED",
  "READY_FOR_PR",
  "CREATING_DRAFT_PR",
  "DRAFT_PR_CREATED",
  "FAILED",
  "CANCELLED"
] as const;

export type RunStatus = (typeof runStatuses)[number];

export const terminalStatuses = [
  "DRAFT_PR_CREATED",
  "FAILED",
  "CANCELLED"
] as const satisfies readonly RunStatus[];

export function isTerminalStatus(status: RunStatus): boolean {
  return terminalStatuses.includes(status as (typeof terminalStatuses)[number]);
}

export function isSuccessfulStatus(status: RunStatus): boolean {
  return status === "DRAFT_PR_CREATED";
}

export const evaluationStatuses = [
  "REGISTERED",
  "SNAPSHOTTING",
  "READY",
  "EXTRACTING",
  "LINKING",
  "VERIFYING",
  "REPORT_READY",
  "FAILED"
] as const;

export type EvaluationStatus = (typeof evaluationStatuses)[number];

export const artifactNodeKinds = [
  "REQUIREMENT",
  "SCREEN",
  "UI_ACTION",
  "UI_STATE",
  "DATA_ENTITY",
  "API_OPERATION",
  "CODE_SYMBOL",
  "TEST_CASE",
  "QUALITY_CHECK",
  "WORLD_CONTRACT"
] as const;

export type ArtifactNodeKind = (typeof artifactNodeKinds)[number];

export const traceEdgeKinds = [
  "REQUIRES",
  "TRIGGERS",
  "SERVED_BY",
  "READS",
  "WRITES",
  "IMPLEMENTED_BY",
  "VERIFIED_BY"
] as const;

export type TraceEdgeKind = (typeof traceEdgeKinds)[number];
export type EvidenceStatus =
  | "PASS"
  | "FAIL"
  | "UNVERIFIED"
  | "HUMAN_REVIEW_REQUIRED";

export interface EvidenceRef {
  artifactId: string;
  relativePath: string;
  line?: number;
  sha256: string;
}

export interface ArtifactNode {
  id: string;
  kind: ArtifactNodeKind;
  name: string;
  locator: string;
  evidence: EvidenceRef;
  attributes?: Record<string, string | number | boolean>;
}

export interface TraceEdge {
  id: string;
  kind: TraceEdgeKind;
  from: string;
  to: string;
  confidence: number;
  source: "RULE" | "LOCAL_AI" | "HUMAN";
  status: EvidenceStatus;
  rationale: string;
}

export interface Finding {
  id: string;
  ruleId: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH";
  status: EvidenceStatus;
  title: string;
  explanation: string;
  evidence: EvidenceRef[];
  suggestedAction?: string;
}

export interface CoverageMetric {
  id: string;
  label: string;
  covered: number;
  total: number;
  percentage: number;
}

export interface PrivacyDecision {
  relativePath: string;
  decision: "INCLUDED" | "EXCLUDED";
  reason: string;
}

export interface EvaluationReport {
  schemaVersion: 1;
  evaluationId: string;
  projectName: string;
  mode: "rules" | "local-ai";
  status: "REPORT_READY";
  createdAt: string;
  snapshotSha256: string;
  nodes: ArtifactNode[];
  edges: TraceEdge[];
  findings: Finding[];
  coverage: CoverageMetric[];
  privacy: {
    sourceRootStored: false;
    includedFiles: number;
    excludedFiles: number;
    decisionsFile: string;
    publicExportSafe: boolean;
  };
  summary: {
    pass: number;
    fail: number;
    unverified: number;
    humanReviewRequired: number;
  };
}

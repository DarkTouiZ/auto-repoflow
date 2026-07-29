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

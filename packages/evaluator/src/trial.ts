import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  changeRunStatus,
  readChangeOutcomeReport,
  startChangeRun,
  verifyChangeRun
} from "./change.js";
import {
  createMileMeshFixture,
  DEMO_CHANGE_POLICY,
  type MileMeshScenario
} from "./fixtures.js";
import { getPrivateRoot } from "./privacy.js";

const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

type TrialMode = "assisted" | "unassisted";
type TrialSessionStatus =
  | "PREPARED"
  | "AWAITING_AGENT"
  | "VERIFYING"
  | "REPAIR_REQUIRED"
  | "VERIFIED"
  | "REVIEWED"
  | "FAILED";

interface TrialReview {
  reviewerToken: string;
  decision: "accept" | "reject";
  patchSha256: string;
  reviewedAt: string;
}

interface TrialOutcome {
  verificationPassed: boolean;
  targetClosed: boolean;
  noNewRegression: boolean;
  requiredChecks: number;
  passedChecks: number;
  patchSha256: string;
  filesChanged: number;
  attempts: number;
  repairAttempts: number;
}

interface TrialSession {
  id: string;
  participantToken: string;
  mode: TrialMode;
  scenario: MileMeshScenario;
  status: TrialSessionStatus;
  sourcePath: string;
  changeId?: string;
  worktreePath?: string;
  fixPacketPath?: string;
  promptPath?: string;
  agentLabel?: string;
  setupLatencyMs?: number;
  verificationLatencyMs: number;
  workDurationMs: number;
  workStartedAt?: string;
  outcome?: TrialOutcome;
  review?: TrialReview;
}

interface TrialStudy {
  schemaVersion: 1;
  studyId: string;
  createdAt: string;
  updatedAt: string;
  sessions: TrialSession[];
}

export interface TrialRunResult {
  studyId: string;
  sessionId: string;
  mode: TrialMode;
  scenario: MileMeshScenario;
  phase: "AWAITING_AGENT" | "REPAIR_REQUIRED" | "VERIFIED" | "FAILED";
  task?: string;
  worktreePath?: string;
  fixPacketPath?: string;
  promptPath?: string;
  workDurationMs?: number;
  verificationLatencyMs?: number;
  repairAttempts?: number;
}

function assertToken(value: string, label: string): string {
  if (!tokenPattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function normalizeAgentLabel(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  if (!normalized) throw new Error("Trial agent label is invalid");
  return normalized;
}

async function studyRoot(studyId: string): Promise<string> {
  return join(await getPrivateRoot(), "trials", assertToken(studyId, "Trial study ID"));
}

async function studyPath(studyId: string): Promise<string> {
  return join(await studyRoot(studyId), "study.json");
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function withStudyLock<T>(
  studyId: string,
  operation: () => Promise<T>
): Promise<T> {
  const root = await studyRoot(studyId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, ".lock");
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`);
      break;
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error &&
          "code" in error &&
          error.code === "EEXIST"
        )
      ) {
        throw error;
      }
      let stale = false;
      try {
        const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
          pid?: number;
        };
        stale = !processIsAlive(Number(lock.pid));
      } catch {
        stale = true;
      }
      if (!stale || attempt > 0) {
        throw new Error(`Trial study ${studyId} is locked by another process`);
      }
      await unlink(lockPath);
    }
  }
  if (!handle) throw new Error(`Unable to lock trial study ${studyId}`);
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function readStudy(studyId: string): Promise<TrialStudy> {
  const parsed = JSON.parse(await readFile(await studyPath(studyId), "utf8")) as TrialStudy;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.studyId !== studyId ||
    !Array.isArray(parsed.sessions) ||
    parsed.sessions.length !== 4
  ) {
    throw new Error("Private outcome-trial study is invalid");
  }
  return parsed;
}

async function writeStudy(study: TrialStudy): Promise<void> {
  study.updatedAt = new Date().toISOString();
  await atomicJson(await studyPath(study.studyId), study);
}

function sessionById(study: TrialStudy, sessionId: string): TrialSession {
  assertToken(sessionId, "Trial session ID");
  const session = study.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error(`Trial session does not exist: ${sessionId}`);
  return session;
}

function taskFor(scenario: MileMeshScenario): string {
  return scenario === "delivery-list"
    ? "Add the missing operation-level test for listing deliveries. Edit tests only."
    : "Add the missing operation-level test for updating delivery status. Edit tests only.";
}

function assertSameAgent(
  study: TrialStudy,
  session: TrialSession,
  agentLabel: string
): void {
  const existing = study.sessions.find(
    (candidate) =>
      candidate.participantToken === session.participantToken &&
      candidate.agentLabel
  )?.agentLabel;
  if (existing && existing !== agentLabel) {
    throw new Error(
      "The assisted and unassisted sessions for one participant must use the same IDE agent"
    );
  }
  if (session.agentLabel && session.agentLabel !== agentLabel) {
    throw new Error("Trial session must resume with the same IDE agent label");
  }
}

export async function prepareOutcomeTrial(studyId: string): Promise<{
  studyId: string;
  sessions: number;
  assisted: number;
  unassisted: number;
}> {
  assertToken(studyId, "Trial study ID");
  return withStudyLock(studyId, async () => {
    try {
      await stat(await studyPath(studyId));
      throw new Error(`Outcome trial already exists: ${studyId}`);
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    }
    const root = await studyRoot(studyId);
    const assignments: Array<
      Pick<TrialSession, "id" | "participantToken" | "mode" | "scenario">
    > = [
      {
        id: "01",
        participantToken: "reviewer-a",
        mode: "unassisted",
        scenario: "delivery-list"
      },
      {
        id: "02",
        participantToken: "reviewer-a",
        mode: "assisted",
        scenario: "delivery-status"
      },
      {
        id: "03",
        participantToken: "reviewer-b",
        mode: "assisted",
        scenario: "delivery-list"
      },
      {
        id: "04",
        participantToken: "reviewer-b",
        mode: "unassisted",
        scenario: "delivery-status"
      }
    ];
    const sessions: TrialSession[] = [];
    for (const assignment of assignments) {
      const sourcePath = join(root, "targets", assignment.id);
      await createMileMeshFixture({
        directory: sourcePath,
        scenario: assignment.scenario
      });
      sessions.push({
        ...assignment,
        status: "PREPARED",
        sourcePath,
        verificationLatencyMs: 0,
        workDurationMs: 0
      });
    }
    const now = new Date().toISOString();
    await writeStudy({
      schemaVersion: 1,
      studyId,
      createdAt: now,
      updatedAt: now,
      sessions
    });
    return { studyId, sessions: 4, assisted: 2, unassisted: 2 };
  });
}

export async function runOutcomeTrialSession(input: {
  studyId: string;
  sessionId: string;
  agentLabel: string;
}): Promise<TrialRunResult> {
  const normalizedAgent = normalizeAgentLabel(input.agentLabel);
  const phase = await withStudyLock(input.studyId, async () => {
    const study = await readStudy(input.studyId);
    const session = sessionById(study, input.sessionId);
    assertSameAgent(study, session, normalizedAgent);
    if (["VERIFIED", "REVIEWED"].includes(session.status)) {
      return { action: "complete" as const, study, session };
    }
    if (session.status === "FAILED") {
      return { action: "failed" as const, study, session };
    }
    if (session.status === "PREPARED") {
      const setupStartedAt = Date.now();
      const started = await startChangeRun({
        sourcePath: session.sourcePath,
        policy: DEMO_CHANGE_POLICY,
        agentLabel: normalizedAgent
      });
      session.changeId = started.changeId;
      session.worktreePath = started.worktreePath;
      session.fixPacketPath = started.fixPacketPath;
      session.promptPath = started.promptPath;
      session.agentLabel = normalizedAgent;
      session.setupLatencyMs = Date.now() - setupStartedAt;
      session.workStartedAt = new Date().toISOString();
      session.status = "AWAITING_AGENT";
      await writeStudy(study);
      return { action: "handoff" as const, study, session };
    }
    if (["AWAITING_AGENT", "REPAIR_REQUIRED"].includes(session.status)) {
      if (!session.workStartedAt) throw new Error("Trial work timer is missing");
      session.workDurationMs += Math.max(
        0,
        Date.now() - new Date(session.workStartedAt).getTime()
      );
      session.workStartedAt = undefined;
      session.status = "VERIFYING";
      await writeStudy(study);
    }
    if (session.status !== "VERIFYING" || !session.changeId) {
      throw new Error(`Trial session cannot run from ${session.status}`);
    }
    return {
      action: "verify" as const,
      study,
      session,
      changeId: session.changeId
    };
  });

  if (phase.action === "handoff") {
    return {
      studyId: input.studyId,
      sessionId: input.sessionId,
      mode: phase.session.mode,
      scenario: phase.session.scenario,
      phase: "AWAITING_AGENT",
      task: taskFor(phase.session.scenario),
      worktreePath: phase.session.worktreePath,
      fixPacketPath:
        phase.session.mode === "assisted"
          ? phase.session.fixPacketPath
          : undefined,
      promptPath:
        phase.session.mode === "assisted" ? phase.session.promptPath : undefined
    };
  }
  if (phase.action === "complete") {
    return {
      studyId: input.studyId,
      sessionId: input.sessionId,
      mode: phase.session.mode,
      scenario: phase.session.scenario,
      phase: "VERIFIED",
      workDurationMs: phase.session.workDurationMs,
      verificationLatencyMs: phase.session.verificationLatencyMs,
      repairAttempts: phase.session.outcome?.repairAttempts
    };
  }
  if (phase.action === "failed") {
    return {
      studyId: input.studyId,
      sessionId: input.sessionId,
      mode: phase.session.mode,
      scenario: phase.session.scenario,
      phase: "FAILED"
    };
  }

  const verificationStartedAt = Date.now();
  let verified: Awaited<ReturnType<typeof verifyChangeRun>> | undefined;
  const currentChange = await changeRunStatus(phase.changeId);
  if (
    ["REVIEW_REQUIRED", "VERIFIED_LOCAL_PATCH"].includes(
      currentChange.status
    )
  ) {
    try {
      verified = {
        status: currentChange.status,
        report: await readChangeOutcomeReport(phase.changeId)
      };
    } catch {
      if (currentChange.status === "REVIEW_REQUIRED") {
        return withStudyLock(input.studyId, async () => {
          const study = await readStudy(input.studyId);
          const session = sessionById(study, input.sessionId);
          session.verificationLatencyMs += Date.now() - verificationStartedAt;
          session.status = "FAILED";
          session.workStartedAt = undefined;
          await writeStudy(study);
          return {
            studyId: input.studyId,
            sessionId: input.sessionId,
            mode: session.mode,
            scenario: session.scenario,
            phase: "FAILED",
            workDurationMs: session.workDurationMs,
            verificationLatencyMs: session.verificationLatencyMs
          };
        });
      }
    }
  }
  try {
    verified ??= await verifyChangeRun({
        changeId: phase.changeId,
        policy: DEMO_CHANGE_POLICY,
        allowVerification: true
      });
  } catch (error) {
    await withStudyLock(input.studyId, async () => {
      const study = await readStudy(input.studyId);
      const session = sessionById(study, input.sessionId);
      session.verificationLatencyMs += Date.now() - verificationStartedAt;
      const changeStatus = await changeRunStatus(phase.changeId);
      session.status =
        changeStatus.status === "REVIEW_REQUIRED" ? "FAILED" : "REPAIR_REQUIRED";
      session.workStartedAt = new Date().toISOString();
      await writeStudy(study);
    });
    throw error;
  }

  return withStudyLock(input.studyId, async () => {
    const study = await readStudy(input.studyId);
    const session = sessionById(study, input.sessionId);
    session.verificationLatencyMs += Date.now() - verificationStartedAt;
    if (!verified) throw new Error("Trial verification did not produce an outcome");
    const report = verified.report;
    session.outcome = {
      verificationPassed: report.verification.status === "passed",
      targetClosed: report.verification.targetClosed,
      noNewRegression: report.verification.noNewRegression,
      requiredChecks: report.verification.requiredChecks,
      passedChecks: report.verification.passedChecks,
      patchSha256: report.patch.sha256,
      filesChanged: report.patch.filesChanged,
      attempts: report.attempts,
      repairAttempts: Math.max(0, report.attempts - 1)
    };
    if (verified.status === "VERIFIED_LOCAL_PATCH") {
      session.status = "VERIFIED";
      session.workStartedAt = undefined;
    } else if (verified.status === "REPAIR_REQUIRED") {
      session.status = "REPAIR_REQUIRED";
      session.workStartedAt = new Date().toISOString();
    } else {
      session.status = "FAILED";
      session.workStartedAt = undefined;
    }
    await writeStudy(study);
    return {
      studyId: input.studyId,
      sessionId: input.sessionId,
      mode: session.mode,
      scenario: session.scenario,
      phase:
        session.status === "VERIFIED"
          ? "VERIFIED"
          : session.status === "REPAIR_REQUIRED"
            ? "REPAIR_REQUIRED"
            : "FAILED",
      task:
        session.status === "REPAIR_REQUIRED"
          ? taskFor(session.scenario)
          : undefined,
      worktreePath:
        session.status === "REPAIR_REQUIRED" ? session.worktreePath : undefined,
      fixPacketPath:
        session.status === "REPAIR_REQUIRED" && session.mode === "assisted"
          ? session.fixPacketPath
          : undefined,
      promptPath:
        session.status === "REPAIR_REQUIRED" && session.mode === "assisted"
          ? session.promptPath
          : undefined,
      workDurationMs: session.workDurationMs,
      verificationLatencyMs: session.verificationLatencyMs,
      repairAttempts: session.outcome?.repairAttempts
    };
  });
}

export async function reviewOutcomeTrialSession(input: {
  studyId: string;
  sessionId: string;
  reviewerToken: string;
  decision: "accept" | "reject";
}): Promise<{
  studyId: string;
  sessionId: string;
  decision: "accept" | "reject";
  patchSha256: string;
}> {
  assertToken(input.reviewerToken, "Independent reviewer token");
  return withStudyLock(input.studyId, async () => {
    const study = await readStudy(input.studyId);
    const session = sessionById(study, input.sessionId);
    if (session.status !== "VERIFIED" || !session.changeId || !session.outcome) {
      throw new Error("Trial review requires a verified local patch");
    }
    if (input.reviewerToken === session.participantToken) {
      throw new Error("Independent reviewer token must differ from participant token");
    }
    const outcome = await readChangeOutcomeReport(session.changeId);
    if (outcome.patch.sha256 !== session.outcome.patchSha256) {
      throw new Error("Trial review patch SHA-256 does not match verified outcome");
    }
    session.review = {
      reviewerToken: input.reviewerToken,
      decision: input.decision,
      patchSha256: outcome.patch.sha256,
      reviewedAt: new Date().toISOString()
    };
    session.status = "REVIEWED";
    await writeStudy(study);
    return {
      studyId: input.studyId,
      sessionId: input.sessionId,
      decision: input.decision,
      patchSha256: outcome.patch.sha256
    };
  });
}

export async function outcomeTrialStatus(studyId: string): Promise<{
  studyId: string;
  total: number;
  statusCounts: Record<TrialSessionStatus, number>;
  sessions: Array<{
    id: string;
    mode: TrialMode;
    scenario: MileMeshScenario;
    status: TrialSessionStatus;
  }>;
}> {
  const study = await readStudy(studyId);
  const statuses: TrialSessionStatus[] = [
    "PREPARED",
    "AWAITING_AGENT",
    "VERIFYING",
    "REPAIR_REQUIRED",
    "VERIFIED",
    "REVIEWED",
    "FAILED"
  ];
  const statusCounts = Object.fromEntries(
    statuses.map((status) => [
      status,
      study.sessions.filter((session) => session.status === status).length
    ])
  ) as Record<TrialSessionStatus, number>;
  return {
    studyId,
    total: study.sessions.length,
    statusCounts,
    sessions: study.sessions.map(({ id, mode, scenario, status }) => ({
      id,
      mode,
      scenario,
      status
    }))
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export interface OutcomeTrialSummary {
  schemaVersion: 1;
  kind: "auto-repoflow-outcome-trial-summary";
  protocol: {
    sessionsPlanned: 4;
    counterbalanced: true;
    sameAgentEnforced: true;
    independentReviewRequired: true;
    statisticalClaim: false;
  };
  outcomes: Record<
    TrialMode,
    {
      sessionsReviewed: number;
      verifiedSuccess: number;
      accepted: number;
      workTimeMedianMs: number | null;
      setupLatencyMedianMs: number | null;
      verificationLatencyMedianMs: number | null;
      repairAttemptsMedian: number | null;
      filesChangedMedian: number | null;
    }
  >;
  paired: {
    completePairs: number;
    assistedWorkTimeMedianMs: number | null;
    unassistedWorkTimeMedianMs: number | null;
    medianPairedDifferenceMs: number | null;
  };
}

export async function summarizeOutcomeTrial(
  studyId: string
): Promise<OutcomeTrialSummary> {
  const study = await readStudy(studyId);
  const reviewed = study.sessions.filter(
    (session) => session.status === "REVIEWED" && session.outcome && session.review
  );
  const summarizeMode = (mode: TrialMode) => {
    const sessions = reviewed.filter((session) => session.mode === mode);
    const accepted = sessions.filter(
      (session) => session.review?.decision === "accept"
    );
    const verifiedSuccess = accepted.filter(
      (session) =>
        session.outcome?.verificationPassed &&
        session.outcome.targetClosed &&
        session.outcome.noNewRegression &&
        session.review?.patchSha256 === session.outcome.patchSha256
    ).length;
    return {
      sessionsReviewed: sessions.length,
      verifiedSuccess,
      accepted: accepted.length,
      workTimeMedianMs: median(sessions.map((session) => session.workDurationMs)),
      setupLatencyMedianMs: median(
        sessions.map((session) => session.setupLatencyMs ?? 0)
      ),
      verificationLatencyMedianMs: median(
        sessions.map((session) => session.verificationLatencyMs)
      ),
      repairAttemptsMedian: median(
        sessions.map((session) => session.outcome?.repairAttempts ?? 0)
      ),
      filesChangedMedian: median(
        sessions.map((session) => session.outcome?.filesChanged ?? 0)
      )
    };
  };
  const participants = [...new Set(study.sessions.map((session) => session.participantToken))];
  const pairs = participants
    .map((participant) => {
      const sessions = reviewed.filter(
        (session) => session.participantToken === participant
      );
      const assisted = sessions.find((session) => session.mode === "assisted");
      const unassisted = sessions.find((session) => session.mode === "unassisted");
      return assisted && unassisted ? { assisted, unassisted } : undefined;
    })
    .filter(
      (pair): pair is { assisted: TrialSession; unassisted: TrialSession } =>
        Boolean(pair)
    );
  return {
    schemaVersion: 1,
    kind: "auto-repoflow-outcome-trial-summary",
    protocol: {
      sessionsPlanned: 4,
      counterbalanced: true,
      sameAgentEnforced: true,
      independentReviewRequired: true,
      statisticalClaim: false
    },
    outcomes: {
      assisted: summarizeMode("assisted"),
      unassisted: summarizeMode("unassisted")
    },
    paired: {
      completePairs: pairs.length,
      assistedWorkTimeMedianMs: median(
        pairs.map((pair) => pair.assisted.workDurationMs)
      ),
      unassistedWorkTimeMedianMs: median(
        pairs.map((pair) => pair.unassisted.workDurationMs)
      ),
      medianPairedDifferenceMs: median(
        pairs.map(
          (pair) =>
            pair.assisted.workDurationMs - pair.unassisted.workDurationMs
        )
      )
    }
  };
}

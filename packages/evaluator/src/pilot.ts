import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { getPrivateRoot, sha256 } from "./privacy.js";

const anonymousToken = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const safeLabel = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const gitRevision = /^[0-9a-f]{7,64}$/;
const findingToken = /^[A-Z][A-Z0-9_-]{0,15}$/;
const reviewModeSchema = z.enum(["manual", "rules", "local-ai"]);

export const pilotSessionConfigSchema = z
  .object({
    id: z.string().regex(anonymousToken),
    comparisonId: z.string().regex(anonymousToken),
    reviewerToken: z.string().regex(anonymousToken),
    mode: reviewModeSchema,
    targetLabel: z.string().regex(safeLabel),
    targetRevision: z.string().regex(gitRevision),
    targetPath: z.string().min(1),
    controlledInputPath: z.string().min(1).optional(),
    allowedFindingTokens: z
      .array(z.string().regex(findingToken))
      .min(1)
      .max(20),
    timeLimitMinutes: z.number().int().min(1).max(120).default(12)
  })
  .strict()
  .superRefine((session, context) => {
    if (!isAbsolute(session.targetPath)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetPath"],
        message: "targetPath must be absolute"
      });
    }
    if (session.mode === "manual" && session.controlledInputPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlledInputPath"],
        message: "manual sessions must not expose a controlled input"
      });
    }
    if (session.mode !== "manual") {
      if (!session.controlledInputPath) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["controlledInputPath"],
          message: "assisted sessions require a controlled input"
        });
      } else if (!isAbsolute(session.controlledInputPath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["controlledInputPath"],
          message: "controlledInputPath must be absolute"
        });
      }
    }
  });

export const pilotStudySchema = z
  .object({
    schemaVersion: z.literal(1),
    studyId: z.string().regex(anonymousToken),
    publicLabel: z.string().regex(safeLabel),
    purpose: z.literal("usability"),
    sessions: z.array(pilotSessionConfigSchema).min(1).max(100)
  })
  .strict();

export type PilotStudy = z.infer<typeof pilotStudySchema>;
export type PilotSessionConfig = z.infer<typeof pilotSessionConfigSchema>;

const pilotResponsesSchema = z
  .object({
    taskCompleted: z.boolean(),
    clarity: z.number().int().min(1).max(5),
    mostUsefulFinding: z.union([z.string().regex(findingToken), z.literal("none")]),
    handoffReady: z.enum(["yes", "no", "unsure"]),
    proposalSummary: z.string().trim().min(1).max(500),
    comment: z.string().trim().max(500)
  })
  .strict();

export type PilotResponses = z.infer<typeof pilotResponsesSchema>;

const pilotRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    studyId: z.string().regex(anonymousToken),
    sessionId: z.string().regex(anonymousToken),
    comparisonId: z.string().regex(anonymousToken),
    reviewerToken: z.string().regex(anonymousToken),
    mode: reviewModeSchema,
    targetLabel: z.string().regex(safeLabel),
    targetRevision: z.string().regex(gitRevision),
    status: z.enum(["running", "completed", "invalid"]),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    durationSeconds: z.number().int().positive().optional(),
    controlledInputSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    responses: pilotResponsesSchema.optional(),
    integrity: z
      .object({
        targetRevisionMatched: z.boolean(),
        targetCleanBefore: z.boolean(),
        targetCleanAfter: z.boolean().optional()
      })
      .strict()
  })
  .strict();

export type PilotRecord = z.infer<typeof pilotRecordSchema>;

function assertPrivateMode(metadata: Stats, label: string): void {
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be readable by group or others`);
  }
}

function assertToken(value: string, label: string): void {
  if (!anonymousToken.test(value)) throw new Error(`${label} is invalid`);
}

async function privatePilotRoot(studyId: string): Promise<string> {
  assertToken(studyId, "Pilot study ID");
  return join(await getPrivateRoot(), "pilots", studyId);
}

async function studyPath(studyId: string): Promise<string> {
  return join(await privatePilotRoot(studyId), "study.json");
}

async function recordPath(studyId: string, sessionId: string): Promise<string> {
  assertToken(sessionId, "Pilot session ID");
  return join(await privatePilotRoot(studyId), "records", `${sessionId}.json`);
}

async function atomicPrivateWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function parseStudyDocument(contents: string): unknown {
  return parseYaml(contents) as unknown;
}

function validateStudyRelationships(study: PilotStudy): void {
  const sessionIds = new Set<string>();
  const comparisonModes = new Set<string>();
  const comparisonTargets = new Map<string, string>();
  for (const session of study.sessions) {
    if (sessionIds.has(session.id)) {
      throw new Error(`Pilot session ID is duplicated: ${session.id}`);
    }
    sessionIds.add(session.id);
    const comparisonMode = `${session.comparisonId}\0${session.mode}`;
    if (comparisonModes.has(comparisonMode)) {
      throw new Error(
        `Comparison ${session.comparisonId} contains duplicate ${session.mode} sessions`
      );
    }
    comparisonModes.add(comparisonMode);
    const target = `${session.targetLabel}\0${session.targetRevision}`;
    const existing = comparisonTargets.get(session.comparisonId);
    if (existing && existing !== target) {
      throw new Error(
        `Comparison ${session.comparisonId} must use one pinned target`
      );
    }
    comparisonTargets.set(session.comparisonId, target);
    if (new Set(session.allowedFindingTokens).size !== session.allowedFindingTokens.length) {
      throw new Error(`Session ${session.id} has duplicate finding tokens`);
    }
  }
}

async function readPrivateStudyFile(path: string): Promise<PilotStudy> {
  if (!isAbsolute(path)) throw new Error("Pilot config path must be absolute");
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Pilot config must be a file");
  assertPrivateMode(metadata, "Pilot config");
  const study = pilotStudySchema.parse(
    parseStudyDocument(await readFile(path, "utf8"))
  );
  validateStudyRelationships(study);
  return study;
}

export async function preparePilotStudy(configPath: string): Promise<{
  studyId: string;
  path: string;
  sessions: number;
}> {
  const study = await readPrivateStudyFile(configPath);
  const destination = await studyPath(study.studyId);
  try {
    await stat(destination);
    throw new Error(`Pilot study already exists: ${study.studyId}`);
  } catch (error) {
    if (
      !(typeof error === "object" && error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  await atomicPrivateWrite(destination, study);
  return { studyId: study.studyId, path: destination, sessions: study.sessions.length };
}

export async function loadPilotStudy(studyId: string): Promise<PilotStudy> {
  const path = await studyPath(studyId);
  const study = await readPrivateStudyFile(path);
  if (study.studyId !== studyId) {
    throw new Error("Pilot study ID does not match its private directory");
  }
  return study;
}

interface TargetIntegrity {
  revisionMatched: boolean;
  clean: boolean;
}

async function inspectTarget(session: PilotSessionConfig): Promise<TargetIntegrity> {
  const root = await realpath(resolve(session.targetPath));
  if (!(await stat(root)).isDirectory()) {
    throw new Error(`Pilot target for session ${session.id} must be a directory`);
  }
  const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 5_000
  });
  if (revision.error || revision.status !== 0) {
    throw new Error(`Pilot target for session ${session.id} is not a Git checkout`);
  }
  const status = spawnSync(
    "git",
    ["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"],
    { encoding: "utf8", timeout: 5_000 }
  );
  if (status.error || status.status !== 0) {
    throw new Error(`Unable to verify pilot target for session ${session.id}`);
  }
  return {
    revisionMatched: revision.stdout.trim() === session.targetRevision,
    clean: status.stdout.trim().length === 0
  };
}

function containsUnsafeControlledMetadata(contents: string): boolean {
  return (
    /(?:^|\s)\/Users\/[^/\s]+\//m.test(contents) ||
    /[A-Z]:\\Users\\[^\\\s]+\\/i.test(contents) ||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(contents) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(contents) ||
    /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/.test(contents)
  );
}

async function readControlledInput(
  studyId: string,
  session: PilotSessionConfig
): Promise<{ contents?: string; sha256?: string }> {
  if (!session.controlledInputPath) return {};
  const root = await realpath(await privatePilotRoot(studyId));
  const path = await realpath(session.controlledInputPath);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Controlled pilot input must remain under its private study root");
  }
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Controlled pilot input must be a file");
  assertPrivateMode(metadata, "Controlled pilot input");
  if (metadata.size > 1_000_000) {
    throw new Error("Controlled pilot input exceeds the 1 MB limit");
  }
  const contents = await readFile(path, "utf8");
  if (containsUnsafeControlledMetadata(contents)) {
    throw new Error("Controlled pilot input contains unsafe identity or secret-like data");
  }
  return { contents, sha256: sha256(contents) };
}

export interface PreparedPilotSession {
  study: PilotStudy;
  session: PilotSessionConfig;
  controlledInput?: string;
  controlledInputSha256?: string;
}

export async function validatePilotSession(
  studyId: string,
  sessionId: string
): Promise<PreparedPilotSession> {
  const study = await loadPilotStudy(studyId);
  const session = study.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error(`Pilot session does not exist: ${sessionId}`);
  const integrity = await inspectTarget(session);
  if (!integrity.revisionMatched) {
    throw new Error(`Pilot session ${sessionId} target revision does not match`);
  }
  if (!integrity.clean) {
    throw new Error(`Pilot session ${sessionId} target is not a pristine checkout`);
  }
  const controlled = await readControlledInput(studyId, session);
  return {
    study,
    session,
    controlledInput: controlled.contents,
    controlledInputSha256: controlled.sha256
  };
}

export async function validatePilotStudy(studyId: string): Promise<{
  studyId: string;
  ready: true;
  sessions: number;
}> {
  const study = await loadPilotStudy(studyId);
  for (const session of study.sessions) {
    await validatePilotSession(studyId, session.id);
  }
  return { studyId, ready: true, sessions: study.sessions.length };
}

export async function startPilotSession(
  studyId: string,
  sessionId: string,
  now = new Date()
): Promise<{ prepared: PreparedPilotSession; record: PilotRecord }> {
  const prepared = await validatePilotSession(studyId, sessionId);
  const path = await recordPath(studyId, sessionId);
  try {
    await stat(path);
    throw new Error(`Pilot session ${sessionId} already has a record`);
  } catch (error) {
    if (
      !(typeof error === "object" && error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  const { session } = prepared;
  const record: PilotRecord = {
    schemaVersion: 1,
    studyId,
    sessionId,
    comparisonId: session.comparisonId,
    reviewerToken: session.reviewerToken,
    mode: session.mode,
    targetLabel: session.targetLabel,
    targetRevision: session.targetRevision,
    status: "running",
    startedAt: now.toISOString(),
    controlledInputSha256: prepared.controlledInputSha256,
    integrity: {
      targetRevisionMatched: true,
      targetCleanBefore: true
    }
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  return { prepared, record };
}

export async function completePilotSession(input: {
  studyId: string;
  sessionId: string;
  responses: PilotResponses;
  finishedAt?: Date;
}): Promise<PilotRecord> {
  const path = await recordPath(input.studyId, input.sessionId);
  const current = pilotRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (current.status !== "running") {
    throw new Error(`Pilot session ${input.sessionId} is not running`);
  }
  const study = await loadPilotStudy(input.studyId);
  const session = study.sessions.find((candidate) => candidate.id === input.sessionId);
  if (!session) throw new Error(`Pilot session does not exist: ${input.sessionId}`);
  const responses = pilotResponsesSchema.parse(input.responses);
  if (
    responses.mostUsefulFinding !== "none" &&
    !session.allowedFindingTokens.includes(responses.mostUsefulFinding)
  ) {
    throw new Error("Most useful finding is outside the controlled session scope");
  }
  const finishedAt = input.finishedAt ?? new Date();
  if (finishedAt.getTime() <= Date.parse(current.startedAt)) {
    throw new Error("Pilot finish time must be after its start time");
  }
  const durationSeconds = Math.max(
    1,
    Math.round((finishedAt.getTime() - Date.parse(current.startedAt)) / 1_000)
  );
  const integrity = await inspectTarget(session);
  const completed: PilotRecord = {
    ...current,
    status:
      integrity.revisionMatched && integrity.clean ? "completed" : "invalid",
    finishedAt: finishedAt.toISOString(),
    durationSeconds,
    responses,
    integrity: {
      ...current.integrity,
      targetRevisionMatched: integrity.revisionMatched,
      targetCleanAfter: integrity.clean
    }
  };
  await atomicPrivateWrite(path, completed);
  return completed;
}

async function readPilotRecords(studyId: string): Promise<PilotRecord[]> {
  const directory = join(await privatePilotRoot(studyId), "records");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (
      typeof error === "object" && error && "code" in error && error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  const records: PilotRecord[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    records.push(
      pilotRecordSchema.parse(
        JSON.parse(await readFile(join(directory, name), "utf8"))
      )
    );
  }
  return records;
}

export async function pilotStudyStatus(studyId: string): Promise<{
  studyId: string;
  configuredSessions: number;
  sessions: Array<{ id: string; mode: PilotSessionConfig["mode"]; status: string }>;
}> {
  const study = await loadPilotStudy(studyId);
  const records = await readPilotRecords(studyId);
  const bySession = new Map(records.map((record) => [record.sessionId, record.status]));
  return {
    studyId,
    configuredSessions: study.sessions.length,
    sessions: study.sessions.map((session) => ({
      id: session.id,
      mode: session.mode,
      status: bySession.get(session.id) ?? "pending"
    }))
  };
}

function round(value: number): number {
  return Number(value.toFixed(1));
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function summarizeCompleted(records: PilotRecord[]) {
  const durations = records.map((record) => record.durationSeconds!);
  const clarity = records.map((record) => record.responses!.clarity);
  const handoffReady = { yes: 0, no: 0, unsure: 0 };
  for (const record of records) {
    handoffReady[record.responses!.handoffReady] += 1;
  }
  return {
    sessions: records.length,
    taskCompleted: records.filter((record) => record.responses!.taskCompleted).length,
    taskCompletionRatePercent: round(
      (records.filter((record) => record.responses!.taskCompleted).length /
        records.length) *
        100
    ),
    clarity: {
      min: Math.min(...clarity),
      median: round(median(clarity)),
      max: Math.max(...clarity)
    },
    handoffReady,
    durationSeconds: {
      min: Math.min(...durations),
      median: round(median(durations)),
      max: Math.max(...durations)
    }
  };
}

export async function summarizePilotStudy(studyId: string): Promise<object> {
  const study = await loadPilotStudy(studyId);
  const records = await readPilotRecords(studyId);
  const completed = records.filter((record) => record.status === "completed");
  if (completed.length === 0) {
    throw new Error("Pilot study has no completed valid sessions");
  }
  const modes = [...new Set(completed.map((record) => record.mode))].sort();
  const comparisons = new Map<string, Map<string, PilotRecord>>();
  for (const record of completed) {
    const modesForComparison = comparisons.get(record.comparisonId) ?? new Map();
    modesForComparison.set(record.mode, record);
    comparisons.set(record.comparisonId, modesForComparison);
  }
  const paired = [];
  for (const assistedMode of ["rules", "local-ai"] as const) {
    const pairs = [...comparisons.values()].filter(
      (modesForComparison) =>
        modesForComparison.has("manual") && modesForComparison.has(assistedMode)
    );
    if (pairs.length === 0) continue;
    const secondsSaved = pairs.map(
      (pair) =>
        pair.get("manual")!.durationSeconds! -
        pair.get(assistedMode)!.durationSeconds!
    );
    const reductions = pairs.map((pair) => {
      const manual = pair.get("manual")!.durationSeconds!;
      return ((manual - pair.get(assistedMode)!.durationSeconds!) / manual) * 100;
    });
    paired.push({
      baselineMode: "manual",
      assistedMode,
      pairedTargets: pairs.length,
      fasterPairs: secondsSaved.filter((value) => value > 0).length,
      medianSecondsSaved: round(median(secondsSaved)),
      medianTimeReductionPercent: round(median(reductions))
    });
  }
  return {
    schemaVersion: 1,
    kind: "auto-repoflow-usability-pilot-summary",
    generatedAt: new Date().toISOString(),
    study: { label: study.publicLabel },
    protocol: {
      purpose: "usability",
      timingUnit: "one completed validated session",
      comparisonDesign: "paired-by-comparison-id-and-pinned-target"
    },
    configuredSessions: study.sessions.length,
    validCompletedSessions: completed.length,
    invalidSessions: records.filter((record) => record.status === "invalid").length,
    reviewers: new Set(completed.map((record) => record.reviewerToken)).size,
    targets: new Set(
      completed.map((record) => `${record.targetLabel}\0${record.targetRevision}`)
    ).size,
    overall: summarizeCompleted(completed),
    modes: modes.map((mode) => ({
      mode,
      ...summarizeCompleted(completed.filter((record) => record.mode === mode))
    })),
    comparisons: paired,
    claimBoundary: {
      usabilityAllowed: true,
      engineeringAccuracyAllowed: false,
      humanAcceptanceAllowed: false
    },
    privacy: {
      sourceRecordsStored: false,
      reviewerTokensStored: false,
      sessionIdsStored: false,
      comparisonIdsStored: false,
      findingTokensStored: false,
      targetLabelsStored: false,
      targetRevisionsStored: false,
      timestampsStored: false,
      pathsStored: false,
      proposalTextStored: false,
      commentsStored: false
    }
  };
}

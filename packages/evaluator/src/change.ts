import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import type {
  ChangeOutcomeReport,
  ChangeRunStatus,
  CoverageMetric,
  EvaluationReport,
  Finding
} from "@auto-repoflow/domain";
import {
  createAgentFixPacket,
  formatAgentFixPacketMarkdown
} from "./handoff.js";
import {
  assertChangePolicy,
  type AutomationPolicy,
  type ChangeAutomationPolicy
} from "./policy.js";
import { getPrivateRoot, sha256 } from "./privacy.js";
import { EvaluationService } from "./service.js";

const changeIdPattern = /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/;
const MAX_COMMAND_OUTPUT_BYTES = 200_000;
const TEST_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const TEST_FILENAME = /\.(?:test|spec)\.[^.]+$/i;
const BUILTIN_PROTECTED_PATHS = [
  ".git",
  ".github",
  ".autorepoflow",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json"
] as const;

export const CHANGE_TRANSITIONS: Record<ChangeRunStatus, ChangeRunStatus[]> = {
  INTAKE: ["WORKTREE_READY"],
  WORKTREE_READY: ["AWAITING_AGENT"],
  AWAITING_AGENT: ["VERIFYING"],
  VERIFYING: ["REPAIR_REQUIRED", "REVIEW_REQUIRED", "VERIFIED_LOCAL_PATCH"],
  REPAIR_REQUIRED: ["VERIFYING"],
  REVIEW_REQUIRED: [],
  VERIFIED_LOCAL_PATCH: []
};

interface PrivateChangeManifest {
  schemaVersion: 1;
  changeId: string;
  status: ChangeRunStatus;
  createdAt: string;
  updatedAt: string;
  sourceRoot: string;
  originalHead: string;
  originalStatus: string;
  worktreePath: string;
  branchName: string;
  agentLabel: string;
  targetFindingId?: string;
  baselineEvaluationId?: string;
  attempts: number;
  lastVerificationStartedAt?: string;
  lastErrors: string[];
}

export interface ChangeStartResult {
  changeId: string;
  status: "AWAITING_AGENT";
  worktreePath: string;
  fixPacketPath: string;
  promptPath: string;
  agentLabel: string;
}

export interface ChangeStatusResult {
  changeId: string;
  status: ChangeRunStatus;
  attempts: number;
  agentLabel: string;
  createdAt: string;
  updatedAt: string;
  lastErrors: string[];
}

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

interface PatchInspection {
  patch: string;
  bytes: number;
  sha256: string;
  files: string[];
  linesAdded: number;
  linesDeleted: number;
}

interface VerificationCheckResult {
  id: string;
  passed: boolean;
  required: true;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function normalizeAgentLabel(value?: string): string {
  const normalized = (value ?? "unspecified")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return normalized || "unspecified";
}

function normalizeRepositoryPath(value: string): string {
  return value.split(sep).join("/").replace(/^\.\//, "");
}

function assertChangeId(changeId: string): string {
  if (!changeIdPattern.test(changeId)) throw new Error("ChangeRun ID is invalid");
  return changeId;
}

async function changeRoot(changeId: string): Promise<string> {
  return join(await getPrivateRoot(), "change-runs", assertChangeId(changeId));
}

async function manifestPath(changeId: string): Promise<string> {
  return join(await changeRoot(changeId), "manifest.json");
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readManifest(changeId: string): Promise<PrivateChangeManifest> {
  const parsed = JSON.parse(
    await readFile(await manifestPath(changeId), "utf8")
  ) as PrivateChangeManifest;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.changeId !== changeId ||
    !Object.prototype.hasOwnProperty.call(CHANGE_TRANSITIONS, parsed.status)
  ) {
    throw new Error("Private ChangeRun manifest is invalid");
  }
  const root = await changeRoot(changeId);
  if (
    resolve(parsed.worktreePath) !== resolve(join(root, "worktree")) ||
    parsed.branchName !== `autorepoflow/change-${changeId}` ||
    resolve(parsed.sourceRoot) !== parsed.sourceRoot
  ) {
    throw new Error("Private ChangeRun manifest paths are invalid");
  }
  return parsed;
}

async function writeManifest(manifest: PrivateChangeManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  await atomicJson(await manifestPath(manifest.changeId), manifest);
}

function transition(
  manifest: PrivateChangeManifest,
  next: ChangeRunStatus
): void {
  if (!CHANGE_TRANSITIONS[manifest.status].includes(next)) {
    throw new Error(`Invalid ChangeRun transition: ${manifest.status} -> ${next}`);
  }
  manifest.status = next;
}

async function withChangeLock<T>(
  changeId: string,
  operation: () => Promise<T>
): Promise<T> {
  const root = await changeRoot(changeId);
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
        const pid = Number(lock.pid);
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          stale = true;
        } else {
          try {
            process.kill(pid, 0);
          } catch (processError) {
            stale = Boolean(
              typeof processError === "object" &&
                processError &&
                "code" in processError &&
                processError.code === "ESRCH"
            );
          }
        }
      } catch {
        stale = true;
      }
      if (!stale || attempt > 0) {
        throw new Error(`ChangeRun ${changeId} is locked by another process`);
      }
      await unlink(lockPath);
    }
  }
  if (!handle) throw new Error(`Unable to lock ChangeRun ${changeId}`);
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

function appendLimited(current: string, chunk: Buffer): string {
  const remaining = MAX_COMMAND_OUTPUT_BYTES - Buffer.byteLength(current);
  if (remaining <= 0) return current;
  return current + chunk.subarray(0, remaining).toString("utf8");
}

async function runCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolvePromise, rejectPromise) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: false,
      env: input.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk);
    });
    let forceKill: NodeJS.Timeout | undefined;
    const timeout = input.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
        }, input.timeoutMs)
      : undefined;
    child.once("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      rejectPromise(error);
    });
    child.once("close", (exitCode, signal) => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolvePromise({ exitCode, signal });
    });
  });
  return {
    ...result,
    stdout,
    stderr,
    timedOut,
    durationMs: Date.now() - startedAt
  };
}

async function git(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {}
): Promise<CommandResult> {
  const result = await runCommand({
    command: "git",
    args,
    cwd,
    timeoutMs: options.timeoutMs ?? 60_000
  });
  if (!options.allowFailure && result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`
    );
  }
  return result;
}

async function repositoryState(sourcePath: string): Promise<{
  root: string;
  head: string;
  status: string;
}> {
  const requested = await realpath(resolve(sourcePath));
  const rootText = (await git(requested, ["rev-parse", "--show-toplevel"]))
    .stdout.trim();
  const root = await realpath(rootText);
  const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const status = (
    await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
  ).stdout;
  return { root, head, status };
}

function findingPriority(finding: Finding): string {
  const severity = { HIGH: "0", MEDIUM: "1", LOW: "2", INFO: "3" }[
    finding.severity
  ];
  return `${severity}:${finding.id}`;
}

function selectTargetFinding(
  report: EvaluationReport,
  findingId?: string
): Finding {
  const candidates = report.findings
    .filter((finding) => finding.ruleId === "ARF-TEST-001")
    .sort((left, right) =>
      findingPriority(left).localeCompare(findingPriority(right))
    );
  const selected = findingId
    ? candidates.find((finding) => finding.id === findingId)
    : candidates[0];
  if (!selected) {
    throw new Error(
      findingId
        ? "The requested finding is not an ARF-TEST-001 test gap"
        : "No supported ARF-TEST-001 test gap was found"
    );
  }
  return selected;
}

async function assertOriginalIntegrity(
  manifest: PrivateChangeManifest
): Promise<void> {
  const current = await repositoryState(manifest.sourceRoot);
  if (
    current.root !== manifest.sourceRoot ||
    current.head !== manifest.originalHead ||
    current.status !== manifest.originalStatus
  ) {
    throw new Error("Original repository HEAD or status changed during ChangeRun");
  }
}

function isAllowedTestPath(path: string): boolean {
  const normalized = normalizeRepositoryPath(path);
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return false;
  }
  const parts = normalized.split("/");
  const filename = parts.at(-1) ?? "";
  const inTestDirectory = parts.some((part) =>
    ["test", "tests", "__tests__"].includes(part)
  );
  return TEST_EXTENSION.test(filename) &&
    (TEST_FILENAME.test(filename) || inTestDirectory);
}

function isProtectedPath(
  path: string,
  policy: ChangeAutomationPolicy
): boolean {
  const normalized = normalizeRepositoryPath(path);
  return [
    ...BUILTIN_PROTECTED_PATHS,
    ...policy.change.protectedPaths
  ].some((protectedPath) => {
    const protectedNormalized = normalizeRepositoryPath(protectedPath).replace(
      /\/$/,
      ""
    );
    return (
      normalized === protectedNormalized ||
      normalized.startsWith(`${protectedNormalized}/`)
    );
  });
}

function isConfigurationOrDependencyPath(path: string): boolean {
  const normalized = normalizeRepositoryPath(path).toLowerCase();
  const filename = normalized.split("/").at(-1) ?? "";
  return (
    /^(?:package(?:-lock)?|npm-shrinkwrap)\.json$/.test(filename) ||
    /^tsconfig(?:\.[^.]+)?\.json$/.test(filename) ||
    /^(?:jest|vitest|eslint|prettier|babel|webpack|rollup|vite)\.config\.[^.]+$/.test(
      filename
    ) ||
    /^(?:pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(filename)
  );
}

async function includeUntrackedFiles(worktreePath: string): Promise<void> {
  const untracked = (
    await git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])
  ).stdout
    .split("\0")
    .filter(Boolean);
  if (untracked.length > 0) {
    await git(worktreePath, ["add", "-N", "--", ...untracked]);
  }
}

function parseNameStatus(output: string): Array<{ status: string; path: string }> {
  const values = output.split("\0").filter(Boolean);
  const entries: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < values.length; index += 2) {
    if (!values[index + 1]) throw new Error("Unexpected git name-status output");
    entries.push({ status: values[index], path: values[index + 1] });
  }
  return entries;
}

function parseNumstat(output: string): {
  linesAdded: number;
  linesDeleted: number;
  binary: boolean;
} {
  let linesAdded = 0;
  let linesDeleted = 0;
  let binary = false;
  for (const entry of output.split("\0").filter(Boolean)) {
    const [added, deleted] = entry.split("\t", 3);
    if (added === "-" || deleted === "-") {
      binary = true;
      continue;
    }
    linesAdded += Number(added);
    linesDeleted += Number(deleted);
  }
  return { linesAdded, linesDeleted, binary };
}

async function inspectPatch(
  manifest: PrivateChangeManifest,
  policy: ChangeAutomationPolicy
): Promise<PatchInspection> {
  await includeUntrackedFiles(manifest.worktreePath);
  const nameStatus = parseNameStatus(
    (
      await git(manifest.worktreePath, [
        "diff",
        "--name-status",
        "--no-renames",
        "-z",
        "HEAD",
        "--"
      ])
    ).stdout
  );
  if (nameStatus.length === 0) throw new Error("ChangeRun contains no patch");
  if (nameStatus.length > policy.change.maxFiles) {
    throw new Error(`Patch changes more than ${policy.change.maxFiles} files`);
  }
  for (const entry of nameStatus) {
    if (!entry.status.startsWith("A") && !entry.status.startsWith("M")) {
      throw new Error("Patch deletions, renames, copies, and type changes are prohibited");
    }
    if (!isAllowedTestPath(entry.path)) {
      throw new Error(`Only JavaScript/TypeScript test files may change: ${entry.path}`);
    }
    if (isConfigurationOrDependencyPath(entry.path)) {
      throw new Error(`Configuration and dependency files may not change: ${entry.path}`);
    }
    if (isProtectedPath(entry.path, policy)) {
      throw new Error(`Protected path may not change: ${entry.path}`);
    }
    const absolute = join(manifest.worktreePath, entry.path);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Symlink and non-file changes are prohibited: ${entry.path}`);
    }
    const indexEntry = (
      await git(manifest.worktreePath, ["ls-files", "-s", "--", entry.path])
    ).stdout;
    if (indexEntry.startsWith("120000 ")) {
      throw new Error(`Symlink changes are prohibited: ${entry.path}`);
    }
  }
  const patch = (
    await git(manifest.worktreePath, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--full-index",
      "HEAD",
      "--"
    ])
  ).stdout;
  const bytes = Buffer.byteLength(patch);
  if (bytes > policy.change.maxPatchBytes) {
    throw new Error(`Patch exceeds ${policy.change.maxPatchBytes} bytes`);
  }
  const numstat = parseNumstat(
    (
      await git(manifest.worktreePath, ["diff", "--numstat", "-z", "HEAD", "--"])
    ).stdout
  );
  if (
    numstat.binary ||
    patch.includes("GIT binary patch") ||
    patch.includes("Binary files ")
  ) {
    throw new Error("Binary patches are prohibited");
  }
  const whitespace = await git(
    manifest.worktreePath,
    ["diff", "--check", "HEAD", "--"],
    { allowFailure: true }
  );
  if (whitespace.exitCode !== 0) {
    throw new Error(`Patch whitespace check failed: ${whitespace.stdout.trim()}`);
  }
  return {
    patch,
    bytes,
    sha256: sha256(patch),
    files: nameStatus.map((entry) => normalizeRepositoryPath(entry.path)),
    linesAdded: numstat.linesAdded,
    linesDeleted: numstat.linesDeleted
  };
}

async function resolveProjectLocalCommand(
  worktreePath: string,
  tool: string
): Promise<{ command: string; prefixArgs: string[] }> {
  const nodeModules = await realpath(join(worktreePath, "node_modules"));
  if (process.platform !== "win32") {
    const binary = await realpath(join(nodeModules, ".bin", tool));
    const metadata = await stat(binary);
    if (!metadata.isFile() || !binary.startsWith(`${nodeModules}${sep}`)) {
      throw new Error(`Verification tool ${tool} resolves outside node_modules`);
    }
    return { command: binary, prefixArgs: [] };
  }
  const packagePath = join(nodeModules, tool, "package.json");
  const packageDocument = JSON.parse(await readFile(packagePath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relativeBinary =
    typeof packageDocument.bin === "string"
      ? packageDocument.bin
      : packageDocument.bin?.[tool];
  if (!relativeBinary) throw new Error(`Verification tool ${tool} has no package bin`);
  const binary = await realpath(join(dirname(packagePath), relativeBinary));
  if (!binary.startsWith(`${nodeModules}${sep}`)) {
    throw new Error(`Verification tool ${tool} resolves outside node_modules`);
  }
  return { command: process.execPath, prefixArgs: [binary] };
}

async function verificationEnvironment(
  runRoot: string,
  worktreePath: string
): Promise<NodeJS.ProcessEnv> {
  const verificationHome = join(runRoot, "verification-home");
  const verificationTmp = join(runRoot, "verification-tmp");
  await mkdir(verificationHome, { recursive: true, mode: 0o700 });
  await mkdir(verificationTmp, { recursive: true, mode: 0o700 });
  const environment: NodeJS.ProcessEnv = {
    PATH: [
      join(worktreePath, "node_modules", ".bin"),
      dirname(process.execPath),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin"
    ].join(delimiter),
    HOME: verificationHome,
    USERPROFILE: verificationHome,
    TMPDIR: verificationTmp,
    TEMP: verificationTmp,
    TMP: verificationTmp,
    CI: "true",
    NODE_ENV: "test",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false"
  };
  for (const name of ["LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

async function runVerificationChecks(
  manifest: PrivateChangeManifest,
  policy: ChangeAutomationPolicy
): Promise<VerificationCheckResult[]> {
  const runRoot = await changeRoot(manifest.changeId);
  const environment = await verificationEnvironment(
    runRoot,
    manifest.worktreePath
  );
  const results: VerificationCheckResult[] = [];
  for (const check of policy.change.verification.checks) {
    try {
      const resolved =
        check.runner === "node"
          ? { command: process.execPath, prefixArgs: [] }
          : await resolveProjectLocalCommand(
              manifest.worktreePath,
              check.tool as string
            );
      const result = await runCommand({
        command: resolved.command,
        args: [...resolved.prefixArgs, ...check.args],
        cwd: manifest.worktreePath,
        timeoutMs: policy.change.verification.timeoutSeconds * 1_000,
        env: environment
      });
      results.push({
        id: check.id,
        required: true,
        passed: !result.timedOut && result.exitCode === 0,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr
      });
    } catch (error) {
      results.push({
        id: check.id,
        required: true,
        passed: false,
        durationMs: 0,
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

function testCoverage(report: EvaluationReport): ChangeOutcomeReport["before"]["testCoverage"] {
  const metric: CoverageMetric | undefined = report.coverage.find(
    (candidate) => candidate.id === "test"
  );
  return metric
    ? {
        covered: metric.covered,
        total: metric.total,
        percentage: metric.percentage
      }
    : { covered: 0, total: 0, percentage: 0 };
}

function regressionKey(finding: Finding): string {
  return `${finding.ruleId}\0${finding.status}\0${finding.title}`;
}

function noNewRegression(
  before: EvaluationReport,
  after: EvaluationReport
): boolean {
  const known = new Set(before.findings.map(regressionKey));
  const newFailures = after.findings.some(
    (finding) => finding.status === "FAIL" && !known.has(regressionKey(finding))
  );
  const coverageDropped = before.coverage.some((metric) => {
    const next = after.coverage.find((candidate) => candidate.id === metric.id);
    return Boolean(next && next.percentage < metric.percentage);
  });
  return !newFailures && !coverageDropped;
}

async function readBaselineReport(
  changeId: string
): Promise<EvaluationReport> {
  return JSON.parse(
    await readFile(join(await changeRoot(changeId), "baseline-report.json"), "utf8")
  ) as EvaluationReport;
}

function verificationErrors(input: {
  targetClosed: boolean;
  regressionFree: boolean;
  checks: VerificationCheckResult[];
}): string[] {
  const errors: string[] = [];
  if (!input.targetClosed) errors.push("target finding remains open");
  if (!input.regressionFree) errors.push("rescan detected a new regression");
  for (const check of input.checks.filter((candidate) => !candidate.passed)) {
    errors.push(`verification check failed: ${check.id}`);
  }
  return errors;
}

export async function startChangeRun(input: {
  sourcePath: string;
  policy: AutomationPolicy;
  agentLabel?: string;
  findingId?: string;
}): Promise<ChangeStartResult> {
  assertChangePolicy(input.policy);
  const initial = await repositoryState(input.sourcePath);
  if (initial.status !== "") {
    throw new Error(
      "change start requires a clean Git checkout (tracked and untracked changes are rejected)"
    );
  }
  const changeId = randomUUID();
  return withChangeLock(changeId, async () => {
    const root = await changeRoot(changeId);
    const now = new Date().toISOString();
    const manifest: PrivateChangeManifest = {
      schemaVersion: 1,
      changeId,
      status: "INTAKE",
      createdAt: now,
      updatedAt: now,
      sourceRoot: initial.root,
      originalHead: initial.head,
      originalStatus: initial.status,
      worktreePath: join(root, "worktree"),
      branchName: `autorepoflow/change-${changeId}`,
      agentLabel: normalizeAgentLabel(input.agentLabel),
      attempts: 0,
      lastErrors: []
    };
    await writeManifest(manifest);
    await git(initial.root, [
      "worktree",
      "add",
      "-b",
      manifest.branchName,
      manifest.worktreePath,
      initial.head
    ]);
    transition(manifest, "WORKTREE_READY");
    await writeManifest(manifest);

    const report = await new EvaluationService().scan({
      sourcePath: manifest.worktreePath,
      projectName: "private-change-run",
      retainSnapshot: false,
      ai: {
        requestedMode: "off",
        policy: input.policy,
        allowCloudMetadata: false
      },
      generateEvidence: "none"
    });
    const target = selectTargetFinding(report, input.findingId);
    manifest.targetFindingId = target.id;
    manifest.baselineEvaluationId = report.evaluationId;
    await atomicJson(join(root, "baseline-report.json"), report);
    const packet = createAgentFixPacket(report, { compat: "v2" });
    packet.findings = packet.findings.filter(
      (finding) => finding.id === target.id
    );
    packet.verification.declaredCommands = [];
    packet.constraints = [
      "Edit only JavaScript/TypeScript test files (*.test.*, *.spec.*, test/, tests/, or __tests__/).",
      "Do not edit source, configuration, dependencies, protected paths, symlinks, or repository metadata.",
      "Do not delete or rename files and keep the patch within five files and 200 KB.",
      "Do not install dependencies, push, merge, deploy, publish, or invoke another agent automatically.",
      "Return to the user so AutoRepoFlow can verify the local patch."
    ];
    const fixPacketPath = join(root, "fix-packet.json");
    const promptPath = join(root, "agent-prompt.md");
    await atomicJson(fixPacketPath, packet);
    await atomicWrite(
      promptPath,
      `${formatAgentFixPacketMarkdown(packet)}\n## ChangeRun boundary\n\nResolve only the selected ARF-TEST-001 gap in the isolated worktree.\n`
    );
    await assertOriginalIntegrity(manifest);
    transition(manifest, "AWAITING_AGENT");
    await writeManifest(manifest);
    return {
      changeId,
      status: "AWAITING_AGENT",
      worktreePath: manifest.worktreePath,
      fixPacketPath,
      promptPath,
      agentLabel: manifest.agentLabel
    };
  });
}

export async function changeRunStatus(
  changeId: string
): Promise<ChangeStatusResult> {
  const manifest = await readManifest(changeId);
  return {
    changeId,
    status: manifest.status,
    attempts: manifest.attempts,
    agentLabel: manifest.agentLabel,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    lastErrors: [...manifest.lastErrors]
  };
}

export async function verifyChangeRun(input: {
  changeId: string;
  policy: AutomationPolicy;
  allowVerification: boolean;
}): Promise<{
  status: ChangeRunStatus;
  report: ChangeOutcomeReport;
}> {
  const policy = assertChangePolicy(input.policy);
  if (!input.allowVerification) {
    throw new Error("change verify requires --allow-verification");
  }
  return withChangeLock(input.changeId, async () => {
    const manifest = await readManifest(input.changeId);
    if (
      !["AWAITING_AGENT", "REPAIR_REQUIRED", "VERIFYING"].includes(
        manifest.status
      )
    ) {
      throw new Error(`ChangeRun cannot be verified from ${manifest.status}`);
    }
    const resumed = manifest.status === "VERIFYING";
    if (!resumed) {
      transition(manifest, "VERIFYING");
      manifest.attempts += 1;
      manifest.lastVerificationStartedAt = new Date().toISOString();
      manifest.lastErrors = [];
      await writeManifest(manifest);
    }
    const startedAt = Date.now();
    let patch: PatchInspection;
    let checks: VerificationCheckResult[];
    let after: EvaluationReport;
    let before: EvaluationReport;
    try {
      patch = await inspectPatch(manifest, policy);
      await atomicWrite(
        join(await changeRoot(input.changeId), "change.patch"),
        patch.patch
      );
      checks = await runVerificationChecks(manifest, policy);
      await atomicJson(join(await changeRoot(input.changeId), "verification.json"), {
        schemaVersion: 1,
        checks
      });
      after = await new EvaluationService().scan({
        sourcePath: manifest.worktreePath,
        projectName: "private-change-run",
        retainSnapshot: false,
        ai: {
          requestedMode: "off",
          policy,
          allowCloudMetadata: false
        },
        generateEvidence: "none"
      });
      await atomicJson(
        join(await changeRoot(input.changeId), "after-report.json"),
        after
      );
      before = await readBaselineReport(input.changeId);
    } catch (error) {
      manifest.lastErrors = [
        error instanceof Error ? error.message : String(error)
      ];
      const repairAttempts = Math.max(0, manifest.attempts - 1);
      transition(
        manifest,
        repairAttempts < policy.change.maxRepairAttempts
          ? "REPAIR_REQUIRED"
          : "REVIEW_REQUIRED"
      );
      await writeManifest(manifest);
      throw error;
    }
    const targetClosed = !after.findings.some(
      (finding) => finding.id === manifest.targetFindingId
    );
    const regressionFree = noNewRegression(before, after);
    const errors = verificationErrors({
      targetClosed,
      regressionFree,
      checks
    });
    try {
      await assertOriginalIntegrity(manifest);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    const passed = errors.length === 0;
    const report: ChangeOutcomeReport = {
      schemaVersion: 1,
      kind: "auto-repoflow-change-outcome",
      before: {
        findingCount: before.findings.filter(
          (finding) => finding.ruleId === "ARF-TEST-001"
        ).length,
        testCoverage: testCoverage(before)
      },
      after: {
        findingCount: after.findings.filter(
          (finding) => finding.ruleId === "ARF-TEST-001"
        ).length,
        testCoverage: testCoverage(after)
      },
      verification: {
        status: passed ? "passed" : "failed",
        requiredChecks: checks.length,
        passedChecks: checks.filter((check) => check.passed).length,
        targetClosed,
        noNewRegression: regressionFree
      },
      patch: {
        bytes: patch.bytes,
        sha256: patch.sha256,
        filesChanged: patch.files.length,
        linesAdded: patch.linesAdded,
        linesDeleted: patch.linesDeleted
      },
      durationMs: Date.now() - startedAt,
      attempts: manifest.attempts,
      agentLabel: manifest.agentLabel
    };
    await atomicJson(join(await changeRoot(input.changeId), "outcome.json"), report);
    manifest.lastErrors = errors;
    if (passed) {
      transition(manifest, "VERIFIED_LOCAL_PATCH");
    } else {
      const repairAttempts = Math.max(0, manifest.attempts - 1);
      transition(
        manifest,
        repairAttempts < policy.change.maxRepairAttempts
          ? "REPAIR_REQUIRED"
          : "REVIEW_REQUIRED"
      );
    }
    await writeManifest(manifest);
    return { status: manifest.status, report };
  });
}

export async function readChangeOutcomeReport(
  changeId: string
): Promise<ChangeOutcomeReport> {
  const parsed = JSON.parse(
    await readFile(join(await changeRoot(changeId), "outcome.json"), "utf8")
  ) as ChangeOutcomeReport;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.kind !== "auto-repoflow-change-outcome"
  ) {
    throw new Error("ChangeOutcomeReport is invalid");
  }
  return parsed;
}

export async function cleanupChangeRun(input: {
  changeId: string;
  confirm: boolean;
}): Promise<{ changeId: string; status: "CLEANED" }> {
  if (!input.confirm) throw new Error("change cleanup requires --confirm");
  await withChangeLock(input.changeId, async () => {
    const manifest = await readManifest(input.changeId);
    const removed = await git(
      manifest.sourceRoot,
      ["worktree", "remove", "--force", manifest.worktreePath],
      { allowFailure: true }
    );
    if (removed.exitCode !== 0) {
      await git(manifest.sourceRoot, ["worktree", "prune"], {
        allowFailure: true
      });
      try {
        await stat(manifest.worktreePath);
        throw new Error(
          `Unable to remove isolated worktree: ${removed.stderr.trim()}`
        );
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
    }
    const branchRemoved = await git(
      manifest.sourceRoot,
      ["branch", "-D", manifest.branchName],
      { allowFailure: true }
    );
    if (branchRemoved.exitCode !== 0) {
      const branchExists = await git(
        manifest.sourceRoot,
        ["show-ref", "--verify", "--quiet", `refs/heads/${manifest.branchName}`],
        { allowFailure: true }
      );
      if (branchExists.exitCode === 0) {
        throw new Error(
          `Unable to remove ChangeRun branch: ${branchRemoved.stderr.trim()}`
        );
      }
    }
  });
  await rm(await changeRoot(input.changeId), { recursive: true, force: true });
  return { changeId: input.changeId, status: "CLEANED" };
}

export async function privateChangeRunPath(changeId: string): Promise<string> {
  return changeRoot(changeId);
}

export function isChangeTestPath(path: string): boolean {
  return isAllowedTestPath(path);
}

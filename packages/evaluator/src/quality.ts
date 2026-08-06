import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, join, sep } from "node:path";
import type { EvaluationPipelineConfig } from "./pipeline.js";

const MAX_OUTPUT_BYTES = 200_000;
const QUALITY_TOOL_PACKAGES: Record<string, string> = {
  eslint: "eslint",
  jest: "jest",
  tsc: "typescript",
  tslint: "tslint",
  vitest: "vitest"
};

export interface QualityCheckResult {
  id: string;
  tool: string;
  required: boolean;
  command: {
    tool: string;
    args: string[];
    shell: false;
  };
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  passed: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface QualityRunResult {
  passed: boolean;
  timeoutSeconds: number;
  checks: QualityCheckResult[];
}

function appendOutput(
  current: string,
  chunk: Buffer,
  state: { truncated: boolean }
): string {
  if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) {
    state.truncated = true;
    return current;
  }
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current);
  if (chunk.byteLength > remaining) {
    state.truncated = true;
  }
  return current + chunk.subarray(0, remaining).toString("utf8");
}

function sanitizedEnvironment(input: {
  sourcePath: string;
  qualityHome: string;
  qualityTmp: string;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: [
      join(input.sourcePath, "node_modules", ".bin"),
      dirname(process.execPath),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin"
    ].join(delimiter),
    HOME: input.qualityHome,
    USERPROFILE: input.qualityHome,
    TMPDIR: input.qualityTmp,
    TEMP: input.qualityTmp,
    TMP: input.qualityTmp,
    CI: "true",
    NODE_ENV: "test",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false"
  };
  for (const name of ["LANG", "LC_ALL", "TZ", "SystemRoot", "WINDIR"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

async function resolveLocalTool(
  sourcePath: string,
  tool: string
): Promise<{ command: string; prefixArgs: string[] }> {
  const nodeModulesRoot = await realpath(join(sourcePath, "node_modules"));
  const packageName = QUALITY_TOOL_PACKAGES[tool];
  if (!packageName) throw new Error(`Quality tool ${tool} is not supported`);
  const packageRoot = await realpath(join(nodeModulesRoot, packageName));
  if (!packageRoot.startsWith(`${nodeModulesRoot}${sep}`)) {
    throw new Error(`Quality tool ${tool} resolves outside local node_modules`);
  }
  const packageDocument = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8")
  ) as { bin?: string | Record<string, string> };
  const relativeBinary =
    typeof packageDocument.bin === "string"
      ? packageDocument.bin
      : packageDocument.bin?.[tool];
  if (!relativeBinary) {
    throw new Error(`Quality tool ${tool} has no package-local executable`);
  }
  const binary = await realpath(join(packageRoot, relativeBinary));
  const binaryStat = await stat(binary);
  if (!binaryStat.isFile()) {
    throw new Error(`Quality tool ${tool} is not a file`);
  }
  if (!binary.startsWith(`${nodeModulesRoot}${sep}`)) {
    throw new Error(`Quality tool ${tool} resolves outside local node_modules`);
  }
  return { command: process.execPath, prefixArgs: [binary] };
}

async function runCheck(input: {
  sourcePath: string;
  qualityHome: string;
  qualityTmp: string;
  timeoutSeconds: number;
  check: NonNullable<EvaluationPipelineConfig["quality"]>["checks"][number];
}): Promise<QualityCheckResult> {
  const executable = await resolveLocalTool(
    input.sourcePath,
    input.check.tool
  );
  const startedAt = Date.now();
  const truncation = { truncated: false };
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const outcome = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolvePromise, rejectPromise) => {
    const child = spawn(
      executable.command,
      [...executable.prefixArgs, ...input.check.args],
      {
        cwd: input.sourcePath,
        shell: false,
        env: sanitizedEnvironment(input),
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk, truncation);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk, truncation);
    });
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, input.timeoutSeconds * 1_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      rejectPromise(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolvePromise({ exitCode, signal });
    });
  });

  return {
    id: input.check.id,
    tool: input.check.tool,
    required: input.check.required,
    command: {
      tool: input.check.tool,
      args: input.check.args,
      shell: false
    },
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut,
    durationMs: Date.now() - startedAt,
    passed: !timedOut && outcome.exitCode === 0,
    stdout,
    stderr,
    outputTruncated: truncation.truncated
  };
}

export async function runQualityChecks(input: {
  sourcePath: string;
  evaluationDirectory: string;
  quality: NonNullable<EvaluationPipelineConfig["quality"]>;
}): Promise<QualityRunResult> {
  const qualityHome = join(input.evaluationDirectory, "quality-home");
  const qualityTmp = join(input.evaluationDirectory, "quality-tmp");
  await mkdir(qualityHome, { recursive: true, mode: 0o700 });
  await mkdir(qualityTmp, { recursive: true, mode: 0o700 });
  const checks: QualityCheckResult[] = [];
  for (const check of input.quality.checks) {
    try {
      checks.push(
        await runCheck({
          sourcePath: input.sourcePath,
          qualityHome,
          qualityTmp,
          timeoutSeconds: input.quality.timeoutSeconds,
          check
        })
      );
    } catch (error) {
      checks.push({
        id: check.id,
        tool: check.tool,
        required: check.required,
        command: { tool: check.tool, args: check.args, shell: false },
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: 0,
        passed: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        outputTruncated: false
      });
    }
  }
  return {
    passed: checks.every((item) => !item.required || item.passed),
    timeoutSeconds: input.quality.timeoutSeconds,
    checks
  };
}

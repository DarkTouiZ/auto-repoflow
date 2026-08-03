#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  EvaluationService,
  createAgentFixPacket,
  formatAgentFixPacketMarkdown,
  formatHumanReport
} from "@auto-repoflow/evaluator";

const VERSION = "0.1.1";
const scanFormats = ["human", "json", "agent-md", "agent-json"] as const;
type ScanFormat = (typeof scanFormats)[number];

function parseArguments(values: string[]): {
  flags: Map<string, string>;
  positionals: string[];
} {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals > 2) {
      flags.set(value.slice(2, equals), value.slice(equals + 1));
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(value.slice(2), "true");
    } else {
      flags.set(value.slice(2), next);
      index += 1;
    }
  }
  return { flags, positionals };
}

function requireFlag(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value || value === "true") {
    throw new Error(`Missing value for --${name}`);
  }
  return value;
}

function optionalFlag(
  values: Map<string, string>,
  name: string
): string | undefined {
  if (!values.has(name)) return undefined;
  return requireFlag(values, name);
}

function printHelp(): void {
  console.log(`Auto-RepoFlow ${VERSION}

Quick start:
  auto-repoflow scan [path]
  auto-repoflow scan [path] --format agent-md --out fix-packet.md
  auto-repoflow scan [path] --format agent-json --out fix-packet.json

Scan options:
  --project <label>     Private project label (defaults to directory name)
  --format <format>     human | json | agent-md | agent-json
  --out <file>          Write the selected output to a file
  --mode <mode>         rules | local-ai (default: rules)
  --keep-snapshot       Retain the filtered raw snapshot after a successful scan

Safe default:
  scan creates a filtered private snapshot and performs static evaluation only.
  It removes the raw snapshot after a successful scan unless --keep-snapshot is set.
  It does not run repository scripts, edit source files, call cloud AI, merge, or deploy.

Advanced evaluation workflow:
  eval pipeline --config <private-config.yaml>
  eval snapshot --source <path> --project <name>
  eval validate --id <evaluation-id>
  eval attach --id <evaluation-id> --file <path> --as design-flow.yaml
  eval run --id <evaluation-id> [--mode rules|local-ai] [--scope-prefix <path>]
  eval report --id <evaluation-id>
  eval score --id <evaluation-id> --ledger <known-gaps.json>
  eval export-public --id <evaluation-id>
  eval purge --id <evaluation-id>
  eval purge-expired [--days 7]

Other:
  doctor               Check the local runtime
  --version            Print the installed version
  help                 Show this help

Private artifacts stay under ~/.autorepoflow-private and are never pushed.`);
}

function scanFormat(value: string | undefined): ScanFormat {
  const format = value ?? "human";
  if (!scanFormats.includes(format as ScanFormat)) {
    throw new Error(`--format must be one of: ${scanFormats.join(", ")}`);
  }
  return format as ScanFormat;
}

function renderScanOutput(
  format: ScanFormat,
  report: Awaited<ReturnType<EvaluationService["scan"]>>
): string {
  if (format === "human") return formatHumanReport(report);
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  const packet = createAgentFixPacket(report);
  if (format === "agent-md") return formatAgentFixPacketMarkdown(packet);
  return `${JSON.stringify(packet, null, 2)}\n`;
}

async function emitOutput(contents: string, outputPath?: string): Promise<void> {
  if (!outputPath) {
    process.stdout.write(contents);
    return;
  }
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents, { mode: 0o600 });
  console.log(`Wrote ${destination}`);
}

function runDoctor(): void {
  const checks = [
    {
      name: "Node.js 22+",
      required: true,
      result: {
        ok: Number(process.versions.node.split(".")[0]) >= 22,
        detail: process.version
      }
    },
    {
      name: "Git (optional advanced workflows)",
      required: false,
      command: ["git", "--version"]
    },
    {
      name: "Ollama (optional local AI)",
      required: false,
      command: ["ollama", "list"]
    }
  ];
  let failedRequired = false;
  for (const check of checks) {
    const execution = check.command
      ? spawnSync(check.command[0], check.command.slice(1), {
          encoding: "utf8",
          timeout: 5_000
        })
      : undefined;
    const result =
      check.result ??
      ({
        ok: execution?.status === 0,
        detail: (execution?.stdout || execution?.stderr || "unavailable")
          .trim()
          .split("\n")[0]
      } as const);
    const level = result.ok ? "PASS" : check.required ? "FAIL" : "WARN";
    console.log(`${level.padEnd(4)} ${check.name}: ${result.detail}`);
    failedRequired ||= check.required && !result.ok;
  }
  if (failedRequired) process.exitCode = 1;
}

async function runScan(args: string[]): Promise<void> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    printHelp();
    return;
  }
  const { flags, positionals } = parseArguments(args);
  const supportedFlags = new Set([
    "project",
    "format",
    "out",
    "mode",
    "keep-snapshot"
  ]);
  const unknownFlags = [...flags.keys()].filter(
    (name) => !supportedFlags.has(name)
  );
  if (unknownFlags.length > 0) {
    throw new Error(
      `Unknown scan option(s): ${unknownFlags.map((name) => `--${name}`).join(", ")}`
    );
  }
  if (positionals.length > 1) {
    throw new Error("scan accepts at most one repository path");
  }
  const mode = optionalFlag(flags, "mode") ?? "rules";
  if (mode !== "rules" && mode !== "local-ai") {
    throw new Error("--mode must be rules or local-ai");
  }
  const keepSnapshotValue = flags.get("keep-snapshot");
  if (keepSnapshotValue !== undefined && keepSnapshotValue !== "true") {
    throw new Error("--keep-snapshot does not accept a value");
  }
  const report = await new EvaluationService().scan({
    sourcePath: resolve(positionals[0] ?? "."),
    projectName: optionalFlag(flags, "project"),
    mode,
    retainSnapshot: keepSnapshotValue === "true"
  });
  await emitOutput(
    renderScanOutput(scanFormat(optionalFlag(flags, "format")), report),
    optionalFlag(flags, "out")
  );
}

async function runEvaluation(action: string | undefined, args: string[]): Promise<void> {
  if (!action) throw new Error("Missing eval action");
  const { flags: values } = parseArguments(args);
  const service = new EvaluationService();
  if (action === "pipeline") {
    console.log(
      JSON.stringify(
        await service.runPipeline(resolve(requireFlag(values, "config"))),
        null,
        2
      )
    );
    return;
  }
  if (action === "purge-expired") {
    const days = Number(values.get("days") ?? "7");
    console.log(
      JSON.stringify(await service.purgeExpiredRawArtifacts(days), null, 2)
    );
    return;
  }
  if (action === "snapshot") {
    const result = await service.snapshot({
      sourcePath: resolve(requireFlag(values, "source")),
      projectName: requireFlag(values, "project")
    });
    console.log(
      JSON.stringify(
        {
          evaluationId: result.evaluationId,
          status: "READY",
          includedFiles: result.manifest.files.length,
          excludedFiles: result.manifest.decisions.filter(
            (item) => item.decision === "EXCLUDED"
          ).length,
          manifestSha256: result.manifest.manifestSha256
        },
        null,
        2
      )
    );
    return;
  }

  const evaluationId = requireFlag(values, "id");
  if (action === "attach") {
    console.log(
      JSON.stringify(
        await service.attachEvidence({
          evaluationId,
          filePath: resolve(requireFlag(values, "file")),
          alias: requireFlag(values, "as")
        }),
        null,
        2
      )
    );
  } else if (action === "validate") {
    const result = await service.validate(evaluationId);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 2;
  } else if (action === "run") {
    const mode = values.get("mode") ?? "rules";
    if (mode !== "rules" && mode !== "local-ai") {
      throw new Error("--mode must be rules or local-ai");
    }
    const report = await service.run({
      evaluationId,
      mode,
      scopePrefix: values.get("scope-prefix")
    });
    console.log(
      JSON.stringify(
        {
          evaluationId,
          status: report.status,
          summary: report.summary,
          coverage: report.coverage
        },
        null,
        2
      )
    );
  } else if (action === "report") {
    console.log(JSON.stringify(await service.report(evaluationId), null, 2));
  } else if (action === "score") {
    console.log(
      JSON.stringify(
        await service.score(
          evaluationId,
          resolve(requireFlag(values, "ledger"))
        ),
        null,
        2
      )
    );
  } else if (action === "export-public") {
    const result = await service.exportPublic(evaluationId);
    console.log(JSON.stringify({ path: result.path, report: result.report }, null, 2));
  } else if (action === "purge") {
    await service.purgeArtifacts(evaluationId);
    console.log(
      JSON.stringify(
        { evaluationId, status: "RAW_ARTIFACTS_PURGED" },
        null,
        2
      )
    );
  } else {
    throw new Error(`Unknown eval action: ${action}`);
  }
}

async function main(): Promise<void> {
  const [command = "help", action, ...rest] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }
  if (command === "doctor") {
    runDoctor();
    return;
  }
  if (command === "scan") {
    await runScan([action, ...rest].filter((value): value is string => Boolean(value)));
    return;
  }
  if (command === "eval") {
    await runEvaluation(action, rest);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

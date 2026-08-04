#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_AUTOMATION_POLICY,
  EvaluationService,
  approveEvidenceDraft,
  createAgentFixPacket,
  createCompatibleReport,
  exportEvidenceDrafts,
  exportLocalMetrics,
  formatAgentFixPacketMarkdown,
  formatHumanReport,
  listEvidenceDrafts,
  loadAutomationPolicy,
  summarizeLocalMetrics,
  validateEvidenceDraftFile,
  type AutomationPolicy
} from "@auto-repoflow/evaluator";
import type { AiProviderName, AiRequestMode } from "@auto-repoflow/domain";

const VERSION = "0.2.0";
const scanFormats = ["human", "json", "agent-md", "agent-json"] as const;
type ScanFormat = (typeof scanFormats)[number];

function parseArguments(values: string[]): {
  flags: Map<string, string>;
  positionals: string[];
} {
  const booleanFlags = new Set(["keep-snapshot", "allow-cloud-metadata"]);
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
    const flagName = value.slice(2);
    if (booleanFlags.has(flagName)) {
      flags.set(flagName, "true");
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

function absolutePolicyPath(value: string): string {
  if (!isAbsolute(value)) {
    throw new Error("--policy must be an absolute private file path");
  }
  return value;
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
  --compat <version>    v1 | v2 packet schema (default: v2)
  --out <file>          Write the selected output to a file
  --ai <mode>           auto | off | local | cloud (default: auto)
  --provider <name>     ollama | openai | anthropic | google
  --model <id>          Explicit provider model; models are never auto-pulled
  --policy <file>       Absolute private automation policy path
  --allow-cloud-metadata  Required consent flag for cloud metadata egress
  --generate-evidence <mode>  none | missing | all (default: missing)
  --mode <mode>         Deprecated: rules | local-ai
  --keep-snapshot       Retain the filtered raw snapshot after a successful scan

Safe default:
  scan creates a filtered private snapshot and deterministic rules report.
  auto probes only configured loopback Ollama and otherwise falls back to rules.
  Cloud AI never runs unless policy and --allow-cloud-metadata both allow it.
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

Headless evidence workflow:
  evidence list --id <evaluation-id>
  evidence validate --file <canonical-draft.json>
  evidence approve --id <evaluation-id> --review-manifest <yaml-or-json>
  evidence export --id <evaluation-id> --to <directory> --policy <file>
  purge [--policy <file>]  Apply private snapshot/report retention policy
  metrics summary
  metrics export --to <file>  Export anonymized local aggregates only

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
  report: Awaited<ReturnType<EvaluationService["scan"]>>,
  compat: "v1" | "v2"
): string {
  if (format === "human") return formatHumanReport(report);
  if (format === "json") {
    return `${JSON.stringify(createCompatibleReport(report, compat), null, 2)}\n`;
  }
  const packet = createAgentFixPacket(report, { compat });
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
    "compat",
    "out",
    "ai",
    "provider",
    "model",
    "policy",
    "allow-cloud-metadata",
    "generate-evidence",
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
  const legacyMode = optionalFlag(flags, "mode");
  if (legacyMode && legacyMode !== "rules" && legacyMode !== "local-ai") {
    throw new Error("--mode must be rules or local-ai");
  }
  if (legacyMode && flags.has("ai")) {
    throw new Error("Use either --ai or deprecated --mode, not both");
  }
  let requestedMode = (optionalFlag(flags, "ai") ?? "auto") as AiRequestMode;
  if (!["auto", "off", "local", "cloud"].includes(requestedMode)) {
    throw new Error("--ai must be auto, off, local, or cloud");
  }
  if (legacyMode) {
    console.error(
      "WARN --mode is deprecated and will be removed after the 0.2.x line; use --ai"
    );
    requestedMode = legacyMode === "rules" ? "off" : "local";
  }
  const legacyProviderEnvironment = process.env.ARF_AI_PROVIDER?.trim();
  if (!legacyMode && !flags.has("ai") && legacyProviderEnvironment) {
    if (!["mock", "ollama"].includes(legacyProviderEnvironment)) {
      throw new Error(
        "Legacy ARF_AI_PROVIDER supports only mock or ollama; cloud requires explicit CLI consent"
      );
    }
    console.error(
      "WARN ARF_AI_PROVIDER is deprecated and will be removed after the 0.2.x line; use --ai and --provider"
    );
    requestedMode = legacyProviderEnvironment === "mock" ? "off" : "local";
  }
  if (!flags.has("model") && process.env.ARF_OLLAMA_MODEL) {
    console.error(
      "WARN ARF_OLLAMA_MODEL is deprecated and will be removed after the 0.2.x line; use --model or a private policy"
    );
  }
  const providerText = optionalFlag(flags, "provider");
  if (
    providerText &&
    !["ollama", "openai", "anthropic", "google"].includes(providerText)
  ) {
    throw new Error(
      "--provider must be ollama, openai, anthropic, or google"
    );
  }
  const provider = providerText as AiProviderName | undefined;
  if (requestedMode === "off" && (provider || flags.has("model"))) {
    throw new Error("--ai off cannot be combined with --provider or --model");
  }
  if (
    ["auto", "local"].includes(requestedMode) &&
    provider &&
    provider !== "ollama"
  ) {
    throw new Error(`${requestedMode} AI mode supports only Ollama`);
  }
  if (requestedMode === "cloud" && (!provider || provider === "ollama")) {
    throw new Error("--ai cloud requires --provider openai, anthropic, or google");
  }
  const allowCloudValue = flags.get("allow-cloud-metadata");
  if (allowCloudValue !== undefined && allowCloudValue !== "true") {
    throw new Error("--allow-cloud-metadata does not accept a value");
  }
  if (allowCloudValue === "true" && requestedMode !== "cloud") {
    throw new Error("--allow-cloud-metadata is valid only with --ai cloud");
  }
  const policyPath = optionalFlag(flags, "policy");
  if (requestedMode === "cloud" && !policyPath) {
    throw new Error("--ai cloud requires an absolute private --policy file");
  }
  const policy: AutomationPolicy = policyPath
    ? await loadAutomationPolicy(absolutePolicyPath(policyPath))
    : DEFAULT_AUTOMATION_POLICY;
  const generateEvidence =
    optionalFlag(flags, "generate-evidence") ??
    (policy.evidence.generateMissing ? "missing" : "none");
  if (!["none", "missing", "all"].includes(generateEvidence)) {
    throw new Error("--generate-evidence must be none, missing, or all");
  }
  const keepSnapshotValue = flags.get("keep-snapshot");
  if (keepSnapshotValue !== undefined && keepSnapshotValue !== "true") {
    throw new Error("--keep-snapshot does not accept a value");
  }
  const compat = optionalFlag(flags, "compat") ?? "v2";
  if (compat !== "v1" && compat !== "v2") {
    throw new Error("--compat must be v1 or v2");
  }
  const report = await new EvaluationService().scan({
    sourcePath: resolve(positionals[0] ?? "."),
    projectName: optionalFlag(flags, "project"),
    retainSnapshot: keepSnapshotValue === "true",
    ai: {
      requestedMode,
      provider,
      model: optionalFlag(flags, "model"),
      policy,
      allowCloudMetadata: allowCloudValue === "true",
      onEgressSummary: (summary) => {
        console.error(
          `Cloud metadata egress: stage=${summary.stage} provider=${summary.provider} candidates=${summary.candidateCount} fields=${summary.fields.join(",")} payload_sha256=${summary.payloadSha256}`
        );
      }
    },
    generateEvidence: generateEvidence as "none" | "missing" | "all"
  });
  await emitOutput(
    renderScanOutput(
      scanFormat(optionalFlag(flags, "format")),
      report,
      compat
    ),
    optionalFlag(flags, "out")
  );
}

async function runEvidence(
  action: string | undefined,
  args: string[]
): Promise<void> {
  if (!action) throw new Error("Missing evidence action");
  const { flags, positionals } = parseArguments(args);
  if (positionals.length > 0) {
    throw new Error("Evidence commands accept named options only");
  }
  if (action === "list") {
    const evaluationId = requireFlag(flags, "id");
    const drafts = await listEvidenceDrafts(evaluationId);
    console.log(
      JSON.stringify(
        drafts.map((draft) => ({
          draftId: draft.draftId,
          kind: draft.kind,
          sha256: draft.sha256,
          reviewStatus: draft.reviewStatus,
          generator: draft.generator,
          provider: draft.provider,
          model: draft.model
        })),
        null,
        2
      )
    );
    return;
  }
  if (action === "validate") {
    const draft = await validateEvidenceDraftFile(
      resolve(requireFlag(flags, "file"))
    );
    console.log(
      JSON.stringify(
        {
          valid: true,
          draftId: draft.draftId,
          kind: draft.kind,
          sha256: draft.sha256,
          reviewStatus: draft.reviewStatus
        },
        null,
        2
      )
    );
    return;
  }
  if (action === "approve") {
    const result = await approveEvidenceDraft({
      evaluationId: requireFlag(flags, "id"),
      manifestPath: resolve(requireFlag(flags, "review-manifest"))
    });
    console.log(
      JSON.stringify(
        {
          draftId: result.draft.draftId,
          draftSha256: result.draft.sha256,
          decision: result.review.decision,
          reviewerId: result.review.reviewerId
        },
        null,
        2
      )
    );
    return;
  }
  if (action === "export") {
    const policyPath = absolutePolicyPath(requireFlag(flags, "policy"));
    const result = await exportEvidenceDrafts({
      evaluationId: requireFlag(flags, "id"),
      destination: resolve(requireFlag(flags, "to")),
      policy: await loadAutomationPolicy(policyPath)
    });
    console.log(JSON.stringify({ exported: result }, null, 2));
    return;
  }
  throw new Error(`Unknown evidence action: ${action}`);
}

async function runPurge(args: string[]): Promise<void> {
  const { flags, positionals } = parseArguments(args);
  if (positionals.length > 0) {
    throw new Error("purge accepts named options only");
  }
  const unknownFlags = [...flags.keys()].filter((name) => name !== "policy");
  if (unknownFlags.length > 0) {
    throw new Error(`Unknown purge option: --${unknownFlags[0]}`);
  }
  const policyPath = optionalFlag(flags, "policy");
  const policy = policyPath
    ? await loadAutomationPolicy(absolutePolicyPath(policyPath))
    : DEFAULT_AUTOMATION_POLICY;
  console.log(
    JSON.stringify(
      await new EvaluationService().purgeExpiredArtifacts(policy),
      null,
      2
    )
  );
}

async function runMetrics(
  action: string | undefined,
  args: string[]
): Promise<void> {
  const { flags, positionals } = parseArguments(args);
  if (positionals.length > 0) {
    throw new Error("metrics commands accept named options only");
  }
  if (action === "summary") {
    if (flags.size > 0) throw new Error("metrics summary accepts no options");
    console.log(JSON.stringify(await summarizeLocalMetrics(), null, 2));
    return;
  }
  if (action === "export") {
    const path = await exportLocalMetrics(requireFlag(flags, "to"));
    console.log(JSON.stringify({ path }, null, 2));
    return;
  }
  throw new Error(`Unknown metrics action: ${action ?? "missing"}`);
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

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const [command = "help", action, ...rest] = argv;
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
  if (command === "evidence") {
    await runEvidence(action, rest);
    return;
  }
  if (command === "purge") {
    await runPurge([action, ...rest].filter((value): value is string => Boolean(value)));
    return;
  }
  if (command === "metrics") {
    await runMetrics(action, rest);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (
  process.argv[1] &&
  (basename(process.argv[1]) === "auto-repoflow" ||
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

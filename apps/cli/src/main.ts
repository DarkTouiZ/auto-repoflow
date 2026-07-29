#!/usr/bin/env node

import { EvaluationService } from "@auto-repoflow/evaluator";

function flags(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      parsed.set(value.slice(2), "true");
    } else {
      parsed.set(value.slice(2), next);
      index += 1;
    }
  }
  return parsed;
}

function requireFlag(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required flag --${name}`);
  return value;
}

function printHelp(): void {
  console.log(`Auto-RepoFlow 0.1.0

Local evidence evaluation:
  eval snapshot --source <path> --project <name>
  eval validate --id <evaluation-id>
  eval run --id <evaluation-id> [--mode rules|local-ai] [--scope-prefix <path>]
  eval report --id <evaluation-id>
  eval score --id <evaluation-id> --ledger <known-gaps.json>
  eval export-public --id <evaluation-id>
  eval purge --id <evaluation-id>
  eval purge-expired [--days 7]

Other:
  doctor   Run local environment diagnostics with: npm run doctor
  help     Show this help

Private artifacts stay under ~/.autorepoflow-private and are never pushed.`);
}

async function main(): Promise<void> {
  const [command = "help", action, ...rest] = process.argv.slice(2);
  if (command === "help" || command === "--help") {
    printHelp();
    return;
  }
  if (command === "doctor") {
    console.log("Run `npm run doctor` from the repository root.");
    return;
  }
  if (command !== "eval" || !action) {
    throw new Error(`Unknown command: ${[command, action].filter(Boolean).join(" ")}`);
  }

  const values = flags(rest);
  const service = new EvaluationService();
  if (action === "purge-expired") {
    const days = Number(values.get("days") ?? "7");
    console.log(
      JSON.stringify(await service.purgeExpiredRawArtifacts(days), null, 2)
    );
    return;
  }
  if (action === "snapshot") {
    const result = await service.snapshot({
      sourcePath: requireFlag(values, "source"),
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
  if (action === "validate") {
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
        await service.score(evaluationId, requireFlag(values, "ledger")),
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

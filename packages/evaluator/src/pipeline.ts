import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse as parsePath, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { privacyDecisionFor } from "./privacy.js";

const evidenceSchema = z.object({
  filePath: z.string().min(1),
  alias: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      "Evidence alias must be a safe filename without directories"
    )
});

const qualityCheckSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  tool: z.enum(["tsc", "jest", "vitest", "eslint", "tslint"]),
  args: z
    .array(
      z
        .string()
        .min(1)
        .max(200)
        .refine(
          (value) =>
            !value.includes("\n") &&
            !value.includes("\r") &&
            !value.includes("..") &&
            !value.includes("://") &&
            !value.startsWith("/") &&
            !["--watch", "--watchAll", "--updateSnapshot", "-u"].includes(
              value
            ),
          "Quality arguments must be local, non-interactive and non-mutating"
        )
    )
    .max(30)
    .default([]),
  required: z.boolean().default(true)
});

export const evaluationPipelineConfigSchema = z.object({
  schemaVersion: z.literal(1),
  sourcePath: z.string().min(1),
  projectName: z.string().trim().min(1).max(120),
  mode: z.enum(["rules", "local-ai"]).default("rules"),
  scopePrefix: z.string().startsWith("/").optional(),
  evidence: z.array(evidenceSchema).max(20).default([]),
  quality: z
    .object({
      timeoutSeconds: z.number().int().min(1).max(900).default(300),
      checks: z.array(qualityCheckSchema).min(1).max(10)
    })
    .optional(),
  exportPublic: z.boolean().default(true)
});

export type EvaluationPipelineConfig = z.infer<
  typeof evaluationPipelineConfigSchema
>;

export async function loadEvaluationPipelineConfig(
  configPath: string
): Promise<EvaluationPipelineConfig> {
  if (!isAbsolute(configPath)) {
    throw new Error("Pipeline config path must be absolute");
  }
  const contents = await readFile(configPath, "utf8");
  const parsed = parseYaml(contents) as unknown;
  return evaluationPipelineConfigSchema.parse(parsed);
}

export async function preflightEvaluationPipelineConfig(
  config: EvaluationPipelineConfig
): Promise<void> {
  if (!isAbsolute(config.sourcePath)) {
    throw new Error("Pipeline sourcePath must be absolute");
  }
  const sourcePath = await realpath(resolve(config.sourcePath));
  const filesystemRoot = parsePath(sourcePath).root;
  if (
    sourcePath === filesystemRoot ||
    sourcePath === await realpath(resolve(homedir()))
  ) {
    throw new Error("Pipeline sourcePath must be a scoped repository directory");
  }
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isDirectory()) {
    throw new Error("Pipeline sourcePath must be a directory");
  }

  const aliases = new Set<string>();
  for (const item of config.evidence) {
    if (!isAbsolute(item.filePath)) {
      throw new Error(`Evidence path for ${item.alias} must be absolute`);
    }
    if (aliases.has(item.alias)) {
      throw new Error(`Duplicate evidence alias: ${item.alias}`);
    }
    aliases.add(item.alias);
    const decision = privacyDecisionFor(`.evaluation-input/${item.alias}`);
    if (decision.decision !== "INCLUDED") {
      throw new Error(
        `Evidence alias ${item.alias} rejected by privacy policy: ${decision.reason}`
      );
    }
    const evidenceStat = await stat(item.filePath);
    if (!evidenceStat.isFile()) {
      throw new Error(`Evidence path for ${item.alias} must be a file`);
    }
  }
  const qualityIds = new Set<string>();
  for (const check of config.quality?.checks ?? []) {
    if (qualityIds.has(check.id)) {
      throw new Error(`Duplicate quality check id: ${check.id}`);
    }
    qualityIds.add(check.id);
  }
}

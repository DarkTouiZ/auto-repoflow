import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AiProviderName } from "@auto-repoflow/domain";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const providerSchema = z.enum(["ollama", "openai", "anthropic", "google"]);
const modelMapSchema = z
  .object({
    ollama: z.string().trim().min(1).max(200).optional(),
    openai: z.string().trim().min(1).max(200).optional(),
    anthropic: z.string().trim().min(1).max(200).optional(),
    google: z.string().trim().min(1).max(200).optional()
  })
  .strict()
  .default({});

export const automationPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    ai: z
      .object({
        allowedProviders: z
          .array(providerSchema)
          .max(4)
          .default(["ollama"]),
        cloudMetadataAllowed: z.boolean().default(false),
        models: modelMapSchema,
        timeoutSeconds: z.number().int().min(5).max(300).default(60),
        batchSize: z.number().int().min(1).max(100).default(50),
        maxBatches: z.number().int().min(1).max(20).default(10),
        retries: z.number().int().min(0).max(2).default(1)
      })
      .strict()
      .default({}),
    evidence: z
      .object({
        generateMissing: z.boolean().default(true),
        exportRoots: z.array(z.string().min(1)).max(20).default([]),
        failedSnapshotRetentionHours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .default(24),
        artifactRetentionDays: z.number().int().min(1).max(90).default(7)
      })
      .strict()
      .default({}),
    automation: z
      .object({
        maxStage: z
          .enum(["fix-packet", "local-patch", "draft-pr"])
          .default("fix-packet")
      })
      .strict()
      .default({}),
    github: z
      .object({ forgeUploadAllowed: z.boolean().default(false) })
      .strict()
      .default({})
  })
  .strict();

export const changeVerificationCheckSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    runner: z.enum(["node", "project-local"]),
    tool: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
    args: z.array(z.string().max(500)).max(40).default([]),
    required: z.literal(true).default(true)
  })
  .strict()
  .superRefine((check, context) => {
    if (check.runner === "node" && check.tool) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tool"],
        message: "node checks must use the bundled Node.js executable"
      });
    }
    if (check.runner === "node" && check.args[0] !== "--test") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["args"],
        message: "node checks must start with --test"
      });
    }
    if (check.runner === "project-local" && !check.tool) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tool"],
        message: "project-local checks require a tool name"
      });
    }
  });

export const changeAutomationPolicySchema = automationPolicySchema
  .extend({
    schemaVersion: z.literal(2),
    change: z
      .object({
        enabled: z.literal(true),
        maxFiles: z.number().int().min(1).max(5).default(5),
        maxPatchBytes: z
          .number()
          .int()
          .min(1)
          .max(200_000)
          .default(200_000),
        maxRepairAttempts: z.number().int().min(0).max(2).default(2),
        protectedPaths: z
          .array(z.string().min(1).max(200))
          .max(50)
          .default([
            ".git",
            ".github",
            ".autorepoflow",
            "package.json",
            "package-lock.json",
            "npm-shrinkwrap.json"
          ]),
        verification: z
          .object({
            timeoutSeconds: z.number().int().min(5).max(600),
            checks: z.array(changeVerificationCheckSchema).min(1).max(10)
          })
          .strict()
      })
      .strict()
  })
  .superRefine((policy, context) => {
    if (policy.automation.maxStage !== "local-patch") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["automation", "maxStage"],
        message: "ChangeRun policy must set automation.maxStage to local-patch"
      });
    }
    const ids = policy.change.verification.checks.map((check) => check.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["change", "verification", "checks"],
        message: "verification check IDs must be unique"
      });
    }
  });

export type AutomationPolicyV1 = z.infer<typeof automationPolicySchema>;
export type ChangeAutomationPolicy = z.infer<
  typeof changeAutomationPolicySchema
>;
export type AutomationPolicy = AutomationPolicyV1 | ChangeAutomationPolicy;

export const DEFAULT_AUTOMATION_POLICY: AutomationPolicy =
  automationPolicySchema.parse({ schemaVersion: 1 });

function rejectEmbeddedSecrets(value: unknown, path = "policy"): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (/(?:api.?key|token|secret|password|credential)/i.test(key)) {
      throw new Error(
        `Automation policy must not contain credentials (${childPath})`
      );
    }
    rejectEmbeddedSecrets(child, childPath);
  }
}

export async function loadAutomationPolicy(
  policyPath: string
): Promise<AutomationPolicy> {
  if (!isAbsolute(policyPath)) {
    throw new Error("Automation policy path must be absolute");
  }
  const metadata = await stat(policyPath);
  if (!metadata.isFile()) throw new Error("Automation policy must be a file");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("Automation policy must not be readable by group or others");
  }
  const contents = await readFile(policyPath, "utf8");
  const document = parseYaml(contents) as unknown;
  rejectEmbeddedSecrets(document);
  const schemaVersion =
    document && typeof document === "object" && "schemaVersion" in document
      ? (document as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  const policy =
    schemaVersion === 2
      ? changeAutomationPolicySchema.parse(document)
      : automationPolicySchema.parse(document);
  policy.evidence.exportRoots = policy.evidence.exportRoots.map((root) => {
    if (!isAbsolute(root)) {
      throw new Error("Evidence export roots in policy must be absolute");
    }
    return resolve(root);
  });
  return policy;
}

export function assertChangePolicy(
  policy: AutomationPolicy
): ChangeAutomationPolicy {
  if (policy.schemaVersion !== 2) {
    throw new Error(
      "ChangeRun requires a schemaVersion 2 policy; policy v1 remains scan-only"
    );
  }
  return changeAutomationPolicySchema.parse(policy);
}

export function modelForProvider(
  policy: AutomationPolicy,
  provider: AiProviderName,
  explicitModel?: string
): string | undefined {
  const explicit = explicitModel?.trim();
  const configured = policy.ai.models[provider];
  if (explicit && configured && explicit !== configured) {
    throw new Error(
      `AI model ${explicit} is not the policy-pinned model for ${provider}`
    );
  }
  return explicit || configured;
}

export function assertProviderAllowed(
  policy: AutomationPolicy,
  provider: AiProviderName
): void {
  if (!policy.ai.allowedProviders.includes(provider)) {
    throw new Error(`AI provider ${provider} is not allowed by policy`);
  }
}

export function assertCloudAuthorization(input: {
  policy: AutomationPolicy;
  provider: Exclude<AiProviderName, "ollama">;
  allowCloudMetadata: boolean;
  model?: string;
}): string {
  assertProviderAllowed(input.policy, input.provider);
  if (!input.policy.ai.cloudMetadataAllowed) {
    throw new Error("Cloud metadata access is disabled by policy");
  }
  if (!input.allowCloudMetadata) {
    throw new Error("Cloud metadata access requires --allow-cloud-metadata");
  }
  if (!input.policy.ai.models[input.provider]) {
    throw new Error(
      `Private policy must pin an allowed model for ${input.provider}`
    );
  }
  const model = modelForProvider(input.policy, input.provider, input.model);
  if (!model) throw new Error(`A model is required for ${input.provider}`);
  return model;
}

export function assertEvidenceExportAllowed(
  policy: AutomationPolicy,
  destination: string
): string {
  const resolved = resolve(destination);
  const allowed = policy.evidence.exportRoots.some((root) => {
    const rel = relative(root, resolved);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
  });
  if (!allowed) {
    throw new Error("Evidence export destination is outside policy export roots");
  }
  return resolved;
}

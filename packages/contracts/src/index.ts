import { z } from "zod";

export const providerProfileSchema = z.enum([
  "offline",
  "local",
  "cloud_allowed"
]);

export const projectRegistrationSchema = z.object({
  name: z.string().min(1),
  repositoryPath: z.string().min(1),
  defaultBranch: z.string().min(1).default("main"),
  providerProfile: providerProfileSchema.default("local"),
  forgeUploadAllowed: z.boolean().default(false)
});

export type ProjectRegistration = z.infer<typeof projectRegistrationSchema>;

export const healthResponseSchema = z.object({
  service: z.literal("auto-repoflow-api"),
  status: z.literal("ok"),
  version: z.string()
});

export const evaluationModeSchema = z.enum(["rules", "local-ai"]);

export const createEvaluationSchema = z.object({
  projectName: z.string().min(1).max(80),
  sourcePath: z.string().min(1),
  designFlowPath: z.string().min(1).optional(),
  mode: evaluationModeSchema.default("rules")
});

export const runEvaluationSchema = z.object({
  mode: evaluationModeSchema.default("rules"),
  scopePrefix: z.string().min(1).optional()
});

export type CreateEvaluationInput = z.infer<typeof createEvaluationSchema>;
export type RunEvaluationInput = z.infer<typeof runEvaluationSchema>;

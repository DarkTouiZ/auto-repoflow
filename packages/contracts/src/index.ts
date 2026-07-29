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

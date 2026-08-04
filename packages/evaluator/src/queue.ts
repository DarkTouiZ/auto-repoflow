import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  link,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, join } from "node:path";
import type { AiProviderName, AiRequestMode } from "@auto-repoflow/domain";
import { z } from "zod";
import { EvaluationService } from "./service.js";
import {
  DEFAULT_AUTOMATION_POLICY,
  loadAutomationPolicy,
  type AutomationPolicy
} from "./policy.js";
import { getPrivateRoot } from "./privacy.js";

export const automationJobRequestSchema = z
  .object({
    sourcePath: z.string().min(1),
    projectName: z.string().trim().min(1).max(80).optional(),
    ai: z.enum(["auto", "off", "local", "cloud"]).default("auto"),
    provider: z
      .enum(["ollama", "openai", "anthropic", "google"])
      .optional(),
    model: z.string().trim().min(1).max(200).optional(),
    allowCloudMetadata: z.boolean().default(false),
    generateEvidence: z.enum(["none", "missing", "all"]).default("missing"),
    retainSnapshot: z.boolean().default(false)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ai === "cloud" && (!value.provider || value.provider === "ollama")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: "Cloud jobs require openai, anthropic, or google"
      });
    }
    if (["auto", "local"].includes(value.ai) && value.provider && value.provider !== "ollama") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: "Auto and local jobs support only Ollama"
      });
    }
  });

export type AutomationJobRequest = z.infer<typeof automationJobRequestSchema>;

export interface AutomationJobStatus {
  schemaVersion: 1;
  jobId: string;
  status: "QUEUED" | "RUNNING" | "REPORT_READY" | "FAILED";
  createdAt: string;
  updatedAt: string;
  requestSha256: string;
  evaluationId?: string;
  errorCode?: string;
}

export interface SanitizedAutomationEvent {
  timestamp: string;
  jobId: string;
  type:
    | "QUEUED"
    | "CLAIMED"
    | "CLOUD_EGRESS_AUTHORIZED"
    | "REPORT_READY"
    | "FAILED"
    | "RECOVERED";
  terminal: boolean;
  evaluationId?: string;
  errorCode?: string;
  provider?: Exclude<AiProviderName, "ollama">;
  candidateCount?: number;
  payloadSha256?: string;
  stage?: "semantic-links" | "evidence-drafts";
}

interface StoredJobRequest extends AutomationJobRequest {
  schemaVersion: 1;
  jobId: string;
  createdAt: string;
  requestSha256: string;
}

interface QueueDirectories {
  root: string;
  pending: string;
  claimed: string;
  jobs: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error &&
    "code" in error &&
    /^AI_[A-Z_]+$/.test(String(error.code))
  ) {
    return String(error.code);
  }
  if (
    typeof error === "object" &&
    error &&
    "status" in error &&
    Number(error.status) === 429
  ) {
    return "AI_RATE_LIMITED";
  }
  if (error instanceof Error) {
    if (["TimeoutError", "AbortError"].includes(error.name)) {
      return "AI_TIMEOUT";
    }
    if (/API key is required/i.test(error.message)) return "AI_KEY_MISSING";
    if (/model is required|model.*not.*configured/i.test(error.message)) {
      return "AI_MODEL_NOT_CONFIGURED";
    }
    const name = error.name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
    return name || "AUTOMATION_FAILED";
  }
  return "AUTOMATION_FAILED";
}

async function queueDirectories(): Promise<QueueDirectories> {
  const privateRoot = await getPrivateRoot();
  const root = join(privateRoot, "queue");
  const directories = {
    root,
    pending: join(root, "pending"),
    claimed: join(root, "claimed"),
    jobs: join(root, "jobs")
  };
  await Promise.all(
    Object.values(directories).map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 })
    )
  );
  return directories;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
  await rename(temporary, path);
}

async function appendEvent(
  directories: QueueDirectories,
  event: SanitizedAutomationEvent
): Promise<void> {
  const jobDirectory = join(directories.jobs, event.jobId);
  await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
  const file = await open(join(jobDirectory, "events.ndjson"), "a", 0o600);
  try {
    await file.write(`${JSON.stringify(event)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function requestFingerprint(request: AutomationJobRequest): string {
  return hash(JSON.stringify(request));
}

function checkedJobId(jobId: string): string {
  return z.string().uuid().parse(jobId);
}

export class FileBackedAutomationQueue {
  async enqueue(input: unknown): Promise<{
    job: AutomationJobStatus;
    duplicate: boolean;
  }> {
    const request = automationJobRequestSchema.parse(input);
    const directories = await queueDirectories();
    const fingerprint = requestFingerprint(request);
    const jobEntries = await readdir(directories.jobs, { withFileTypes: true });
    for (const entry of jobEntries) {
      if (!entry.isDirectory()) continue;
      try {
        const existing = await readJson<AutomationJobStatus>(
          join(directories.jobs, entry.name, "status.json")
        );
        if (
          existing.requestSha256 === fingerprint &&
          ["QUEUED", "RUNNING"].includes(existing.status)
        ) {
          return { job: existing, duplicate: true };
        }
      } catch {
        // A partially written private job is ignored; atomic status writes repair it.
      }
    }

    const jobId = randomUUID();
    const now = new Date().toISOString();
    const stored: StoredJobRequest = {
      schemaVersion: 1,
      jobId,
      createdAt: now,
      requestSha256: fingerprint,
      ...request
    };
    const status: AutomationJobStatus = {
      schemaVersion: 1,
      jobId,
      status: "QUEUED",
      createdAt: now,
      updatedAt: now,
      requestSha256: fingerprint
    };
    const jobDirectory = join(directories.jobs, jobId);
    await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
    await atomicJson(join(jobDirectory, "request.json"), stored);
    await atomicJson(join(jobDirectory, "status.json"), status);
    await atomicJson(join(directories.pending, `${jobId}.json`), stored);
    await appendEvent(directories, {
      timestamp: now,
      jobId,
      type: "QUEUED",
      terminal: false
    });
    return { job: status, duplicate: false };
  }

  async status(jobId: string): Promise<AutomationJobStatus> {
    const directories = await queueDirectories();
    return readJson(
      join(directories.jobs, checkedJobId(jobId), "status.json")
    );
  }

  async events(jobId: string): Promise<SanitizedAutomationEvent[]> {
    const directories = await queueDirectories();
    const safeJobId = checkedJobId(jobId);
    const contents = await readFile(
      join(directories.jobs, safeJobId, "events.ndjson"),
      "utf8"
    );
    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SanitizedAutomationEvent);
  }

  async claimNext(): Promise<StoredJobRequest | undefined> {
    const directories = await queueDirectories();
    const names = (await readdir(directories.pending))
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of names) {
      const pendingPath = join(directories.pending, name);
      const claimedPath = join(directories.claimed, name);
      try {
        await link(pendingPath, claimedPath);
        await unlink(pendingPath);
      } catch (error) {
        if (
          typeof error === "object" &&
          error &&
          "code" in error &&
          ["ENOENT", "EEXIST"].includes(String(error.code))
        ) {
          continue;
        }
        throw error;
      }
      const request = await readJson<StoredJobRequest>(claimedPath);
      const now = new Date().toISOString();
      const status = await this.status(request.jobId);
      await atomicJson(join(directories.jobs, request.jobId, "status.json"), {
        ...status,
        status: "RUNNING",
        updatedAt: now
      } satisfies AutomationJobStatus);
      await appendEvent(directories, {
        timestamp: now,
        jobId: request.jobId,
        type: "CLAIMED",
        terminal: false
      });
      return request;
    }
    return undefined;
  }

  async recoverStaleClaims(maxAgeMs = 5 * 60 * 1000): Promise<string[]> {
    const directories = await queueDirectories();
    const names = (await readdir(directories.claimed)).filter((name) =>
      name.endsWith(".json")
    );
    const recovered: string[] = [];
    for (const name of names) {
      const claimedPath = join(directories.claimed, name);
      const metadata = await stat(claimedPath);
      if (Date.now() - metadata.mtimeMs < maxAgeMs) continue;
      const jobId = basename(name, ".json");
      try {
        await rename(claimedPath, join(directories.pending, name));
      } catch (error) {
        if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      const status = await this.status(jobId);
      const now = new Date().toISOString();
      await atomicJson(join(directories.jobs, jobId, "status.json"), {
        ...status,
        status: "QUEUED",
        updatedAt: now
      } satisfies AutomationJobStatus);
      await appendEvent(directories, {
        timestamp: now,
        jobId,
        type: "RECOVERED",
        terminal: false
      });
      recovered.push(jobId);
    }
    return recovered;
  }

  async processNext(policy?: AutomationPolicy): Promise<AutomationJobStatus | undefined> {
    const request = await this.claimNext();
    if (!request) return undefined;
    const directories = await queueDirectories();
    const claimedPath = join(directories.claimed, `${request.jobId}.json`);
    const current = await this.status(request.jobId);
    try {
      const report = await new EvaluationService().scan({
        sourcePath: request.sourcePath,
        projectName: request.projectName,
        retainSnapshot: request.retainSnapshot,
        generateEvidence: request.generateEvidence,
        ai: {
          requestedMode: request.ai as AiRequestMode,
          provider: request.provider as AiProviderName | undefined,
          model: request.model,
          allowCloudMetadata: request.allowCloudMetadata,
          policy: policy ?? DEFAULT_AUTOMATION_POLICY,
          onEgressSummary: async (summary) => {
            await appendEvent(directories, {
              timestamp: new Date().toISOString(),
              jobId: request.jobId,
              type: "CLOUD_EGRESS_AUTHORIZED",
              terminal: false,
              provider: summary.provider,
              stage: summary.stage,
              candidateCount: summary.candidateCount,
              payloadSha256: summary.payloadSha256
            });
          }
        }
      });
      const completed: AutomationJobStatus = {
        ...current,
        status: "REPORT_READY",
        updatedAt: new Date().toISOString(),
        evaluationId: report.evaluationId
      };
      await atomicJson(
        join(directories.jobs, request.jobId, "status.json"),
        completed
      );
      await appendEvent(directories, {
        timestamp: completed.updatedAt,
        jobId: request.jobId,
        type: "REPORT_READY",
        terminal: true,
        evaluationId: report.evaluationId
      });
      return completed;
    } catch (error) {
      const failed: AutomationJobStatus = {
        ...current,
        status: "FAILED",
        updatedAt: new Date().toISOString(),
        errorCode: errorCode(error)
      };
      await atomicJson(
        join(directories.jobs, request.jobId, "status.json"),
        failed
      );
      await appendEvent(directories, {
        timestamp: failed.updatedAt,
        jobId: request.jobId,
        type: "FAILED",
        terminal: true,
        errorCode: failed.errorCode
      });
      return failed;
    } finally {
      await unlink(claimedPath).catch(() => undefined);
    }
  }
}

export async function loadServerAutomationPolicy(): Promise<AutomationPolicy> {
  const path = process.env.ARF_POLICY_PATH;
  return path ? loadAutomationPolicy(path) : DEFAULT_AUTOMATION_POLICY;
}

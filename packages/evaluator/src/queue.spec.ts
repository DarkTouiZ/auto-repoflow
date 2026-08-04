import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBackedAutomationQueue } from "./queue.js";
import { summarizeLocalMetrics } from "./metrics.js";

const previousHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = previousHome;
});

describe("file-backed automation queue", () => {
  it("deduplicates active jobs and allows only one atomic claim", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-queue-"));
    process.env.HOME = join(sandbox, "home");
    const source = join(sandbox, "repository");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "index.ts"), "export const value = 1;");
    const firstQueue = new FileBackedAutomationQueue();
    const secondQueue = new FileBackedAutomationQueue();
    const first = await firstQueue.enqueue({ sourcePath: source, ai: "off" });
    const duplicate = await secondQueue.enqueue({ sourcePath: source, ai: "off" });
    expect(first.duplicate).toBe(false);
    expect(duplicate).toMatchObject({ duplicate: true, job: { jobId: first.job.jobId } });

    const claims = await Promise.all([
      firstQueue.claimNext(),
      secondQueue.claimNext()
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(firstQueue.recoverStaleClaims(0)).resolves.toEqual([
      first.job.jobId
    ]);
    await expect(firstQueue.status(first.job.jobId)).resolves.toMatchObject({
      status: "QUEUED"
    });
    await expect(firstQueue.claimNext()).resolves.toMatchObject({
      jobId: first.job.jobId
    });
  });

  it("runs snapshot through report and stores sanitized terminal events", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-worker-"));
    process.env.HOME = join(sandbox, "home");
    const source = join(sandbox, "SecretCompanyRepository");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "index.ts"), "export const companySecret = 1;");
    const queue = new FileBackedAutomationQueue();
    const { job } = await queue.enqueue({
      sourcePath: source,
      projectName: "SecretCompany",
      ai: "off",
      generateEvidence: "missing"
    });
    const completed = await queue.processNext();
    expect(completed).toMatchObject({ jobId: job.jobId, status: "REPORT_READY" });
    const eventText = JSON.stringify(await queue.events(job.jobId));
    expect(eventText).not.toContain(source);
    expect(eventText).not.toContain("SecretCompany");
    expect(eventText).not.toContain("companySecret");
    const metricsText = JSON.stringify(await summarizeLocalMetrics());
    expect(metricsText).not.toContain(source);
    expect(metricsText).not.toContain("SecretCompany");
    expect(metricsText).not.toContain("companySecret");
  });
});

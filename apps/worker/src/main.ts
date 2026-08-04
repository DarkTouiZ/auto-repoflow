import {
  FileBackedAutomationQueue,
  loadServerAutomationPolicy
} from "@auto-repoflow/evaluator";

const queue = new FileBackedAutomationQueue();
const once = process.argv.includes("--once");
const pollIntervalMs = Number(process.env.ARF_WORKER_POLL_MS ?? "1000");

if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 100) {
  throw new Error("ARF_WORKER_POLL_MS must be at least 100 milliseconds");
}

const policy = await loadServerAutomationPolicy();
await queue.recoverStaleClaims();

do {
  const result = await queue.processNext(policy);
  if (result) {
    console.log(
      JSON.stringify({
        jobId: result.jobId,
        status: result.status,
        evaluationId: result.evaluationId ?? null,
        errorCode: result.errorCode ?? null
      })
    );
  }
  if (once) break;
  await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
} while (true);

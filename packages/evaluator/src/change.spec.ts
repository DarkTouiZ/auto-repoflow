import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CHANGE_TRANSITIONS,
  changeRunStatus,
  cleanupChangeRun,
  isChangeTestPath,
  readChangeOutcomeReport,
  startChangeRun,
  verifyChangeRun
} from "./change.js";
import {
  automationPolicySchema,
  changeAutomationPolicySchema
} from "./policy.js";

const previousHome = process.env.HOME;

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fixture(): Promise<{
  sandbox: string;
  repository: string;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), "arf-change-"));
  const repository = join(sandbox, "repository");
  process.env.HOME = join(sandbox, "home");
  await mkdir(join(repository, "tests"), { recursive: true });
  await writeFile(
    join(repository, "package.json"),
    `${JSON.stringify(
      {
        name: "milemesh-lite",
        private: true,
        type: "module",
        scripts: {
          test: "node --test",
          build: "node --check routes.js",
          typecheck: "node --check routes.js"
        }
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(repository, "routes.js"),
    `const router = { get() {}, patch() {} };
router.get("/api/deliveries", listDeliveries);
router.patch("/api/deliveries/:id/status", updateDeliveryStatus);
export function listDeliveries(rows = []) { return rows; }
export function updateDeliveryStatus(row, status) { return { ...row, status }; }
`
  );
  await writeFile(
    join(repository, "tests", "routes.test.js"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { updateDeliveryStatus } from "../routes.js";
test("PATCH /api/deliveries/:id/status", () => {
  assert.equal(updateDeliveryStatus({ id: 1 }, "sent").status, "sent");
});
`
  );
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "fixture@example.invalid");
  git(repository, "config", "user.name", "AutoRepoFlow Fixture");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "fixture");
  return { sandbox, repository };
}

function policy() {
  return changeAutomationPolicySchema.parse({
    schemaVersion: 2,
    automation: { maxStage: "local-patch" },
    change: {
      enabled: true,
      maxFiles: 5,
      maxPatchBytes: 200_000,
      maxRepairAttempts: 2,
      verification: {
        timeoutSeconds: 30,
        checks: [{ id: "node-test", runner: "node", args: ["--test"] }]
      }
    }
  });
}

describe("verified local ChangeRun", () => {
  it("defines bounded state transitions and test-only path rules", () => {
    expect(CHANGE_TRANSITIONS.INTAKE).toEqual(["WORKTREE_READY"]);
    expect(CHANGE_TRANSITIONS.AWAITING_AGENT).toEqual(["VERIFYING"]);
    expect(CHANGE_TRANSITIONS.VERIFIED_LOCAL_PATCH).toEqual([]);
    expect(isChangeTestPath("src/widget.test.ts")).toBe(true);
    expect(isChangeTestPath("tests/widget.tsx")).toBe(true);
    expect(isChangeTestPath("src/widget.ts")).toBe(false);
    expect(isChangeTestPath("../tests/widget.ts")).toBe(false);
    expect(isChangeTestPath("package.json")).toBe(false);
  });

  it("creates an isolated worktree, verifies a test-only patch, and keeps the original clean", async () => {
    const { repository } = await fixture();
    const originalHead = git(repository, "rev-parse", "HEAD");
    const started = await startChangeRun({
      sourcePath: repository,
      policy: policy(),
      agentLabel: "Claude Desktop"
    });
    expect(started.status).toBe("AWAITING_AGENT");
    expect(started.agentLabel).toBe("claude-desktop");
    expect(git(repository, "status", "--porcelain")).toBe("");
    expect(git(repository, "rev-parse", "HEAD")).toBe(originalHead);

    const testPath = join(started.worktreePath, "tests", "routes.test.js");
    await writeFile(
      testPath,
      `${await readFile(testPath, "utf8")}
import { listDeliveries } from "../routes.js";
test("GET /api/deliveries", () => {
  assert.deepEqual(listDeliveries([{ id: 1 }]), [{ id: 1 }]);
});
`
    );
    const verified = await verifyChangeRun({
      changeId: started.changeId,
      policy: policy(),
      allowVerification: true
    });
    expect(verified.status).toBe("VERIFIED_LOCAL_PATCH");
    expect(verified.report.before).toMatchObject({
      findingCount: 1,
      testCoverage: { covered: 1, total: 2, percentage: 50 }
    });
    expect(verified.report.after).toMatchObject({
      findingCount: 0,
      testCoverage: { covered: 2, total: 2, percentage: 100 }
    });
    expect(verified.report.verification).toMatchObject({
      status: "passed",
      targetClosed: true,
      noNewRegression: true
    });
    expect(await readChangeOutcomeReport(started.changeId)).toEqual(
      verified.report
    );
    expect(JSON.stringify(verified.report)).not.toContain(repository);
    expect(JSON.stringify(verified.report)).not.toContain(originalHead);
    expect(JSON.stringify(verified.report)).not.toContain("finding:");
    expect(git(repository, "status", "--porcelain")).toBe("");
    expect(git(repository, "rev-parse", "HEAD")).toBe(originalHead);
    await cleanupChangeRun({ changeId: started.changeId, confirm: true });
  });

  it("rejects policy v1, dirty repositories, source edits, and missing command consent", async () => {
    const { repository } = await fixture();
    await expect(
      startChangeRun({
        sourcePath: repository,
        policy: automationPolicySchema.parse({ schemaVersion: 1 })
      })
    ).rejects.toThrow(/schemaVersion 2/);

    await writeFile(join(repository, "untracked.js"), "export const dirty = true;\n");
    await expect(
      startChangeRun({ sourcePath: repository, policy: policy() })
    ).rejects.toThrow(/clean Git checkout/);
    git(repository, "clean", "-f");

    const started = await startChangeRun({
      sourcePath: repository,
      policy: policy()
    });
    await writeFile(
      join(started.worktreePath, "routes.js"),
      `${await readFile(join(started.worktreePath, "routes.js"), "utf8")}\n// edit\n`
    );
    await expect(
      verifyChangeRun({
        changeId: started.changeId,
        policy: policy(),
        allowVerification: false
      })
    ).rejects.toThrow(/--allow-verification/);
    await expect(
      verifyChangeRun({
        changeId: started.changeId,
        policy: policy(),
        allowVerification: true
      })
    ).rejects.toThrow(/Only JavaScript\/TypeScript test files/);
    expect((await changeRunStatus(started.changeId)).status).toBe(
      "REPAIR_REQUIRED"
    );
    await writeFile(
      join(started.worktreePath, "routes.js"),
      `${git(started.worktreePath, "show", "HEAD:routes.js")}\n`
    );
    const testPath = join(started.worktreePath, "tests", "routes.test.js");
    await writeFile(
      testPath,
      `${await readFile(testPath, "utf8")}
import { listDeliveries } from "../routes.js";
test("GET /api/deliveries", () => {
  assert.deepEqual(listDeliveries([{ id: 1 }]), [{ id: 1 }]);
});
`
    );
    const repaired = await verifyChangeRun({
      changeId: started.changeId,
      policy: policy(),
      allowVerification: true
    });
    expect(repaired.status).toBe("VERIFIED_LOCAL_PATCH");
    expect(repaired.report.attempts).toBe(2);
    await cleanupChangeRun({ changeId: started.changeId, confirm: true });
  });

  it("resumes an interrupted VERIFYING state and recovers a stale lock", async () => {
    const { repository } = await fixture();
    const started = await startChangeRun({
      sourcePath: repository,
      policy: policy()
    });
    const testPath = join(started.worktreePath, "tests", "routes.test.js");
    await writeFile(
      testPath,
      `${await readFile(testPath, "utf8")}
import { listDeliveries } from "../routes.js";
test("GET /api/deliveries", () => {
  assert.deepEqual(listDeliveries([{ id: 1 }]), [{ id: 1 }]);
});
`
    );
    const runRoot = join(
      process.env.HOME as string,
      ".autorepoflow-private",
      "change-runs",
      started.changeId
    );
    const manifestPath = join(runRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.status = "VERIFYING";
    manifest.attempts = 1;
    manifest.lastVerificationStartedAt = new Date().toISOString();
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600
    });
    await writeFile(join(runRoot, ".lock"), '{"pid":999999999}\n', {
      mode: 0o600
    });
    const resumed = await verifyChangeRun({
      changeId: started.changeId,
      policy: policy(),
      allowVerification: true
    });
    expect(resumed.status).toBe("VERIFIED_LOCAL_PATCH");
    expect(resumed.report.attempts).toBe(1);
    await cleanupChangeRun({ changeId: started.changeId, confirm: true });
  });
});

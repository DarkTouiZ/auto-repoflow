import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReviewPacket, formatReviewReport } from "./handoff.js";
import { reviewRepository } from "./review.js";
import { EvaluationService } from "./service.js";

const previousHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = previousHome;
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arf-review-"));
  process.env.HOME = await mkdtemp(join(tmpdir(), "arf-review-home-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "t@t.co"]);
  git(root, ["config", "user.name", "t"]);
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents);
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

describe("review command", () => {
  it("reports no in-scope findings on a clean tree", async () => {
    const root = await repo({
      "src/orders.ts": 'router.get("/api/orders", listOrders);'
    });
    const result = await reviewRepository(new EvaluationService(), root, {
      scope: "worktree"
    });
    expect(result.changeSet.files).toHaveLength(0);
    expect(result.scopedFindings).toHaveLength(0);
  });

  it("flags a changed source file with no test changes", async () => {
    const root = await repo({
      "src/orders.ts": 'router.get("/api/orders", listOrders);',
      "package.json": JSON.stringify({ name: "d", scripts: { test: "v" } })
    });
    await appendFile(
      join(root, "src/orders.ts"),
      '\nrouter.post("/api/orders", createOrder);\n'
    );
    const result = await reviewRepository(new EvaluationService(), root, {
      scope: "worktree"
    });
    expect(result.changeSet.files.map((f) => f.path)).toContain("src/orders.ts");
    expect(
      result.scopedFindings.some(
        (f) => f.ruleId === "ARF-CHANGE-UNTESTED-001"
      )
    ).toBe(true);
    // Findings in unchanged files are not counted in scope.
    const packet = createReviewPacket({
      projectName: "d",
      baseRef: result.changeSet.baseRef,
      changedFiles: result.changeSet.files.map((f) => f.path),
      findings: result.scopedFindings,
      baselines: result.baselines,
      totalFindings: result.report.findings.length,
      outOfScopeCount: result.outOfScopeCount
    });
    expect(packet.kind).toBe("auto-repoflow-review-packet");
    expect(packet.scope.allowedFiles).toEqual(["src/orders.ts"]);
    expect(packet.metrics.packet.bytes).toBeGreaterThan(0);
  });

  it("does not flag untested change when a test file also changed", async () => {
    const root = await repo({
      "src/orders.ts": 'router.get("/api/orders", listOrders);',
      "src/orders.spec.ts":
        'it("GET /api/orders", () => { expect(1).toBe(1); });'
    });
    await appendFile(join(root, "src/orders.ts"), "\nexport const x = 1;\n");
    await appendFile(
      join(root, "src/orders.spec.ts"),
      '\nit("more", () => { expect(2).toBe(2); });\n'
    );
    const result = await reviewRepository(new EvaluationService(), root, {
      scope: "worktree"
    });
    expect(
      result.scopedFindings.some(
        (f) => f.ruleId === "ARF-CHANGE-UNTESTED-001"
      )
    ).toBe(false);
  });

  it("resolves a base ref via merge-base", async () => {
    const root = await repo({
      "src/orders.ts": 'router.get("/api/orders", listOrders);'
    });
    const baseBranch = spawnSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: root, encoding: "utf8" }
    ).stdout.trim();
    git(root, ["checkout", "-b", "feature"]);
    await appendFile(join(root, "src/orders.ts"), "\nexport const y = 2;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "feature work"]);
    const result = await reviewRepository(new EvaluationService(), root, {
      scope: "base",
      baseRef: baseBranch
    });
    expect(result.changeSet.files.map((f) => f.path)).toContain("src/orders.ts");
  });

  it("produces a token baseline in the human report", async () => {
    const root = await repo({
      "src/orders.ts": 'router.get("/api/orders", listOrders);'
    });
    await appendFile(join(root, "src/orders.ts"), "\nexport const z = 3;\n");
    const result = await reviewRepository(new EvaluationService(), root, {
      scope: "worktree"
    });
    const report = formatReviewReport({
      projectName: "d",
      baseRef: result.changeSet.baseRef,
      changedFiles: result.changeSet.files.length,
      scopedFindings: result.scopedFindings,
      outOfScopeCount: result.outOfScopeCount,
      packetSize: { bytes: 100, estimatedTokens: 25, estimator: "bytes-div-4" },
      baselines: result.baselines
    });
    expect(report).toContain("Input reduction:");
    expect(report).toContain("Packet:");
  });
});

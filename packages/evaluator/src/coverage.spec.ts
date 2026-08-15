import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, appendFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseIstanbulJson,
  parseLcov,
  uncoveredAddedLines,
  type CoverageData
} from "./coverage.js";
import { reviewRepository } from "./review.js";
import { EvaluationService } from "./service.js";

const previousHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = previousHome;
});

describe("coverage parsers", () => {
  it("parses lcov into per-line hits", () => {
    const files = parseLcov(
      ["SF:src/a.ts", "DA:1,2", "DA:2,0", "end_of_record"].join("\n"),
      "/repo"
    );
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/a.ts");
    expect(files[0].hits.get(1)).toBe(2);
    expect(files[0].hits.get(2)).toBe(0);
  });

  it("parses istanbul json into per-line hits", () => {
    const doc = {
      "/repo/src/a.ts": {
        path: "/repo/src/a.ts",
        statementMap: {
          "0": { start: { line: 1 }, end: { line: 1 } },
          "1": { start: { line: 2 }, end: { line: 3 } }
        },
        s: { "0": 5, "1": 0 }
      }
    };
    const files = parseIstanbulJson(JSON.stringify(doc), "/repo");
    expect(files[0].path).toBe("src/a.ts");
    expect(files[0].hits.get(1)).toBe(5);
    expect(files[0].hits.get(2)).toBe(0);
    expect(files[0].hits.get(3)).toBe(0);
  });

  it("reports uncovered lines within added ranges", () => {
    const coverage: CoverageData = {
      files: new Map([
        ["src/a.ts", { path: "src/a.ts", hits: new Map([[4, 0], [5, 0], [6, 1]]) }]
      ]),
      generatedAt: new Date(),
      source: "test"
    };
    expect(uncoveredAddedLines(coverage, "src/a.ts", [[4, 6]])).toEqual([4, 5]);
  });
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arf-cov-"));
  process.env.HOME = await mkdtemp(join(tmpdir(), "arf-cov-home-"));
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

describe("coverage-driven review", () => {
  it("flags added lines that the coverage report never executed", async () => {
    const root = await repo({ "src/a.ts": "export function a() {\n  return 1;\n}\n" });
    await appendFile(
      join(root, "src/a.ts"),
      "export function b() {\n  return 2;\n}\n"
    );
    await mkdir(join(root, "coverage"), { recursive: true });
    await writeFile(
      join(root, "coverage/lcov.info"),
      ["SF:src/a.ts", "DA:1,1", "DA:2,1", "DA:3,1", "DA:4,0", "DA:5,0", "end_of_record"].join("\n")
    );
    // Coverage newer than the change so the staleness guard passes.
    const future = new Date(Date.now() + 60_000);
    await utimes(join(root, "coverage/lcov.info"), future, future);

    const result = await reviewRepository(new EvaluationService(), root, {
      scope: "worktree"
    });
    expect(
      result.scopedFindings.some((f) => f.ruleId === "ARF-CHANGE-COVERAGE-001")
    ).toBe(true);
    expect(
      result.scopedFindings.some((f) => f.ruleId === "ARF-COVERAGE-STALE-001")
    ).toBe(false);
  });

  it("suppresses the coverage rule when the report is stale", async () => {
    const root = await repo({ "src/a.ts": "export function a() {\n  return 1;\n}\n" });
    await mkdir(join(root, "coverage"), { recursive: true });
    await writeFile(
      join(root, "coverage/lcov.info"),
      ["SF:src/a.ts", "DA:1,0", "end_of_record"].join("\n")
    );
    const past = new Date(Date.now() - 3_600_000);
    await utimes(join(root, "coverage/lcov.info"), past, past);
    await appendFile(join(root, "src/a.ts"), "export const x = 1;\n");

    const result = await reviewRepository(new EvaluationService(), root, {
      scope: "worktree"
    });
    expect(
      result.scopedFindings.some((f) => f.ruleId === "ARF-COVERAGE-STALE-001")
    ).toBe(true);
    expect(
      result.scopedFindings.some((f) => f.ruleId === "ARF-CHANGE-COVERAGE-001")
    ).toBe(false);
  });

  it("includes an untracked source file in added-line coverage and diff size", async () => {
    const root = await repo({
      "package.json": JSON.stringify({ name: "coverage-untracked" })
    });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src/new.ts"),
      "export function untested() {\n  return 1;\n}\n"
    );
    await mkdir(join(root, "coverage"), { recursive: true });
    await writeFile(
      join(root, "coverage/lcov.info"),
      ["SF:src/new.ts", "DA:1,0", "DA:2,0", "end_of_record"].join("\n")
    );
    const future = new Date(Date.now() + 60_000);
    await utimes(join(root, "coverage/lcov.info"), future, future);

    const result = await reviewRepository(new EvaluationService(), root, {
      scope: "worktree"
    });
    expect(result.changeSet.files).toContainEqual({
      path: "src/new.ts",
      status: "added"
    });
    expect(
      result.scopedFindings.some(
        (f) =>
          f.ruleId === "ARF-CHANGE-COVERAGE-001" &&
          f.title.includes("never executed")
      )
    ).toBe(true);
    expect(result.baselines.gitDiff.bytes).toBeGreaterThan(0);
  });

  it("fails fresh coverage that omits a changed source file", async () => {
    const root = await repo({
      "src/a.ts": "export function a() {\n  return 1;\n}\n",
      "src/covered.ts": "export const covered = true;\n"
    });
    await appendFile(join(root, "src/a.ts"), "export const changed = true;\n");
    await mkdir(join(root, "coverage"), { recursive: true });
    await writeFile(
      join(root, "coverage/lcov.info"),
      ["SF:src/covered.ts", "DA:1,1", "end_of_record"].join("\n")
    );
    const future = new Date(Date.now() + 60_000);
    await utimes(join(root, "coverage/lcov.info"), future, future);

    const result = await reviewRepository(new EvaluationService(), root, {
      scope: "worktree"
    });
    const missing = result.scopedFindings.find(
      (f) =>
        f.ruleId === "ARF-CHANGE-COVERAGE-001" &&
        f.title.includes("absent from coverage")
    );
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe("HIGH");
  });
});

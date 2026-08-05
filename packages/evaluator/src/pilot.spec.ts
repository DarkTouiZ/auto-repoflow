import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completePilotSession,
  pilotStudyStatus,
  preparePilotStudy,
  startPilotSession,
  summarizePilotStudy,
  validatePilotStudy
} from "./pilot.js";

const previousHome = process.env.HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trim();
}

async function pilotFixture(): Promise<{
  root: string;
  configPath: string;
  inputPath: string;
  targetPath: string;
  revision: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "arf-pilot-"));
  const home = join(root, "home");
  const targetPath = join(root, "target");
  const studyRoot = join(
    home,
    ".autorepoflow-private",
    "pilots",
    "pilot-test"
  );
  const inputPath = join(studyRoot, "inputs", "rules.md");
  const configPath = join(root, "study.json");
  process.env.HOME = home;
  await mkdir(targetPath, { recursive: true });
  await writeFile(join(targetPath, "index.js"), "export const value = 1;\n");
  git(targetPath, ["init", "-b", "main"]);
  git(targetPath, ["add", "index.js"]);
  git(targetPath, [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Pilot",
    "-c",
    "user.email=pilot@example.invalid",
    "commit",
    "-m",
    "fixture"
  ]);
  const revision = git(targetPath, ["rev-parse", "HEAD"]);
  await mkdir(join(studyRoot, "inputs"), { recursive: true, mode: 0o700 });
  await writeFile(
    inputPath,
    "# Controlled rules input\n\n## F01 — Missing test\n",
    { mode: 0o600 }
  );
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        studyId: "pilot-test",
        publicLabel: "synthetic-usability",
        purpose: "usability",
        sessions: [
          {
            id: "01",
            comparisonId: "cmp-01",
            reviewerToken: "reviewer-a",
            mode: "manual",
            targetLabel: "target-public",
            targetRevision: revision,
            targetPath,
            allowedFindingTokens: ["M01"],
            timeLimitMinutes: 12
          },
          {
            id: "02",
            comparisonId: "cmp-01",
            reviewerToken: "reviewer-b",
            mode: "rules",
            targetLabel: "target-public",
            targetRevision: revision,
            targetPath,
            controlledInputPath: inputPath,
            allowedFindingTokens: ["F01"],
            timeLimitMinutes: 12
          }
        ]
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  await chmod(configPath, 0o600);
  return { root, configPath, inputPath, targetPath, revision };
}

describe.sequential("private usability pilot", () => {
  it("records controlled sessions and exports only aggregate data", async () => {
    const fixture = await pilotFixture();
    await expect(preparePilotStudy(fixture.configPath)).resolves.toMatchObject({
      studyId: "pilot-test",
      sessions: 2
    });
    await expect(validatePilotStudy("pilot-test")).resolves.toEqual({
      studyId: "pilot-test",
      ready: true,
      sessions: 2
    });

    await startPilotSession(
      "pilot-test",
      "01",
      new Date("2026-08-05T01:00:00.000Z")
    );
    await completePilotSession({
      studyId: "pilot-test",
      sessionId: "01",
      finishedAt: new Date("2026-08-05T01:10:00.000Z"),
      responses: {
        taskCompleted: true,
        clarity: 3,
        mostUsefulFinding: "M01",
        handoffReady: "unsure",
        proposalSummary: "private manual proposal",
        comment: "private manual comment"
      }
    });
    await startPilotSession(
      "pilot-test",
      "02",
      new Date("2026-08-05T02:00:00.000Z")
    );
    await completePilotSession({
      studyId: "pilot-test",
      sessionId: "02",
      finishedAt: new Date("2026-08-05T02:05:00.000Z"),
      responses: {
        taskCompleted: true,
        clarity: 5,
        mostUsefulFinding: "F01",
        handoffReady: "yes",
        proposalSummary: "private rules proposal",
        comment: "private rules comment"
      }
    });

    const summary = await summarizePilotStudy("pilot-test");
    expect(summary).toMatchObject({
      configuredSessions: 2,
      validCompletedSessions: 2,
      reviewers: 2,
      targets: 1,
      overall: {
        sessions: 2,
        taskCompleted: 2,
        taskCompletionRatePercent: 100,
        clarity: { min: 3, median: 4, max: 5 },
        durationSeconds: { min: 300, median: 450, max: 600 }
      },
      comparisons: [
        {
          baselineMode: "manual",
          assistedMode: "rules",
          pairedTargets: 1,
          fasterPairs: 1,
          medianSecondsSaved: 300,
          medianTimeReductionPercent: 50
        }
      ],
      claimBoundary: {
        usabilityAllowed: true,
        engineeringAccuracyAllowed: false,
        humanAcceptanceAllowed: false
      }
    });
    const publicText = JSON.stringify(summary);
    for (const secret of [
      fixture.targetPath,
      fixture.revision,
      "target-public",
      "reviewer-a",
      "cmp-01",
      "F01",
      "private manual proposal",
      "private rules comment"
    ]) {
      expect(publicText).not.toContain(secret);
    }
    await expect(pilotStudyStatus("pilot-test")).resolves.toMatchObject({
      sessions: [
        { id: "01", mode: "manual", status: "completed" },
        { id: "02", mode: "rules", status: "completed" }
      ]
    });
  });

  it("rejects out-of-scope findings and identity-bearing controlled input", async () => {
    const fixture = await pilotFixture();
    await preparePilotStudy(fixture.configPath);
    await startPilotSession(
      "pilot-test",
      "02",
      new Date("2026-08-05T02:00:00.000Z")
    );
    await expect(
      completePilotSession({
        studyId: "pilot-test",
        sessionId: "02",
        finishedAt: new Date("2026-08-05T02:05:00.000Z"),
        responses: {
          taskCompleted: true,
          clarity: 4,
          mostUsefulFinding: "F99",
          handoffReady: "yes",
          proposalSummary: "proposal",
          comment: ""
        }
      })
    ).rejects.toThrow(/outside the controlled session scope/);

    const unsafeRoot = await mkdtemp(join(tmpdir(), "arf-pilot-unsafe-"));
    process.env.HOME = join(unsafeRoot, "home");
    const unsafe = await pilotFixture();
    await writeFile(
      unsafe.inputPath,
      "Notify reviewer@example.com before continuing\n",
      { mode: 0o600 }
    );
    await preparePilotStudy(unsafe.configPath);
    await expect(validatePilotStudy("pilot-test")).rejects.toThrow(
      /unsafe identity or secret-like data/
    );
  });
});

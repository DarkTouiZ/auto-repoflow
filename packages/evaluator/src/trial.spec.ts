import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bundledReplayPatch } from "./fixtures.js";
import {
  outcomeTrialStatus,
  prepareOutcomeTrial,
  reviewOutcomeTrialSession,
  runOutcomeTrialSession,
  summarizeOutcomeTrial
} from "./trial.js";

const previousHome = process.env.HOME;

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

describe("counterbalanced v0.3 outcome trial", () => {
  it("prepares four counterbalanced sessions and enforces one agent per participant", async () => {
    process.env.HOME = join(
      await mkdtemp(join(tmpdir(), "arf-trial-home-")),
      "home"
    );
    await expect(prepareOutcomeTrial("mentor-v03")).resolves.toEqual({
      studyId: "mentor-v03",
      sessions: 4,
      assisted: 2,
      unassisted: 2
    });
    const status = await outcomeTrialStatus("mentor-v03");
    expect(status.sessions).toEqual([
      {
        id: "01",
        mode: "unassisted",
        scenario: "delivery-list",
        status: "PREPARED"
      },
      {
        id: "02",
        mode: "assisted",
        scenario: "delivery-status",
        status: "PREPARED"
      },
      {
        id: "03",
        mode: "assisted",
        scenario: "delivery-list",
        status: "PREPARED"
      },
      {
        id: "04",
        mode: "unassisted",
        scenario: "delivery-status",
        status: "PREPARED"
      }
    ]);
    const unassisted = await runOutcomeTrialSession({
      studyId: "mentor-v03",
      sessionId: "01",
      agentLabel: "Claude"
    });
    expect(unassisted.phase).toBe("AWAITING_AGENT");
    expect(unassisted.fixPacketPath).toBeUndefined();
    await expect(
      runOutcomeTrialSession({
        studyId: "mentor-v03",
        sessionId: "02",
        agentLabel: "Codex"
      })
    ).rejects.toThrow(/same IDE agent/);
    const assisted = await runOutcomeTrialSession({
      studyId: "mentor-v03",
      sessionId: "02",
      agentLabel: "Claude"
    });
    expect(assisted.fixPacketPath).toContain("fix-packet.json");
  });

  it("binds independent acceptance to the verified patch and redacts aggregates", async () => {
    process.env.HOME = join(
      await mkdtemp(join(tmpdir(), "arf-trial-review-home-")),
      "home"
    );
    await prepareOutcomeTrial("review-v03");
    const handoff = await runOutcomeTrialSession({
      studyId: "review-v03",
      sessionId: "03",
      agentLabel: "Codex"
    });
    if (!handoff.worktreePath) throw new Error("trial worktree was not created");
    const replay = bundledReplayPatch("delivery-list");
    const patchPath = join(process.env.HOME, "review.patch");
    await writeFile(patchPath, replay.patch, { mode: 0o600 });
    execFileSync("git", ["apply", "--check", patchPath], {
      cwd: handoff.worktreePath
    });
    execFileSync("git", ["apply", patchPath], { cwd: handoff.worktreePath });
    const verified = await runOutcomeTrialSession({
      studyId: "review-v03",
      sessionId: "03",
      agentLabel: "Codex"
    });
    expect(verified.phase).toBe("VERIFIED");
    await expect(
      reviewOutcomeTrialSession({
        studyId: "review-v03",
        sessionId: "03",
        reviewerToken: "reviewer-b",
        decision: "accept"
      })
    ).rejects.toThrow(/differ from participant/);
    const review = await reviewOutcomeTrialSession({
      studyId: "review-v03",
      sessionId: "03",
      reviewerToken: "verifier-a",
      decision: "accept"
    });
    expect(review.patchSha256).toMatch(/^[0-9a-f]{64}$/);
    const summary = await summarizeOutcomeTrial("review-v03");
    expect(summary.outcomes.assisted).toMatchObject({
      sessionsReviewed: 1,
      verifiedSuccess: 1,
      accepted: 1
    });
    expect(summary.protocol.statisticalClaim).toBe(false);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("reviewer-b");
    expect(serialized).not.toContain("verifier-a");
    expect(serialized).not.toContain(review.patchSha256);
    expect(serialized).not.toContain("proposal");
  });
});

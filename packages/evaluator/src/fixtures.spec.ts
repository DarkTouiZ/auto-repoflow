import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256 } from "./privacy.js";
import {
  bundledReplayPatch,
  runGuidedDemo,
  type MileMeshScenario
} from "./fixtures.js";

const previousHome = process.env.HOME;

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

describe("MileMesh Lite guided demo", () => {
  for (const scenario of [
    "delivery-list",
    "delivery-status"
  ] as MileMeshScenario[]) {
    it(`replays the pinned ${scenario} patch through a real ChangeRun`, async () => {
      process.env.HOME = join(
        await mkdtemp(join(tmpdir(), "arf-demo-home-")),
        "home"
      );
      const replay = bundledReplayPatch(scenario);
      expect(sha256(replay.patch)).toBe(replay.sha256);
      const result = await runGuidedDemo({ scenario, mode: "replay" });
      expect(result.mode).toBe("replay");
      if (result.mode !== "replay") throw new Error("unexpected demo mode");
      expect(result.liveAi).toBe(false);
      expect(result.evidenceClassification).toContain("not-ai-quality-evidence");
      expect(result.baselineCheckPassed).toBe(true);
      expect(result.originalFixtureUnchanged).toBe(true);
      expect(result.report.before.testCoverage.percentage).toBe(50);
      expect(result.report.after.testCoverage.percentage).toBe(100);
      expect(result.report.before.findingCount).toBe(1);
      expect(result.report.after.findingCount).toBe(0);
      expect(result.report.verification.status).toBe("passed");
    });
  }

  it("stops at a transparent handoff without invoking AI", async () => {
    process.env.HOME = join(
      await mkdtemp(join(tmpdir(), "arf-handoff-home-")),
      "home"
    );
    const result = await runGuidedDemo({ mode: "handoff" });
    expect(result.mode).toBe("handoff");
    if (result.mode !== "handoff") throw new Error("unexpected demo mode");
    expect(result.liveAi).toBe(false);
    expect(result.worktreePath).toContain("change-runs");
    expect(result.fixPacketPath).not.toContain(result.worktreePath);
  });
});

import { describe, expect, it } from "vitest";
import {
  HUMAN_REVIEW_COLUMNS,
  parseHumanReviewArgs,
  summarizeHumanReview
} from "./human-review-lib.mjs";

const revision = "a80063e92dcde7476fa67558161ccbe12f15eaec";
const header = HUMAN_REVIEW_COLUMNS.join(",");

function row({
  session = "session-1",
  comparison = "comparison-1",
  mode = "manual",
  reviewer = "reviewer-1",
  finding = "finding-1",
  decision = "accept",
  reclassifiedAs = "",
  started = "2026-08-04T01:00:00.000Z",
  ready = "2026-08-04T01:10:00.000Z",
  elapsed = "600",
  notes = ""
} = {}) {
  return [
    session,
    comparison,
    mode,
    "milemesh-public",
    revision,
    reviewer,
    finding,
    "ARF-TEST-001",
    decision,
    reclassifiedAs,
    started,
    ready,
    elapsed,
    notes
  ].join(",");
}

describe("privacy-safe human review summary", () => {
  it("parses a public summary label and worksheet path", () => {
    expect(
      parseHumanReviewArgs(
        ["pilot.csv", "--label", "mentor-pilot-1"],
        { cwd: "/tmp" }
      )
    ).toEqual({
      inputPath: "/tmp/pilot.csv",
      label: "mentor-pilot-1"
    });
  });

  it("aggregates decisions and paired time without exporting identities", () => {
    const worksheet = [
      header,
      row(),
      row({ finding: "finding-2", decision: "reject" }),
      row({
        session: "session-2",
        mode: "rules",
        reviewer: "reviewer-2",
        finding: "finding-3",
        ready: "2026-08-04T01:05:00.000Z",
        elapsed: "300"
      }),
      row({
        session: "session-2",
        mode: "rules",
        reviewer: "reviewer-2",
        finding: "finding-4",
        decision: "reclassify",
        reclassifiedAs: "ARF-API-001",
        ready: "2026-08-04T01:05:00.000Z",
        elapsed: "300",
        notes: '"Needs, another category"'
      })
    ].join("\n");
    const summary = summarizeHumanReview(worksheet, {
      label: "mentor-pilot-1",
      generatedAt: "2026-08-04T02:00:00.000Z"
    });

    expect(summary.overall).toMatchObject({
      sessions: 2,
      reviewers: 2,
      targets: 1,
      findingsReviewed: 4,
      decisions: { accept: 2, reject: 1, reclassify: 1 },
      ratesPercent: {
        acceptance: 50,
        rejection: 25,
        reclassification: 25
      },
      timeToProposalSeconds: {
        sessions: 2,
        min: 300,
        median: 450,
        max: 600
      }
    });
    expect(summary.comparisons).toEqual([
      {
        baselineMode: "manual",
        assistedMode: "rules",
        pairedTargets: 1,
        fasterPairs: 1,
        medianSecondsSaved: 300,
        medianTimeReductionPercent: 50
      }
    ]);
    const publicText = JSON.stringify(summary);
    expect(publicText).not.toContain("reviewer-1");
    expect(publicText).not.toContain("finding-1");
    expect(publicText).not.toContain("milemesh-public");
    expect(publicText).not.toContain(revision);
    expect(publicText).not.toContain("ARF-TEST-001");
    expect(publicText).not.toContain("2026-08-04T01:00:00.000Z");
    expect(publicText).not.toContain("Needs, another category");
    expect(Object.values(summary.privacy).every((value) => value === false)).toBe(
      true
    );
  });

  it("rejects reviewer email addresses", () => {
    const worksheet = [
      header,
      row({ reviewer: "reviewer@example.com" })
    ].join("\n");
    expect(() =>
      summarizeHumanReview(worksheet, { label: "mentor-pilot-1" })
    ).toThrow(/reviewer_id must be anonymous/);
  });

  it("rejects duplicate findings within one session", () => {
    const worksheet = [header, row(), row()].join("\n");
    expect(() =>
      summarizeHumanReview(worksheet, { label: "mentor-pilot-1" })
    ).toThrow(/duplicated within the session/);
  });

  it("rejects elapsed time that disagrees with timestamps", () => {
    const worksheet = [header, row({ elapsed: "120" })].join("\n");
    expect(() =>
      summarizeHumanReview(worksheet, { label: "mentor-pilot-1" })
    ).toThrow(/must match/);
  });
});

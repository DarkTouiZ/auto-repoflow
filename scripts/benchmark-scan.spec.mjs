import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  benchmarkScanArguments,
  median,
  parseBenchmarkArgs,
  scoreKnownGapLedger
} from "./benchmark-scan-lib.mjs";

describe("privacy-safe scan benchmark", () => {
  it("parses a labeled repeatable benchmark", () => {
    expect(
      parseBenchmarkArgs(
        ["fixture", "--label", "public-fixture", "--runs", "5"],
        { cwd: "/tmp", root: "/tmp/workspace" }
      )
    ).toEqual({
      sourcePath: resolve("/tmp", "fixture"),
      label: "public-fixture",
      runs: 5,
      cliPath: resolve("/tmp/workspace", "apps/cli/dist/main.js"),
      ledgerPath: undefined
    });
  });

  it("rejects labels that could contain paths or prose", () => {
    expect(() =>
      parseBenchmarkArgs(["fixture", "--label", "private/client name"])
    ).toThrow(/--label/);
  });

  it("forces the repeatability benchmark to rules-only without drafts", () => {
    expect(benchmarkScanArguments("/tmp/public-target", "public-target")).toEqual([
      "scan",
      "/tmp/public-target",
      "--project",
      "public-target",
      "--format",
      "json",
      "--ai",
      "off",
      "--generate-evidence",
      "none"
    ]);
  });

  it("calculates a median for odd and even samples", () => {
    expect(median([8, 3, 5])).toBe(5);
    expect(median([8, 3, 5, 10])).toBe(6.5);
  });

  it("scores exact finding identities without returning them", () => {
    const score = scoreKnownGapLedger(["finding-a", "unexpected"], {
      schemaVersion: 2,
      gaps: [
        { id: "G01", findingId: "finding-a" },
        { id: "G02", findingId: "finding-b" }
      ]
    });
    expect(score).toEqual({
      ledgerSchemaVersion: 2,
      matchMode: "finding-id",
      expected: 2,
      detected: 2,
      truePositive: 1,
      falsePositive: 1,
      falseNegative: 1,
      precision: 50,
      recall: 50
    });
    expect(JSON.stringify(score)).not.toContain("finding-a");
  });
});

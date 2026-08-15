import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("benchmark gate", () => {
  it("fails instead of skipping when a release requires a target", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/benchmark-gate.mjs", "--require-target"],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "requires --target and --ledger"
    );
  });
});

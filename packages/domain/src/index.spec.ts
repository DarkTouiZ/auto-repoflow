import { describe, expect, it } from "vitest";
import { isSuccessfulStatus, isTerminalStatus } from "./index.js";

describe("run terminal policy", () => {
  it("recognizes only the draft PR state as success", () => {
    expect(isSuccessfulStatus("DRAFT_PR_CREATED")).toBe(true);
    expect(isSuccessfulStatus("READY_FOR_PR")).toBe(false);
  });

  it("does not treat review-ready work as terminal", () => {
    expect(isTerminalStatus("READY_FOR_PR")).toBe(false);
    expect(isTerminalStatus("FAILED")).toBe(true);
  });
});

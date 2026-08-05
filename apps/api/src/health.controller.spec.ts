import { describe, expect, it } from "vitest";
import { HealthController } from "./health.controller.js";

describe("HealthController", () => {
  it("returns a contract-valid local health response", () => {
    expect(new HealthController().getHealth()).toEqual({
      service: "auto-repoflow-api",
      status: "ok",
      version: "0.2.0"
    });
  });
});

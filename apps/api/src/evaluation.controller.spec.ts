import { describe, expect, it } from "vitest";
import { EvaluationController } from "./evaluation.controller.js";

describe("EvaluationController", () => {
  it("rejects invalid local evaluation input", async () => {
    const controller = new EvaluationController();
    const previousToken = process.env.ARF_API_TOKEN;
    process.env.ARF_API_TOKEN = "test-token";
    try {
      await expect(
        controller.create({ projectName: "" }, "Bearer test-token")
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      if (previousToken === undefined) delete process.env.ARF_API_TOKEN;
      else process.env.ARF_API_TOKEN = previousToken;
    }
  });

  it("returns a terminal report-ready event contract", () => {
    const controller = new EvaluationController();
    expect(controller.events("evaluation-id")).toEqual({
      evaluationId: "evaluation-id",
      events: [
        {
          type: "REPORT_READY",
          message: "Evaluation events are file-backed in the POC.",
          terminal: true
        }
      ]
    });
  });
});

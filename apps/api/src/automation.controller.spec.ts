import { afterEach, describe, expect, it } from "vitest";
import { AutomationController } from "./automation.controller.js";

const previousToken = process.env.ARF_API_TOKEN;

afterEach(() => {
  process.env.ARF_API_TOKEN = previousToken;
});

describe("AutomationController", () => {
  it("requires a configured bearer token for mutation", async () => {
    delete process.env.ARF_API_TOKEN;
    await expect(
      new AutomationController().enqueue(undefined, {
        sourcePath: "/local/repository",
        ai: "off"
      })
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects request-supplied policy paths and API keys", async () => {
    process.env.ARF_API_TOKEN = "test-token";
    const controller = new AutomationController();
    await expect(
      controller.enqueue("Bearer test-token", {
        sourcePath: "/local/repository",
        ai: "cloud",
        provider: "openai",
        model: "test-model",
        allowCloudMetadata: true,
        policyPath: "/attacker/policy.yaml",
        apiKey: "must-not-be-accepted"
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});

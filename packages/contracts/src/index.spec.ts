import { describe, expect, it } from "vitest";
import { projectRegistrationSchema } from "./index.js";

describe("project registration contract", () => {
  it("defaults to local execution and no forge upload", () => {
    const result = projectRegistrationSchema.parse({
      name: "MileMesh",
      repositoryPath: "/repos/milemesh"
    });

    expect(result.providerProfile).toBe("local");
    expect(result.forgeUploadAllowed).toBe(false);
  });
});

import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCloudAuthorization,
  assertEvidenceExportAllowed,
  loadAutomationPolicy
} from "./policy.js";

async function privatePolicy(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "arf-policy-"));
  const path = join(directory, "policy.yaml");
  await writeFile(path, contents, { mode: 0o600 });
  return path;
}

describe("private automation policy", () => {
  it("requires private file permissions and rejects embedded credentials", async () => {
    const exposed = await privatePolicy("schemaVersion: 1\n");
    await chmod(exposed, 0o644);
    await expect(loadAutomationPolicy(exposed)).rejects.toThrow(/group or others/);

    const credential = await privatePolicy(
      "schemaVersion: 1\napiKey: should-never-be-here\n"
    );
    await expect(loadAutomationPolicy(credential)).rejects.toThrow(
      /must not contain credentials/
    );
  });

  it("enforces policy plus command consent for cloud metadata", async () => {
    const path = await privatePolicy(`schemaVersion: 1
ai:
  allowedProviders: [openai]
  cloudMetadataAllowed: true
  models:
    openai: gpt-test
`);
    const policy = await loadAutomationPolicy(path);
    expect(() =>
      assertCloudAuthorization({
        policy,
        provider: "openai",
        allowCloudMetadata: false
      })
    ).toThrow(/--allow-cloud-metadata/);
    expect(
      assertCloudAuthorization({
        policy,
        provider: "openai",
        allowCloudMetadata: true
      })
    ).toBe("gpt-test");
    expect(() =>
      assertCloudAuthorization({
        policy,
        provider: "openai",
        allowCloudMetadata: true,
        model: "different-model"
      })
    ).toThrow(/not the policy-pinned model/);
  });

  it("contains exports inside allowlisted roots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arf-export-"));
    const path = await privatePolicy(`schemaVersion: 1
evidence:
  exportRoots:
    - ${JSON.stringify(directory)}
`);
    const policy = await loadAutomationPolicy(path);
    expect(assertEvidenceExportAllowed(policy, join(directory, "review"))).toBe(
      join(directory, "review")
    );
    expect(() =>
      assertEvidenceExportAllowed(policy, join(tmpdir(), "outside-review"))
    ).toThrow(/outside policy export roots/);
  });
});

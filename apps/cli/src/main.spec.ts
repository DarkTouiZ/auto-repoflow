import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./main.js";

const previousHome = process.env.HOME;
const previousOllamaModel = process.env.ARF_OLLAMA_MODEL;
const previousOpenAiKey = process.env.ARF_OPENAI_API_KEY;

afterEach(() => {
  process.env.HOME = previousHome;
  if (previousOllamaModel === undefined) delete process.env.ARF_OLLAMA_MODEL;
  else process.env.ARF_OLLAMA_MODEL = previousOllamaModel;
  if (previousOpenAiKey === undefined) delete process.env.ARF_OPENAI_API_KEY;
  else process.env.ARF_OPENAI_API_KEY = previousOpenAiKey;
  vi.restoreAllMocks();
});

async function cliFixture(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), "arf-cli-e2e-"));
  const source = join(root, "repository");
  process.env.HOME = join(root, "home");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "routes.ts"),
    'router.get("/api/widgets", listWidgets); export function listWidgets() {}'
  );
  return { root, source };
}

describe("headless CLI modes", () => {
  it("completes a zero-config scan when no Ollama model is configured", async () => {
    const { source } = await cliFixture();
    delete process.env.ARF_OLLAMA_MODEL;
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCli(["scan", source, "--format", "json"]);
    const report = JSON.parse(String(output.mock.calls[0][0]));
    expect(report).toMatchObject({
      schemaVersion: 2,
      status: "REPORT_READY",
      aiExecution: {
        requestedMode: "auto",
        status: "fallback",
        fallbackUsed: true
      }
    });

    output.mockClear();
    await runCli([
      "scan",
      source,
      "--ai",
      "off",
      "--format",
      "json",
      "--compat",
      "v1"
    ]);
    const legacy = JSON.parse(String(output.mock.calls[0][0]));
    expect(legacy.schemaVersion).toBe(1);
    expect(legacy.aiExecution).toBeUndefined();
  });

  it("fails closed for local AI without a model", async () => {
    const { source } = await cliFixture();
    delete process.env.ARF_OLLAMA_MODEL;
    await expect(runCli(["scan", source, "--ai", "local"])).rejects.toThrow(
      /model is required/
    );
  });

  it("requires cloud policy, command consent, and an environment API key", async () => {
    const { root, source } = await cliFixture();
    await expect(
      runCli([
        "scan",
        source,
        "--ai",
        "cloud",
        "--provider",
        "openai",
        "--model",
        "test-model"
      ])
    ).rejects.toThrow(/requires an absolute private --policy/);

    await expect(
      runCli([
        "scan",
        source,
        "--ai",
        "cloud",
        "--provider",
        "openai",
        "--model",
        "test-model",
        "--policy",
        "relative-policy.yaml"
      ])
    ).rejects.toThrow(/--policy must be an absolute private file path/);

    const policyPath = join(root, "policy.yaml");
    await writeFile(
      policyPath,
      `schemaVersion: 1
ai:
  allowedProviders: [openai]
  cloudMetadataAllowed: true
  models:
    openai: test-model
`
    );
    await chmod(policyPath, 0o600);
    await expect(
      runCli([
        "scan",
        source,
        "--ai",
        "cloud",
        "--provider",
        "openai",
        "--model",
        "test-model",
        "--policy",
        policyPath
      ])
    ).rejects.toThrow(/--allow-cloud-metadata/);

    delete process.env.ARF_OPENAI_API_KEY;
    await expect(
      runCli([
        "scan",
        source,
        "--ai",
        "cloud",
        "--provider",
        "openai",
        "--model",
        "test-model",
        "--policy",
        policyPath,
        "--allow-cloud-metadata"
      ])
    ).rejects.toThrow(/API key is required/);
  });
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEvaluationReport,
  createPublicReport,
  scoreKnownGaps
} from "./evaluate.js";
import { extractArtifacts } from "./extract.js";
import { createPrivateSnapshot, privacyDecisionFor } from "./privacy.js";
import {
  OllamaSemanticLinkProvider,
  verifyAiSuggestions
} from "./ai.js";

const previousHome = process.env.HOME;

afterEach(() => {
  process.env.HOME = previousHome;
});

describe("privacy boundary", () => {
  it("excludes environment, Git and credential material", () => {
    expect(privacyDecisionFor(".env.production").decision).toBe("EXCLUDED");
    expect(privacyDecisionFor(".git/config").decision).toBe("EXCLUDED");
    expect(privacyDecisionFor("certs/client.pem").decision).toBe("EXCLUDED");
    expect(privacyDecisionFor("src/main.ts").decision).toBe("INCLUDED");
  });

  it("creates a private snapshot without storing the source root", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-test-"));
    process.env.HOME = join(sandbox, "home");
    const source = join(sandbox, "source");
    await mkdir(join(source, ".git"), { recursive: true });
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, ".env"), "TOKEN=secret");
    await writeFile(join(source, ".git", "config"), "remote");
    await writeFile(join(source, "src", "app.ts"), "export const ok = true;");

    const result = await createPrivateSnapshot({
      sourcePath: source,
      projectName: "safe"
    });
    expect(result.manifest.files.map((item) => item.relativePath)).toEqual([
      "src/app.ts"
    ]);
    expect(JSON.stringify(result.manifest)).not.toContain(source);
    await expect(
      readFile(join(result.snapshotDirectory, ".env"), "utf8")
    ).rejects.toThrow();
  });
});

describe("evidence evaluator", () => {
  it("reports missing tests and strips private identifiers from public output", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-extract-"));
    await mkdir(join(sandbox, "src"), { recursive: true });
    const source = 'router.get("/api/v1/widgets", listWidgets); export function listWidgets() {}';
    await writeFile(join(sandbox, "src", "routes.ts"), source);
    const file = {
      relativePath: "src/routes.ts",
      sha256: "a".repeat(64),
      bytes: source.length
    };
    const extracted = await extractArtifacts(sandbox, [file]);
    const report = buildEvaluationReport({
      evaluationId: "private-id",
      projectName: "Secret Company",
      mode: "rules",
      manifest: {
        schemaVersion: 1,
        snapshotId: "snapshot",
        createdAt: "2026-07-29T00:00:00.000Z",
        sourceLabel: "secret-repo",
        sourceRootStored: false,
        files: [file],
        decisions: [],
        manifestSha256: "b".repeat(64)
      },
      extracted
    });
    expect(report.findings.some((item) => item.ruleId === "ARF-TEST-001")).toBe(true);
    const publicReport = createPublicReport(report);
    expect(JSON.stringify(publicReport)).not.toContain("Secret Company");
    expect(JSON.stringify(publicReport)).not.toContain("/api/v1/widgets");
  });

  it("limits coverage to an explicit private operation scope", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-scope-"));
    const source = [
      'app.get("/api/public/items", publicItems);',
      'app.get("/api/private/items", privateItems);'
    ].join("\n");
    await writeFile(join(sandbox, "routes.ts"), source);
    const file = {
      relativePath: "routes.ts",
      sha256: "d".repeat(64),
      bytes: source.length
    };
    const extracted = await extractArtifacts(sandbox, [file]);
    const report = buildEvaluationReport({
      evaluationId: "scope",
      projectName: "Private",
      mode: "rules",
      scopePrefix: "/api/private",
      manifest: {
        schemaVersion: 1,
        snapshotId: "snapshot",
        createdAt: "2026-07-29T00:00:00.000Z",
        sourceLabel: "repo",
        sourceRootStored: false,
        files: [file],
        decisions: [],
        manifestSha256: "e".repeat(64)
      },
      extracted
    });
    expect(report.coverage.find((item) => item.id === "test")?.total).toBe(1);
  });

  it("normalizes Postman path variables without treating them as a base URL", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-postman-"));
    const collection = JSON.stringify({
      item: [
        {
          name: "Get widget",
          request: {
            method: "GET",
            url: "{{baseUrl}}/api/widgets/{{widgetId}}?language=en"
          }
        }
      ]
    });
    await writeFile(join(sandbox, "collection.json"), collection);
    const extracted = await extractArtifacts(sandbox, [
      {
        relativePath: "collection.json",
        sha256: "c".repeat(64),
        bytes: collection.length
      }
    ]);
    expect(
      extracted.nodes.find((item) => item.kind === "REQUIREMENT")?.attributes
        ?.path
    ).toBe("/api/widgets/:param");
  });

  it("scores precision and recall against a known-gap ledger", () => {
    const report = {
      findings: [
        { ruleId: "RULE-A" },
        { ruleId: "RULE-A" },
        { ruleId: "RULE-C" }
      ]
    };
    const score = scoreKnownGaps(report as never, {
      schemaVersion: 1,
      gaps: [
        { id: "1", ruleId: "RULE-A", subject: "one" },
        { id: "2", ruleId: "RULE-A", subject: "two" },
        { id: "3", ruleId: "RULE-B", subject: "three" }
      ]
    });
    expect(score).toMatchObject({
      truePositive: 2,
      falsePositive: 1,
      falseNegative: 1,
      precision: 66.7,
      recall: 66.7
    });
  });
});

describe("local AI evidence guard", () => {
  it("rejects non-loopback Ollama endpoints", () => {
    expect(
      () => new OllamaSemanticLinkProvider("https://external.example")
    ).toThrow(/loopback/);
  });

  it("drops invented node and evidence identifiers", () => {
    const report = {
      nodes: [
        {
          id: "node-a",
          evidence: { artifactId: "artifact-a" }
        }
      ],
      edges: [],
      findings: [],
      summary: {
        pass: 0,
        fail: 0,
        unverified: 0,
        humanReviewRequired: 0
      }
    };
    const verified = verifyAiSuggestions(report as never, [
      {
        fromId: "node-a",
        toId: "invented-node",
        kind: "SERVED_BY",
        confidence: 0.99,
        rationale: "Invented relation",
        evidenceArtifactIds: ["invented-evidence"]
      }
    ]);
    expect(verified.edges).toHaveLength(0);
  });
});

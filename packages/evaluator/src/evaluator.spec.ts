import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEvaluationReport,
  createPublicReport,
  scoreKnownGaps
} from "./evaluate.js";
import { extractArtifacts } from "./extract.js";
import {
  MAX_SNAPSHOT_FILE_BYTES,
  createPrivateSnapshot,
  getConfiguredHome,
  getPrivateRoot,
  privacyDecisionFor
} from "./privacy.js";
import {
  OllamaSemanticLinkProvider,
  verifyAiSuggestions
} from "./ai.js";
import { EvaluationService } from "./service.js";

const previousHome = process.env.HOME;

afterEach(() => {
  process.env.HOME = previousHome;
});

async function createMockQualityTool(input: {
  source: string;
  packageName: string;
  tool: string;
  body: string;
}): Promise<void> {
  const packageRoot = join(input.source, "node_modules", input.packageName);
  const binary = join(packageRoot, "bin", `${input.tool}.js`);
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: input.packageName,
      bin: { [input.tool]: `bin/${input.tool}.js` }
    })
  );
  await writeFile(binary, input.body, { mode: 0o600 });
}

describe("privacy boundary", () => {
  it("excludes environment, Git and credential material", () => {
    expect(privacyDecisionFor(".env.production").decision).toBe("EXCLUDED");
    expect(privacyDecisionFor(".git/config").decision).toBe("EXCLUDED");
    expect(privacyDecisionFor("certs/client.pem").decision).toBe("EXCLUDED");
    expect(privacyDecisionFor("src/main.ts").decision).toBe("INCLUDED");
  });

  it("honors an explicit HOME for private artifacts on every platform", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-home-"));
    const configuredHome = join(sandbox, "configured-home");
    process.env.HOME = configuredHome;

    expect(getConfiguredHome()).toBe(resolve(configuredHome));
    await expect(getPrivateRoot()).resolves.toBe(
      join(resolve(configuredHome), ".autorepoflow-private")
    );
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

  it("excludes oversized files before copying them", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-large-file-"));
    process.env.HOME = join(sandbox, "home");
    const source = join(sandbox, "source");
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "large.bin"),
      Buffer.alloc(MAX_SNAPSHOT_FILE_BYTES + 1)
    );

    const result = await createPrivateSnapshot({
      sourcePath: source,
      projectName: "large-file"
    });
    expect(result.manifest.files).toEqual([]);
    expect(result.manifest.decisions).toContainEqual({
      relativePath: "large.bin",
      decision: "EXCLUDED",
      reason: "oversized_file"
    });
  });

  it("attaches explicit evidence by hash and rejects secret aliases", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-attach-"));
    process.env.HOME = join(sandbox, "home");
    const source = join(sandbox, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "app.ts"), "export const app = true;");
    const designPath = join(sandbox, "flow.yaml");
    await writeFile(
      designPath,
      "review_status: draft\nscreens: []\n"
    );
    const service = new EvaluationService();
    const snapshot = await service.snapshot({
      sourcePath: source,
      projectName: "attach"
    });
    const attached = await service.attachEvidence({
      evaluationId: snapshot.evaluationId,
      filePath: designPath,
      alias: "design-flow.yaml"
    });
    expect(attached.relativePath).toBe(
      ".evaluation-input/design-flow.yaml"
    );
    await expect(
      service.attachEvidence({
        evaluationId: snapshot.evaluationId,
        filePath: designPath,
        alias: ".env"
      })
    ).rejects.toThrow(/safe filename|privacy policy/);
    await expect(service.validate(snapshot.evaluationId)).resolves.toMatchObject({
      valid: true,
      checkedFiles: 2
    });
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

  it("links executable tests by exact method and normalized path", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-test-link-"));
    const routes = [
      'app.get("/api/widgets/:widgetId", getWidget);',
      'app.post("/api/widgets/:widgetId", updateWidget);'
    ].join("\n");
    const tests = [
      'it("GET /api/widgets/:param returns a mock widget", async () => {});'
    ].join("\n");
    await writeFile(join(sandbox, "routes.ts"), routes);
    await writeFile(join(sandbox, "routes.test.ts"), tests);
    const files = [
      {
        relativePath: "routes.ts",
        sha256: "7".repeat(64),
        bytes: routes.length
      },
      {
        relativePath: "routes.test.ts",
        sha256: "8".repeat(64),
        bytes: tests.length
      }
    ];
    const extracted = await extractArtifacts(sandbox, files);
    const report = buildEvaluationReport({
      evaluationId: "test-link",
      projectName: "Mock",
      mode: "rules",
      manifest: {
        schemaVersion: 1,
        snapshotId: "snapshot",
        createdAt: "2026-07-29T00:00:00.000Z",
        sourceLabel: "repo",
        sourceRootStored: false,
        files,
        decisions: [],
        manifestSha256: "9".repeat(64)
      },
      extracted
    });
    expect(report.coverage.find((item) => item.id === "test")).toMatchObject({
      covered: 1,
      total: 2,
      percentage: 50
    });
    expect(
      report.edges.find((edge) => edge.kind === "VERIFIED_BY")?.status
    ).toBe("PASS");
    expect(
      report.findings.filter((item) => item.ruleId === "ARF-TEST-001")
    ).toHaveLength(1);
  });

  it("reports reviewed scenario coverage without counting todo tests", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-scenario-link-"));
    const routes = 'app.get("/api/widgets", getWidgets);';
    const plan = [
      "review_status: human_reviewed",
      "test_cases:",
      "  - id: widgets",
      "    name: Widget scenarios",
      "    api_operation: GET /api/widgets",
      "    scenarios:",
      "      - populated mock result",
      "      - error response",
      "      - name: permission behavior requires confirmation",
      "        status: deferred_future",
      "        reason: authorization is planned after the POC"
    ].join("\n");
    const tests = [
      'it("GET /api/widgets [scenario: populated mock result]", async () => {});',
      'it.todo("GET /api/widgets [scenario: permission behavior requires confirmation]");'
    ].join("\n");
    await writeFile(join(sandbox, "routes.ts"), routes);
    await writeFile(join(sandbox, "test-plan.yaml"), plan);
    await writeFile(join(sandbox, "routes.test.ts"), tests);
    const files = [
      {
        relativePath: "routes.ts",
        sha256: "a".repeat(64),
        bytes: routes.length
      },
      {
        relativePath: "test-plan.yaml",
        sha256: "b".repeat(64),
        bytes: plan.length
      },
      {
        relativePath: "routes.test.ts",
        sha256: "c".repeat(64),
        bytes: tests.length
      }
    ];
    const extracted = await extractArtifacts(sandbox, files);
    const report = buildEvaluationReport({
      evaluationId: "scenario-link",
      projectName: "Mock",
      mode: "rules",
      manifest: {
        schemaVersion: 1,
        snapshotId: "snapshot",
        createdAt: "2026-07-29T00:00:00.000Z",
        sourceLabel: "repo",
        sourceRootStored: false,
        files,
        decisions: [],
        manifestSha256: "d".repeat(64)
      },
      extracted
    });
    expect(
      report.coverage.find((item) => item.id === "test-scenario")
    ).toMatchObject({ covered: 1, total: 2, percentage: 50 });
    expect(
      report.coverage.find((item) => item.id === "test-scenario-roadmap")
    ).toMatchObject({ covered: 1, total: 3, percentage: 33.3 });
    expect(
      report.findings.filter(
        (item) => item.ruleId === "ARF-TEST-SCENARIO-001"
      )
    ).toHaveLength(1);
  });

  it("keeps draft design links in human review", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-design-"));
    const routes =
      'app.get("/api/v1/items", listItems); export function listItems() {}';
    const design = [
      "review_status: draft_inferred_requires_human_review",
      "screens:",
      "  - id: item-list",
      "    name: Item list",
      "    actions:",
      "      - id: load",
      "        label: Load items",
      "        api_operation: GET /api/v1/items"
    ].join("\n");
    await writeFile(join(sandbox, "routes.ts"), routes);
    await writeFile(join(sandbox, "design-flow.yaml"), design);
    const files = [
      {
        relativePath: "routes.ts",
        sha256: "f".repeat(64),
        bytes: routes.length
      },
      {
        relativePath: "design-flow.yaml",
        sha256: "1".repeat(64),
        bytes: design.length
      }
    ];
    const extracted = await extractArtifacts(sandbox, files);
    const report = buildEvaluationReport({
      evaluationId: "design",
      projectName: "Draft",
      mode: "rules",
      manifest: {
        schemaVersion: 1,
        snapshotId: "snapshot",
        createdAt: "2026-07-29T00:00:00.000Z",
        sourceLabel: "repo",
        sourceRootStored: false,
        files,
        decisions: [],
        manifestSha256: "2".repeat(64)
      },
      extracted
    });
    expect(
      report.edges.find((edge) => edge.kind === "TRIGGERS")?.status
    ).toBe("HUMAN_REVIEW_REQUIRED");
    expect(
      report.findings.some((item) => item.ruleId === "ARF-DESIGN-001")
    ).toBe(true);
  });

  it("separates draft API readiness and test plans from approved evidence", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-readiness-"));
    const routeSource =
      'app.get("/api/v1/items", listItems); export function listItems() {}';
    const postman = JSON.stringify({
      info: {
        name: "Draft supplement",
        "x-autorepoflow-review-status": "draft_generated_requires_review"
      },
      item: [
        {
          name: "List items",
          request: { method: "GET", url: "{{baseUrl}}/api/v1/items" }
        }
      ]
    });
    const testPlan = [
      "review_status: draft_generated_requires_team_review",
      "test_cases:",
      "  - id: list-items",
      "    name: List items contract",
      "    api_operation: GET /api/v1/items",
      "    level: integration",
      "    scenarios: [success, invalid-input]"
    ].join("\n");
    await writeFile(join(sandbox, "routes.ts"), routeSource);
    await writeFile(join(sandbox, "supplement.json"), postman);
    await writeFile(join(sandbox, "test-plan.yaml"), testPlan);
    const files = [
      {
        relativePath: "routes.ts",
        sha256: "3".repeat(64),
        bytes: routeSource.length
      },
      {
        relativePath: "supplement.json",
        sha256: "4".repeat(64),
        bytes: postman.length
      },
      {
        relativePath: "test-plan.yaml",
        sha256: "5".repeat(64),
        bytes: testPlan.length
      }
    ];
    const extracted = await extractArtifacts(sandbox, files);
    const report = buildEvaluationReport({
      evaluationId: "readiness",
      projectName: "Draft",
      mode: "rules",
      manifest: {
        schemaVersion: 1,
        snapshotId: "snapshot",
        createdAt: "2026-07-29T00:00:00.000Z",
        sourceLabel: "repo",
        sourceRootStored: false,
        files,
        decisions: [],
        manifestSha256: "6".repeat(64)
      },
      extracted
    });
    expect(
      report.coverage.find((item) => item.id === "api-spec")
    ).toMatchObject({ covered: 0, total: 1 });
    expect(
      report.coverage.find((item) => item.id === "api-spec-readiness")
    ).toMatchObject({ covered: 1, total: 1 });
    expect(
      report.coverage.find((item) => item.id === "test")
    ).toMatchObject({ covered: 0, total: 1 });
    expect(
      report.coverage.find((item) => item.id === "test-plan")
    ).toMatchObject({ covered: 1, total: 1 });
    expect(
      report.findings.some(
        (item) =>
          item.ruleId === "ARF-API-DRAFT-001" &&
          item.status === "HUMAN_REVIEW_REQUIRED"
      )
    ).toBe(true);
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
      ledgerSchemaVersion: 1,
      matchMode: "rule-count",
      truePositive: 2,
      falsePositive: 1,
      falseNegative: 1,
      precision: 66.7,
      recall: 66.7
    });
  });

  it("scores schema v2 ledgers by exact finding identity", () => {
    const report = {
      findings: [
        { id: "finding:RULE-A:one", ruleId: "RULE-A" },
        { id: "finding:RULE-A:wrong-subject", ruleId: "RULE-A" },
        { id: "finding:RULE-C:unexpected", ruleId: "RULE-C" }
      ]
    };
    const score = scoreKnownGaps(report as never, {
      schemaVersion: 2,
      gaps: [
        {
          id: "G01",
          ruleId: "RULE-A",
          subject: "one",
          findingId: "finding:RULE-A:one"
        },
        {
          id: "G02",
          ruleId: "RULE-A",
          subject: "two",
          findingId: "finding:RULE-A:two"
        },
        {
          id: "G03",
          ruleId: "RULE-B",
          subject: "three",
          findingId: "finding:RULE-B:three"
        }
      ]
    });
    expect(score).toEqual({
      ledgerSchemaVersion: 2,
      matchMode: "finding-id",
      expected: 3,
      detected: 3,
      truePositive: 1,
      falsePositive: 2,
      falseNegative: 2,
      precision: 33.3,
      recall: 33.3,
      matchedGapIds: ["G01"],
      missedGapIds: ["G02", "G03"],
      unexpectedFindingIds: [
        "finding:RULE-A:wrong-subject",
        "finding:RULE-C:unexpected"
      ]
    });
  });

  it("rejects duplicate finding identities in schema v2 ledgers", () => {
    const ledger = {
      schemaVersion: 2 as const,
      gaps: [
        {
          id: "G01",
          ruleId: "RULE-A",
          subject: "one",
          findingId: "finding:RULE-A:one"
        },
        {
          id: "G02",
          ruleId: "RULE-A",
          subject: "duplicate",
          findingId: "finding:RULE-A:one"
        }
      ]
    };
    expect(() =>
      scoreKnownGaps({ findings: [] } as never, ledger)
    ).toThrow("duplicate finding IDs");
  });
});

describe("config-driven evaluation pipeline", () => {
  it("runs snapshot, evidence attachment, validation, evaluation and public export", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-pipeline-"));
    const home = join(sandbox, "home");
    const source = join(sandbox, "source");
    const evidencePath = join(sandbox, "collection.json");
    const configPath = join(sandbox, "pipeline.yaml");
    process.env.HOME = home;
    await mkdir(home, { recursive: true });
    await mkdir(source, { recursive: true });
    await mkdir(join(source, "node_modules"), { recursive: true });

    const routes =
      'app.get("/api/mock/items", listItems); export function listItems() {}';
    const tests =
      'it("GET /api/mock/items returns mock items", async () => {});';
    await writeFile(join(source, "routes.ts"), routes);
    await writeFile(join(source, "routes.test.ts"), tests);
    await createMockQualityTool({
      source,
      packageName: "typescript",
      tool: "tsc",
      body: 'console.log("mock typecheck passed");\n'
    });
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        scripts: {
          build: "tsc",
          test: "vitest run",
          typecheck: "tsc --noEmit"
        }
      })
    );
    await writeFile(
      evidencePath,
      JSON.stringify({
        info: {
          name: "Reviewed mock contract",
          "x-autorepoflow-review-status": "human_reviewed"
        },
        item: [
          {
            name: "List mock items",
            request: {
              method: "GET",
              url: "{{baseUrl}}/api/mock/items"
            }
          }
        ]
      })
    );
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        sourcePath: source,
        projectName: "Private Pipeline Project",
        scopePrefix: "/api/mock",
        evidence: [
          {
            filePath: evidencePath,
            alias: "postman.json"
          }
        ],
        quality: {
          timeoutSeconds: 10,
          checks: [{ id: "typecheck", tool: "tsc", args: [] }]
        },
        exportPublic: true
      })
    );

    const result = await new EvaluationService().runPipeline(configPath);

    expect(result.validation).toMatchObject({ valid: true, checkedFiles: 4 });
    expect(result.attachedEvidence).toHaveLength(1);
    expect(result.quality).toMatchObject({
      passed: true,
      checks: [{ id: "typecheck", tool: "tsc", passed: true }]
    });
    expect(
      result.coverage.find((item) => item.id === "api-spec")
    ).toMatchObject({ covered: 1, total: 1 });
    expect(
      result.coverage.find((item) => item.id === "test")
    ).toMatchObject({ covered: 1, total: 1 });
    const publicReport = await readFile(result.publicReportPath!, "utf8");
    expect(publicReport).not.toContain("Private Pipeline Project");
    expect(publicReport).not.toContain(source);
    expect(publicReport).not.toContain("/api/mock/items");
  });

  it("rejects unsafe evidence aliases before creating a snapshot", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-pipeline-private-"));
    const home = join(sandbox, "home");
    const source = join(sandbox, "source");
    const evidencePath = join(sandbox, "mock.txt");
    const configPath = join(sandbox, "pipeline.yaml");
    process.env.HOME = home;
    await mkdir(home, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "app.ts"), "export const app = true;");
    await writeFile(evidencePath, "mock");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        sourcePath: source,
        projectName: "Mock",
        evidence: [{ filePath: evidencePath, alias: "secret.pem" }]
      })
    );

    await expect(
      new EvaluationService().runPipeline(configPath)
    ).rejects.toThrow(/rejected by privacy policy/);
  });

  it("rejects a home directory as an overly broad source", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-pipeline-scope-"));
    const home = join(sandbox, "home");
    const configPath = join(sandbox, "pipeline.yaml");
    process.env.HOME = home;
    await mkdir(home, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        sourcePath: home,
        projectName: "Mock"
      })
    );

    await expect(
      new EvaluationService().runPipeline(configPath)
    ).rejects.toThrow(/scoped repository directory/);
  });

  it("stops before evaluation and public export when a required quality check fails", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-pipeline-quality-"));
    const home = join(sandbox, "home");
    const source = join(sandbox, "source");
    const configPath = join(sandbox, "pipeline.yaml");
    process.env.HOME = home;
    await mkdir(home, { recursive: true });
    await mkdir(join(source, "node_modules"), { recursive: true });
    await writeFile(join(source, "app.ts"), "export const app = true;");
    await createMockQualityTool({
      source,
      packageName: "jest",
      tool: "jest",
      body: "process.exit(2);\n"
    });
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        sourcePath: source,
        projectName: "Mock",
        quality: {
          timeoutSeconds: 10,
          checks: [{ id: "unit", tool: "jest", args: [] }]
        }
      })
    );

    const result = await new EvaluationService().runPipeline(configPath);

    expect(result).toMatchObject({
      status: "QUALITY_FAILED",
      quality: {
        passed: false,
        checks: [{ id: "unit", passed: false, exitCode: 2 }]
      },
      coverage: []
    });
    expect(result.publicReportPath).toBeUndefined();
  });

  it("rejects unsupported quality tools instead of running arbitrary commands", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-pipeline-tool-"));
    const home = join(sandbox, "home");
    const source = join(sandbox, "source");
    const configPath = join(sandbox, "pipeline.yaml");
    process.env.HOME = home;
    await mkdir(home, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "app.ts"), "export const app = true;");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        sourcePath: source,
        projectName: "Mock",
        quality: {
          checks: [{ id: "unsafe", tool: "bash", args: ["-c", "echo"] }]
        }
      })
    );

    await expect(
      new EvaluationService().runPipeline(configPath)
    ).rejects.toThrow();
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

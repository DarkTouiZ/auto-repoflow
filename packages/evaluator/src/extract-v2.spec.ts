import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractArtifacts } from "./extract.js";
import { sha256, type SnapshotFile } from "./privacy.js";

describe("v0.2 JavaScript and TypeScript extractors", () => {
  it("observes NestJS, frontend calls and tests while declaring OpenAPI and Markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "arf-extract-v2-"));
    const inputs = new Map<string, string>([
      [
        "widgets.controller.ts",
        `@Controller("api/widgets")
export class WidgetsController {
  @Get(":id")
  getWidget() { return {}; }
}`
      ],
      [
        "widget-client.tsx",
        `export async function loadWidget() {
  return axios.get("/api/widgets/1");
}`
      ],
      [
        "widgets.spec.ts",
        `test("GET /api/widgets/:id returns a widget", async () => {});`
      ],
      [
        "widgets.cy.ts",
        `it("GET /api/widgets/:id [scenario: browser]", () => {});`
      ],
      [
        "openapi.yaml",
        `openapi: 3.1.0
paths:
  /api/widgets/{id}:
    get:
      summary: Retrieve widget
`
      ],
      ["requirements.md", "# User story requirement: retrieve a widget\n"]
    ]);
    const files: SnapshotFile[] = [];
    for (const [relativePath, contents] of inputs) {
      const destination = join(root, relativePath);
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, contents);
      files.push({
        relativePath,
        sha256: sha256(contents),
        bytes: Buffer.byteLength(contents)
      });
    }

    const result = await extractArtifacts(root, files);
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "API_OPERATION",
          locator: "GET /api/widgets/:param",
          attributes: expect.objectContaining({ source: "nestjs-route" })
        }),
        expect.objectContaining({
          kind: "UI_ACTION",
          attributes: expect.objectContaining({
            source: "frontend-api-call",
            reviewStatus: "draft_inferred_requires_review"
          })
        }),
        expect.objectContaining({
          kind: "TEST_CASE",
          attributes: expect.objectContaining({ source: "test" })
        }),
        expect.objectContaining({
          kind: "TEST_CASE",
          attributes: expect.objectContaining({
            source: "test",
            scenario: "browser"
          })
        }),
        expect.objectContaining({
          kind: "REQUIREMENT",
          name: "Retrieve widget",
          attributes: expect.objectContaining({
            source: "openapi",
            reviewStatus: "draft_declared_requires_review"
          })
        }),
        expect.objectContaining({
          kind: "REQUIREMENT",
          attributes: expect.objectContaining({ source: "markdown-requirement" })
        })
      ])
    );
  });
});

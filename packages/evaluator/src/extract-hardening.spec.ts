import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractArtifacts } from "./extract.js";
import { sha256, type SnapshotFile } from "./privacy.js";

async function extract(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "arf-harden-"));
  const descriptors: SnapshotFile[] = [];
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
    descriptors.push({
      relativePath,
      sha256: sha256(contents),
      bytes: Buffer.byteLength(contents)
    });
  }
  return extractArtifacts(root, descriptors);
}

function routes(nodes: Awaited<ReturnType<typeof extract>>["nodes"]) {
  return nodes
    .filter((n) => n.kind === "API_OPERATION")
    .map((n) => n.locator)
    .sort();
}

describe("extraction hardening (Phase 1)", () => {
  it("ignores routes inside block and line comments", async () => {
    const { nodes } = await extract({
      "routes.ts": [
        '/* app.get("/dead-block", h); */',
        '// app.get("/dead-line", h);',
        'app.get("/live", handler);'
      ].join("\n")
    });
    expect(routes(nodes)).toEqual(["GET /live"]);
  });

  it("does not treat a route string inside a JS string literal as a route", async () => {
    const { nodes } = await extract({
      "doc.ts": 'const example = "app.get(\\"/from-string\\", h)"; export const x = 1;'
    });
    expect(routes(nodes)).toEqual([]);
  });

  it("recognises server / api / short-name routers on absolute paths", async () => {
    const { nodes } = await extract({
      "routes.ts": [
        'server.get("/api/a", ha);',
        'api.post("/api/b", hb);',
        'r.get("/api/c", hc);'
      ].join("\n")
    });
    expect(routes(nodes)).toEqual(["GET /api/a", "GET /api/c", "POST /api/b"]);
  });

  it("does not misread map/cache/lodash .get as routes", async () => {
    const { nodes } = await extract({
      "util.ts": [
        'const v = cache.get("user:1");',
        'const w = map.get("key");',
        'const z = _.get(obj, "a.b");'
      ].join("\n")
    });
    expect(routes(nodes)).toEqual([]);
  });

  it("does not treat an axios client call on an absolute path as a route", async () => {
    const { nodes } = await extract({
      "client.ts": 'export const f = () => axios.get("/api/things");'
    });
    // It is a UI action, not a server route.
    expect(routes(nodes)).toEqual([]);
    expect(nodes.some((n) => n.kind === "UI_ACTION")).toBe(true);
  });

  it("tolerates NestJS decorators between the HTTP decorator and the method", async () => {
    const { nodes } = await extract({
      "orders.controller.ts": [
        '@Controller("orders")',
        "export class OrdersController {",
        "  @Get(':id')",
        "  @UseGuards(AuthGuard)",
        "  @HttpCode(200)",
        "  findOne() { return {}; }",
        "}"
      ].join("\n")
    });
    expect(routes(nodes)).toContain("GET /orders/:param");
  });

  it("reads the object form of @Controller", async () => {
    const { nodes } = await extract({
      "users.controller.ts": [
        '@Controller({ path: "users", version: "1" })',
        "export class UsersController {",
        "  @Get()",
        "  list() { return []; }",
        "}"
      ].join("\n")
    });
    expect(routes(nodes)).toContain("GET /users");
  });

  it("extracts routes from .cjs and fetches from .jsx", async () => {
    const { nodes } = await extract({
      "server/routes.cjs": 'const router = x; router.get("/api/profile", getProfile);',
      "src/App.jsx": "export const App = () => fetch('/api/profile');"
    });
    expect(routes(nodes)).toEqual(["GET /api/profile"]);
    expect(nodes.some((n) => n.kind === "UI_ACTION")).toBe(true);
  });

  it("captures test modifiers and empty-body status", async () => {
    const { nodes } = await extract({
      "a.spec.ts": [
        'it("empty", () => {});',
        'it.only("focused", () => { expect(1).toBe(1); });',
        'it.skip("later", () => { expect(1).toBe(1); });',
        'it.todo("todo");',
        'it("asserts", () => { expect(2).toBe(2); });'
      ].join("\n")
    });
    const byTitle = new Map(
      nodes
        .filter((n) => n.kind === "TEST_CASE")
        .map((n) => [n.name, n.attributes])
    );
    expect(byTitle.get("empty")?.modifier).toBe("none");
    expect(byTitle.get("empty")?.bodyStatements).toBe(0);
    expect(byTitle.get("focused")?.modifier).toBe("only");
    expect(byTitle.get("later")?.modifier).toBe("skip");
    expect(byTitle.get("todo")?.modifier).toBe("todo");
    expect(byTitle.get("asserts")?.assertionCount).toBe(1);
    expect(byTitle.get("empty")?.assertionCount).toBe(0);
  });

  it("discovers tests under __tests__/ and *.e2e-spec.ts", async () => {
    const { nodes } = await extract({
      "__tests__/a.ts": 'it("in tests dir", () => { expect(1).toBe(1); });',
      "b.e2e-spec.ts": 'it("e2e", () => { expect(1).toBe(1); });'
    });
    const titles = nodes
      .filter((n) => n.kind === "TEST_CASE")
      .map((n) => n.name)
      .sort();
    expect(titles).toEqual(["e2e", "in tests dir"]);
  });
});

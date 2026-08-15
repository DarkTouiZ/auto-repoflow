import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEvaluationReport } from "./evaluate.js";
import { extractArtifacts } from "./extract.js";
import { sha256, type SnapshotFile } from "./privacy.js";

async function report(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "arf-tq-"));
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
  const extracted = await extractArtifacts(root, descriptors);
  return buildEvaluationReport({
    evaluationId: "tq",
    projectName: "TQ",
    mode: "rules",
    manifest: {
      schemaVersion: 1,
      snapshotId: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceLabel: "tq",
      sourceRootStored: false,
      files: descriptors,
      decisions: [],
      manifestSha256: "0".repeat(64)
    },
    extracted
  });
}

const ruleIds = (r: Awaited<ReturnType<typeof report>>) =>
  r.findings.map((f) => f.ruleId);

describe("test-quality rules (Phase 2)", () => {
  it("flags an empty test and does not count it as verification", async () => {
    const r = await report({
      "routes.ts": 'router.get("/api/orders", listOrders);',
      "routes.spec.ts": 'it("GET /api/orders", () => {});'
    });
    expect(ruleIds(r)).toContain("ARF-TEST-EMPTY-001");
    // The empty test must not verify the route.
    expect(ruleIds(r)).toContain("ARF-TEST-001");
    const testCoverage = r.coverage.find((c) => c.id === "test");
    expect(testCoverage).toMatchObject({ covered: 0, total: 1 });
    // And there is no VERIFIED_BY edge to the empty test.
    expect(r.edges.some((e) => e.kind === "VERIFIED_BY")).toBe(false);
  });

  it("flags a focused test with high severity", async () => {
    const r = await report({
      "a.spec.ts": 'it.only("focused", () => { expect(1).toBe(1); });'
    });
    const focus = r.findings.find((f) => f.ruleId === "ARF-TEST-FOCUS-001");
    expect(focus).toBeDefined();
    expect(focus?.severity).toBe("HIGH");
  });

  it("flags a skipped test without counting it", async () => {
    const r = await report({
      "a.spec.ts": 'it.skip("later", () => { expect(1).toBe(1); });'
    });
    expect(ruleIds(r)).toContain("ARF-TEST-SKIP-001");
  });

  it("flags a body with no recognized assertion", async () => {
    const r = await report({
      "a.spec.ts": 'it("does work", () => { doSomething(); });'
    });
    expect(ruleIds(r)).toContain("ARF-TEST-ASSERT-001");
    expect(ruleIds(r)).not.toContain("ARF-TEST-EMPTY-001");
  });

  it("does not flag a real assertion test", async () => {
    const r = await report({
      "a.spec.ts": 'it("checks", () => { expect(sum(1, 2)).toBe(3); });'
    });
    expect(ruleIds(r)).not.toContain("ARF-TEST-EMPTY-001");
    expect(ruleIds(r)).not.toContain("ARF-TEST-ASSERT-001");
    expect(ruleIds(r)).not.toContain("ARF-TEST-FOCUS-001");
  });

  it("does not link a route by test title vocabulary alone", async () => {
    const r = await report({
      "routes.ts": 'router.get("/api/orders", listOrders);',
      "routes.spec.ts":
        'it("renders the orders table", () => { render(); });'
    });
    // The vocabulary-only match must not verify the route.
    expect(ruleIds(r)).toContain("ARF-TEST-001");
    const testCoverage = r.coverage.find((c) => c.id === "test");
    expect(testCoverage).toMatchObject({ covered: 0, total: 1 });
  });

  it("flags a route whose bare-identifier handler does not resolve", async () => {
    const r = await report({
      "routes.ts": 'router.get("/api/orders", missingHandler);'
    });
    expect(ruleIds(r)).toContain("ARF-CODE-001");
    const impl = r.coverage.find((c) => c.id === "implementation");
    expect(impl).toMatchObject({ covered: 0, total: 1 });
  });

  it("counts an inline handler as implementation (no ARF-CODE-001)", async () => {
    const r = await report({
      "routes.ts": 'router.get("/api/orders", (req, res) => { res.json([]); });'
    });
    expect(ruleIds(r)).not.toContain("ARF-CODE-001");
    const impl = r.coverage.find((c) => c.id === "implementation");
    expect(impl).toMatchObject({ covered: 1, total: 1 });
  });

  it("resolves a named handler defined in the same file", async () => {
    const r = await report({
      "routes.ts":
        'router.get("/api/orders", listOrders);\nexport function listOrders() { return []; }'
    });
    expect(ruleIds(r)).not.toContain("ARF-CODE-001");
  });

  it("resolves a namespace controller member to its exported handler", async () => {
    const r = await report({
      "routes.ts":
        'router.get("/api/orders", ordersController.listOrders);',
      "orders-controller.ts":
        "export function listOrders() { return []; }"
    });
    expect(ruleIds(r)).not.toContain("ARF-CODE-001");
    const impl = r.coverage.find((c) => c.id === "implementation");
    expect(impl).toMatchObject({ covered: 1, total: 1 });
  });

  it("uses the final handler after route middleware", async () => {
    const r = await report({
      "routes.ts":
        'router.get("/api/orders", requireAuth, ordersController.listOrders);',
      "orders-controller.ts":
        "export function listOrders() { return []; }"
    });
    expect(ruleIds(r)).not.toContain("ARF-CODE-001");
  });

  it("severity ranks untested endpoint above missing lint script", async () => {
    const r = await report({
      "routes.ts": 'router.get("/api/orders", listOrders);',
      "routes.spec.ts": 'it("GET /api/orders", () => {});',
      "package.json": JSON.stringify({ name: "x", scripts: { test: "v", build: "t" } })
    });
    const empty = r.findings.find((f) => f.ruleId === "ARF-TEST-EMPTY-001");
    const lint = r.findings.find((f) => f.ruleId === "ARF-QUALITY-002");
    expect(empty?.severity).toBe("HIGH");
    expect(lint?.severity).toBe("LOW");
  });
});

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EvaluationReport } from "@auto-repoflow/domain";
import { buildEvaluationReport } from "./evaluate.js";
import { extractArtifacts } from "./extract.js";
import { sha256, type SnapshotFile } from "./privacy.js";

/**
 * A golden fixture is an in-memory repository (path -> file contents) plus the
 * exact set of finding rule IDs the engine is expected to emit for it. These
 * lock down current behaviour so that any change to extraction or evaluation
 * surfaces as an intentional, reviewable diff rather than a silent regression.
 *
 * This is the in-repo, no-network safety net that stands in for the external
 * MileMesh known-gap ledger (which lives in a separate checkout and cannot run
 * in CI — see scripts/benchmark-gate.mjs).
 */
export interface GoldenFixture {
  name: string;
  files: Record<string, string>;
  expectedRuleIds: string[];
  /**
   * Coverage tuples with a non-zero total, `id=covered/total`, sorted. Empty
   * means "every coverage lane is 0/0" (the typical plain-repo signature).
   * Several values here encode current bugs, called out per fixture.
   */
  expectedCoverage: string[];
}

/**
 * Materialise an in-memory fixture into a private temp directory and run the
 * deterministic (rules-only) pipeline over it, returning the full report.
 */
export async function runGoldenFixture(
  files: Record<string, string>
): Promise<EvaluationReport> {
  const sandbox = await mkdtemp(join(tmpdir(), "arf-golden-"));
  const descriptors: SnapshotFile[] = [];
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(sandbox, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
    descriptors.push({
      relativePath,
      sha256: sha256(contents),
      bytes: Buffer.byteLength(contents)
    });
  }
  const extracted = await extractArtifacts(sandbox, descriptors);
  return buildEvaluationReport({
    evaluationId: "golden",
    projectName: "Golden Fixture",
    mode: "rules",
    manifest: {
      schemaVersion: 1,
      snapshotId: "golden-snapshot",
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceLabel: "golden",
      sourceRootStored: false,
      files: descriptors,
      decisions: [],
      manifestSha256: "0".repeat(64)
    },
    extracted
  });
}

/** Sorted, de-duplicated rule IDs from a report — the golden assertion target. */
export function ruleIdsOf(report: EvaluationReport): string[] {
  return [...new Set(report.findings.map((item) => item.ruleId))].sort();
}

/** Sorted coverage tuples, for asserting the "0/0 on a plain repo" behaviour. */
export function coverageOf(
  report: EvaluationReport
): Array<{ id: string; covered: number; total: number }> {
  return report.coverage
    .map(({ id, covered, total }) => ({ id, covered, total }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const EXPRESS_FULL = {
  "src/routes.ts": [
    'const router = express.Router();',
    'router.get("/api/v1/orders/:id/delivery", getDelivery);',
    'export function getDelivery() { return {}; }'
  ].join("\n"),
  "src/routes.spec.ts": [
    'it("GET /api/v1/orders/:param/delivery returns the delivery", () => {',
    "  expect(getDelivery()).toBeDefined();",
    "});"
  ].join("\n"),
  "collection.json": JSON.stringify({
    info: { name: "orders", schema: "https://schema.getpostman.com/v2.1.0" },
    item: [
      {
        name: "get delivery",
        request: {
          method: "GET",
          url: { raw: "{{baseUrl}}/api/v1/orders/:id/delivery" }
        }
      }
    ]
  }),
  "package.json": JSON.stringify({
    name: "express-full",
    scripts: { test: "vitest run", build: "tsc", lint: "eslint ." }
  })
};

const NESTJS_OPENAPI = {
  "src/orders.controller.ts": [
    '@Controller("orders")',
    "export class OrdersController {",
    '  @Get(":id")',
    "  findOne() { return {}; }",
    "}"
  ].join("\n"),
  "openapi.json": JSON.stringify({
    openapi: "3.0.0",
    info: { title: "orders", version: "1" },
    paths: { "/orders/{id}": { get: { summary: "get order" } } }
  }),
  "package.json": JSON.stringify({
    name: "nestjs-openapi",
    scripts: { test: "jest", build: "nest build" }
  })
};

const LIBRARY_NO_ROUTES = {
  "src/index.ts": [
    "export function clsx(...args) { return args.filter(Boolean).join(' '); }"
  ].join("\n"),
  "src/index.test.ts": [
    'it("joins truthy class names", () => {',
    "  expect(clsx('a', false, 'b')).toBe('a b');",
    "});"
  ].join("\n"),
  "package.json": JSON.stringify({
    name: "library-no-routes",
    scripts: { test: "uvu" }
  })
};

const AGENT_SLOP = {
  "src/orders.ts": [
    'router.get("/api/orders", listOrders);',
    "export function listOrders() { return []; }"
  ].join("\n"),
  "src/orders.spec.ts": [
    'it("GET /api/orders", () => {});',
    'it.only("focused smoke test", () => { expect(1).toBe(1); });',
    'it.skip("later", () => { expect(true).toBe(true); });',
    'it("renders the orders table", () => { render(); });'
  ].join("\n"),
  "package.json": JSON.stringify({
    name: "agent-slop",
    scripts: { test: "vitest run", build: "tsc" }
  })
};

const JSX_CJS = {
  "src/App.jsx": [
    "export function App() {",
    "  return fetch('/api/profile').then((r) => r.json());",
    "}"
  ].join("\n"),
  "server/routes.cjs": [
    'const router = require("express").Router();',
    'router.get("/api/profile", getProfile);',
    "function getProfile() { return {}; }",
    "module.exports = router;"
  ].join("\n"),
  "package.json": JSON.stringify({
    name: "jsx-cjs",
    scripts: { test: "vitest run", build: "tsc" }
  })
};

const ABSOLUTE_URL_BACKEND = {
  "src/billing.ts": [
    "export async function charge(amount) {",
    '  return axios.post("https://api.stripe.com/v1/charges", { amount });',
    "}"
  ].join("\n"),
  "package.json": JSON.stringify({
    name: "absolute-url-backend",
    scripts: { test: "vitest run", build: "tsc" }
  })
};

/**
 * The six golden repositories. `expectedRuleIds` records the *current* engine
 * behaviour (v0.3.0). Several of these values are deliberately "wrong" — they
 * document known bugs the roadmap will fix (e.g. agent-slop's empty/focused
 * tests are not yet flagged; jsx-cjs currently extracts nothing). When a later
 * phase fixes a bug, the corresponding expectation must be updated in the same
 * commit, with the finding-ID delta stated in the PR.
 */
export const GOLDEN_FIXTURES: GoldenFixture[] = [
  {
    name: "express-full",
    files: EXPRESS_FULL,
    // Only ARF-CI-001 (routes exist but no contract/openapi CI workflow).
    expectedRuleIds: ["ARF-CI-001"],
    expectedCoverage: [
      "api-spec-readiness=1/1",
      "api-spec=1/1",
      "implementation=1/1",
      "test-plan=0/1",
      "test=1/1"
    ]
  },
  {
    name: "nestjs-openapi",
    files: NESTJS_OPENAPI,
    // FIXED (Phase 4, partial): NestJS routes now participate in coverage and
    // route rules, so the endpoint's missing test is reported (ARF-TEST-001)
    // instead of the dangerous "0% coverage, 0 test gaps" output. The OpenAPI
    // requirement is still not linked (api-spec=0/1) — widening the requirement
    // source set is deferred until the external MileMesh gate can validate it.
    expectedRuleIds: [
      "ARF-API-001",
      "ARF-CI-001",
      "ARF-QUALITY-002",
      "ARF-TEST-001"
    ],
    expectedCoverage: [
      "api-spec-readiness=0/1",
      "api-spec=0/1",
      "implementation=1/1",
      "test-plan=0/1",
      "test=0/1"
    ]
  },
  {
    name: "library-no-routes",
    files: LIBRARY_NO_ROUTES,
    // clsx-shaped: only generic npm-script hygiene findings today.
    expectedRuleIds: ["ARF-QUALITY-001", "ARF-QUALITY-002"],
    expectedCoverage: []
  },
  {
    name: "agent-slop",
    files: AGENT_SLOP,
    // FIXED (Phase 2): the empty test `it("GET /api/orders", () => {})` no
    // longer counts as verification (test=0/1), so ARF-TEST-001 fires for the
    // untested endpoint, and the agent-failure rules now catch the empty test
    // (ARF-TEST-EMPTY-001), the focused test (ARF-TEST-FOCUS-001), the skipped
    // test (ARF-TEST-SKIP-001), and the assertion-free "renders" test
    // (ARF-TEST-ASSERT-001). This is the core product bug, now resolved.
    expectedRuleIds: [
      "ARF-API-001",
      "ARF-CI-001",
      "ARF-QUALITY-002",
      "ARF-TEST-001",
      "ARF-TEST-ASSERT-001",
      "ARF-TEST-EMPTY-001",
      "ARF-TEST-FOCUS-001",
      "ARF-TEST-SKIP-001"
    ],
    expectedCoverage: [
      "api-spec-readiness=0/1",
      "api-spec=0/1",
      "implementation=1/1",
      "test-plan=0/1",
      "test=0/1"
    ]
  },
  {
    name: "jsx-cjs",
    files: JSX_CJS,
    // FIXED (Phase 1): .jsx and .cjs are now in the extraction allowlist, so
    // the route in server/routes.cjs is visible (ARF-API-001 + ARF-TEST-001
    // for the untested endpoint) and the fetch in src/App.jsx links UI to API
    // (ui-api=1/1). Previously only ARF-QUALITY-002 fired.
    expectedRuleIds: [
      "ARF-API-001",
      "ARF-CI-001",
      "ARF-QUALITY-002",
      "ARF-TEST-001"
    ],
    expectedCoverage: [
      "api-spec-readiness=0/1",
      "api-spec=0/1",
      "implementation=1/1",
      "test-plan=0/1",
      "test=0/1",
      "ui-api=1/1"
    ]
  },
  {
    name: "absolute-url-backend",
    files: ABSOLUTE_URL_BACKEND,
    // FIXED (Phase 1): a server-side axios.post to an absolute external URL
    // (api.stripe.com) is no longer treated as a UI action, so the previous
    // false ARF-UI-001 is gone. Only the package.json hygiene rule remains.
    expectedRuleIds: ["ARF-QUALITY-002"],
    expectedCoverage: []
  }
];

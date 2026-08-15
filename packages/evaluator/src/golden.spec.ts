import { describe, expect, it } from "vitest";
import {
  GOLDEN_FIXTURES,
  coverageOf,
  ruleIdsOf,
  runGoldenFixture
} from "./golden-fixtures.js";

/**
 * In-repo regression gate. Each fixture asserts the exact set of rule IDs and
 * the exact non-zero coverage tuples the deterministic engine emits. Changing
 * an expectation requires an intentional edit here — never a snapshot rewrite —
 * so any extraction/evaluation change lands with a stated finding-ID delta.
 */
describe("golden regression gate", () => {
  for (const fixture of GOLDEN_FIXTURES) {
    it(`${fixture.name}: exact rule IDs and coverage`, async () => {
      const report = await runGoldenFixture(fixture.files);

      expect(ruleIdsOf(report)).toEqual(fixture.expectedRuleIds);

      const nonZeroCoverage = coverageOf(report)
        .filter((entry) => entry.total > 0)
        .map((entry) => `${entry.id}=${entry.covered}/${entry.total}`)
        .sort();
      expect(nonZeroCoverage).toEqual([...fixture.expectedCoverage].sort());
    });
  }
});

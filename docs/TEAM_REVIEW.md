# Team pilot review

Use this checklist before treating a pilot result as presentation evidence.

## Scope

- Confirm the exact operations included in the evaluation.
- Mark visible design actions as API-backed, local-only, or external/future.
- Review the design-flow file independently from the source extractor.
- Record whether the reviewer built the feature; if so, label results
  single-reviewer.

## Ground truth

- Review every known gap before seeing tool output.
- Give each gap a stable ID and rule category.
- Count duplicate examples as scenarios, not separate API operations.
- Record false positives and false negatives, not only detected issues.

## Timing

Measure the same task three ways:

1. manual review;
2. deterministic rules;
3. local AI plus deterministic evidence verification.

Start timing from artifact intake and stop when the reviewer has a prioritized
clarification/finding list. Do not include environment installation time.

## Privacy release gate

- Use MileMesh for screenshots and endpoint examples.
- Use only approved aggregate private-pilot metrics.
- Search the public artifact for company names and absolute paths.
- Confirm endpoint, table, field, screenshot, and code-excerpt counts are zero.
- Obtain a second person’s release approval before any public push.

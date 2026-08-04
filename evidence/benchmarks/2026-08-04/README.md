# Evidence sprint — 2026-08-04

This pack records the first public, repeatable benchmark for
`auto-repoflow@0.1.2`. It follows the
[public scan benchmark protocol](../../../docs/BENCHMARK_PROTOCOL.md) and
contains aggregate results only.

## Results

| Target | Role | Runs | Included files | Excluded files | Findings | Median | Repeatable | Precision | Recall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| MileMesh | Synthetic ground truth | 3 | 37 | 2 | 22 | 69.5 ms | Yes | 100% | 100% |
| p-limit | Public runtime sample | 3 | 16 | 1 | 3 | 55.1 ms | Yes | Not scored | Not scored |
| clsx | Public runtime sample | 3 | 21 | 1 | 2 | 68.3 ms | Yes | Not scored | Not scored |

MileMesh is the only accuracy-scored target because its reviewed schema-v2
ledger defines 22 exact expected finding IDs. Its 100% precision and recall
are synthetic-benchmark results, not a general accuracy claim. The two public
repositories have no reviewed ground truth, so their results support runtime,
evidence-volume, exclusion, and repeatability observations only.

Exact repositories, commits, licenses, result hashes, and the benchmark
environment are pinned in [targets.json](targets.json).

## Privacy and integrity checks

- Every target was a pristine public Git checkout pinned to one commit.
- All three summaries report stable evidence, finding identity, and status
  counts across three runs.
- The summaries contain no source root, absolute source path, raw snapshot,
  filename, finding identity, source hash, endpoint, schema, or code excerpt.
- Raw snapshots were purged after each successful run.
- No company repository, company email address, customer data, or private code
  was used.
- SHA-256 hashes in `targets.json` make the committed result files verifiable.

## Human review

[human-review-template.csv](human-review-template.csv) is intentionally empty.
Use it during a supervised review to record acceptance, rejection,
reclassification, and time-to-proposal. Do not claim a human-acceptance rate or
time saving until reviewers complete and approve that worksheet.

Allowed values for `decision` are `accept`, `reject`, and `reclassify`. Reviewer
IDs should be anonymous labels rather than names or email addresses. Follow the
[mentor evaluation guide](../../../docs/MENTOR_EVALUATION_GUIDE.md), keep the
completed worksheet outside the repository, and generate a privacy-safe
aggregate with `npm run review:summarize`.

## Reproduce

Build the source at AutoRepoFlow commit
`48106ee8eea2d62687c8a2e383a015aba6b6995f`, create pristine checkouts at the
commits in `targets.json`, and run:

```bash
npm run benchmark:scan -- /path/to/milemesh-mock \
  --label milemesh-synthetic \
  --ledger /path/to/milemesh-mock/benchmark/expected-findings.json \
  --runs 3

npm run benchmark:scan -- /path/to/p-limit \
  --label p-limit-public \
  --runs 3

npm run benchmark:scan -- /path/to/clsx \
  --label clsx-public \
  --runs 3
```

Runtime samples can vary by machine. Accuracy counts and aggregate summaries
should remain stable when the pinned inputs and tool commit are unchanged.

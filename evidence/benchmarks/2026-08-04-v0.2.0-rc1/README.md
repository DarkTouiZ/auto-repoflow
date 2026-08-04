# Evidence sprint — AutoRepoFlow 0.2.0 RC1

This pack records privacy-safe, repeatable rules-engine evidence for the
`auto-repoflow@0.2.0` release candidate in Draft PR #9. It follows the
[public scan benchmark protocol](../../../docs/BENCHMARK_PROTOCOL.md) and is
kept separate from the published 0.1.2 evidence pack.

## Results

| Target | Role | Runs | Included files | Findings | Median | Repeatable | Precision | Recall |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| MileMesh | Synthetic ground truth | 3 | 37 | 22 | 89.3 ms | Yes | 100% | 100% |
| p-limit | Public runtime sample | 3 | 16 | 2 | 76.4 ms | Yes | Not scored | Not scored |
| clsx | Public runtime sample | 3 | 21 | 1 | 76.8 ms | Yes | Not scored | Not scored |

Every run explicitly used `--ai off --generate-evidence none`. This prevents a
configured local model from changing the rules baseline. MileMesh is the only
accuracy-scored target because its reviewed schema-v2 ledger defines 22 exact
expected finding IDs. The result is synthetic benchmark evidence, not a claim
of general accuracy or human acceptance.

Exact repositories, commits, licenses, result hashes, environment, and protocol
are pinned in [targets.json](targets.json).

## Privacy and integrity

- All targets were pristine Git checkouts pinned to one commit.
- Evidence identity, finding identity, and summary were stable across all three
  runs for every target.
- Aggregate files contain no repository path, filename, finding identity,
  source hash, endpoint, code excerpt, project/company identifier, email, API
  key, or raw model input/output.
- Raw snapshots were removed after each successful scan.
- MileMesh is public synthetic code; p-limit and clsx are public MIT targets.
- This pack contains no company repository, customer data, or completed human
  review worksheet.

## Human review gate

[human-review-template.csv](human-review-template.csv) contains only its header.
A completed worksheet must stay outside Git and use anonymous reviewer tokens.
No acceptance rate or time-saving claim may be made until real reviewers finish
the paired protocol and a second person approves the privacy-safe aggregate.

## Reproduce

Build AutoRepoFlow at commit
`ea8271dfc140fed6682be40318ef520528e7fa88`, check out the target revisions in
`targets.json`, and run the three commands from the benchmark protocol with
`--runs 3`. Runtime measurements may vary by machine; finding identities and
aggregate status should remain stable for pinned inputs.

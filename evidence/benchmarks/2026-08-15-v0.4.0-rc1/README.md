# AutoRepoFlow v0.4.0 RC1 evidence

Generated on 2026-08-15 from AutoRepoFlow revision
`e80aa78d7ce7ca3de5b5dbd79bc16773c366f642`.

## Reproducible rules-only benchmark

| Target | Pinned revision | Files | Excluded | Findings | Median | Repeatable |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| MileMesh synthetic | `2bd997e88dd252472e20a01dc18768f4989fc31a` | 37 | 2 | 22 | 80.0 ms | yes |
| p-limit | `df476048d023ff868cd45b35ee47f5fb0ca2b25a` | 16 | 1 | 2 | 69.3 ms | yes |
| clsx | `925494cf31bcd97d3337aacd34e659e80cae7fe2` | 21 | 1 | 1 | 70.7 ms | yes |

All targets were pristine pinned Git checkouts. Each target was scanned three
times with rules-only isolation equivalent to `--ai off --generate-evidence
none`. Absolute source paths were absent from the public outputs and raw
snapshots were removed after every run.

MileMesh is a reviewed synthetic ledger: 22/22 findings, 100% precision and
100% recall under exact finding-ID matching. This is not a general accuracy
claim. p-limit and clsx are public compatibility/repeatability targets and are
not scored for precision or recall.

## Dogfood productivity proxy

Reviewing this candidate against `main` produced a 3,458-byte packet for 32
changed files. This is 97.7% smaller than the 148,538-byte Git diff and 99.4%
smaller than reading all changed files (619,870 bytes). This is an input-size
proxy only—not evidence of quality, correctness, acceptance, or time saved.

## Human pilot status

The counterbalanced pilot template is included, but no human result is reported
until two reviewers complete four sessions and a second person validates the
anonymous aggregate. If that does not happen by 2026-08-19, acceptance and
time-saving claims remain excluded from presentation materials.



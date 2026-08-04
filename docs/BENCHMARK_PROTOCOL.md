# Public scan benchmark protocol

## Purpose

This protocol produces repeatable, privacy-safe aggregate evidence for the
SuperAI Engineer SS6 poster and public project evaluation. It measures the
released scan behavior without claiming that results from one synthetic
repository generalize to every framework or codebase.

## Run the benchmark

Build the local CLI, then run at least three scans with an explicitly public or
anonymized label. The target must be a pristine Git checkout without generated,
ignored, untracked, or modified files so the environment is associated with an
exact commit. Keep the benchmark checkout separate from the working copy where
you install dependencies:

```bash
npm run build -w @auto-repoflow/contracts
npm run build -w @auto-repoflow/domain
npm run build -w @auto-repoflow/evaluator
npm run build -w auto-repoflow
npm run benchmark:scan -- /path/to/repository \
  --label public-target \
  --runs 3
```

For the synthetic MileMesh benchmark, attach its schema-v2 known-gap ledger:

```bash
npm run benchmark:scan -- /path/to/milemesh-mock \
  --label milemesh-synthetic \
  --ledger /path/to/milemesh-mock/benchmark/expected-findings.json \
  --runs 3
```

The command writes one JSON summary to standard output. Redirect it only to a
reviewed public-evidence directory after checking the label and target policy.

## Recorded metrics

- CLI version and rules-only protocol;
- explicit `--ai off --generate-evidence none` isolation from local model state;
- individual, minimum, median, and maximum scan duration;
- included file count and bytes;
- excluded file counts grouped by privacy reason;
- aggregate finding status and rule counts;
- aggregate coverage metrics;
- repeated-run evidence, finding-identity, and summary stability;
- exact precision and recall when a schema-v2 ledger is supplied.

The summary omits the repository path, filenames, finding identities, source
hashes, endpoints, schemas, and code excerpts. It fails if a scan retains its
raw snapshot, stores the absolute target path in the report or manifest, or
uses a target containing modified, untracked, or ignored files.

## Poster evidence rules

1. Use MileMesh only for exact known-gap precision and recall because it has a
   reviewed synthetic ground-truth ledger.
2. Use at least two additional public JavaScript or TypeScript repositories for
   runtime, evidence-volume, exclusion, and reviewer-acceptance observations.
3. Pin every public target to a pristine commit checkout and record its license and
   repository URL beside the aggregate result; the runner intentionally does
   not export commit or repository identifiers for private targets.
4. Do not report precision or recall for a repository without reviewed ground
   truth.
5. Keep human acceptance, rejection, reclassification, and time-to-proposal in
   a separate reviewed worksheet. The scanner cannot infer those outcomes.
6. Never use company code, private customer data, or an unapproved repository
   in public poster evidence.
7. Run rules and local-AI protocols as separate benchmark series with the
   exact model, prompt version, schema version, and payload hash recorded.
8. Treat provider contract/schema tests as compatibility evidence only; they
   do not demonstrate finding quality or human acceptance.

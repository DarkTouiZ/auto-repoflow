# Auto-RepoFlow

[![CI](https://github.com/DarkTouiZ/auto-repoflow/actions/workflows/ci.yml/badge.svg)](https://github.com/DarkTouiZ/auto-repoflow/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/auto-repoflow.svg)](https://www.npmjs.com/package/auto-repoflow)
[![license](https://img.shields.io/npm/l/auto-repoflow.svg)](LICENSE)

Auto-RepoFlow is a local-first engineering evidence auditor and software change
control plane. Its evaluation workflow connects design, data, API, code, tests,
and CI evidence; its future change workflow stops after creating a draft pull
request.

This repository is a clean implementation inspired by lessons from the
SuperAI Engineer SS6 project. It does not contain company source code, private
records, internal endpoints, or proprietary schemas.

## Public CLI alpha

The public package is designed around one safe, zero-config command:

```bash
npx auto-repoflow scan .
```

It can also produce a portable review packet for the AI assistant or coding
agent that the user already trusts:

```bash
npx auto-repoflow scan . \
  --format agent-md \
  --out auto-repoflow-fix-packet.md
```

Version `0.1.0` is available on
[npm](https://www.npmjs.com/package/auto-repoflow) and as a
[GitHub release](https://github.com/DarkTouiZ/auto-repoflow/releases/tag/v0.1.0).
Install the command globally if you prefer not to use `npx`:

```bash
npm install --global auto-repoflow
auto-repoflow scan /path/to/repository
```

To run the development version from a checkout:

```bash
npm install
npm run build
node apps/cli/dist/main.js scan /path/to/repository
```

`scan` is static by default: it does not run repository scripts, edit files,
call cloud AI, merge, deploy, or publish. The first public alpha focuses on
JavaScript and TypeScript repositories and supports `human`, `json`,
`agent-md`, and `agent-json` outputs. A successful zero-config scan removes its
raw source snapshot automatically; use `--keep-snapshot` only when you need to
inspect the filtered copy locally afterward.

## Implemented POC

- private snapshots in `~/.autorepoflow-private` with SHA-256 manifests and
  automatic raw-snapshot cleanup for zero-config scans;
- deny-before-copy handling for `.git`, `.env*`, keys, certificates, logs, and
  generated dependency/build folders;
- extractors for reviewed design-flow YAML, Mermaid ERD, Postman, Express
  routes, TypeScript symbols, tests, package scripts, CI, and World Contracts;
- rules and trace edges for UI → API → implementation → test evidence;
- reproducible known-gap precision/recall scoring;
- provider-neutral local AI linking through Mock or loopback-only Ollama;
- CLI, NestJS REST API, and Angular evidence dashboard.

No merge or deployment capability is part of the product.

## Local setup

Requirements: Node.js 22+, npm, Git, and Docker. Ollama and authenticated
GitHub CLI are optional during foundation development but required for their
respective live workflow stages.

```bash
cp .env.example .env
npm install
npm run doctor
npm run check
docker compose up -d mysql
```

The API binds to `127.0.0.1` by default. Secrets, evaluation artifacts, bare
mirrors, and worktrees are excluded from Git.

## Evaluate a local repository

Use a private config outside the repository for the automated pipeline:

```yaml
schemaVersion: 1
sourcePath: /absolute/path/to/repository
projectName: Local-Pilot
mode: rules
scopePrefix: /api
evidence:
  - filePath: /private/local/design-flow.yaml
    alias: design-flow.yaml
  - filePath: /private/local/test-plan.yaml
    alias: test-plan.yaml
quality:
  timeoutSeconds: 300
  checks:
    - id: typecheck
      tool: tsc
      args: [--noEmit]
    - id: unit-tests
      tool: jest
      args: [--config, jest.unit.config.ts, --runInBand]
exportPublic: true
```

```bash
npm run build
node apps/cli/dist/main.js eval pipeline \
  --config /absolute/private/path/evaluation-pipeline.yaml
```

The pipeline preflights paths and evidence aliases, creates a privacy-filtered
snapshot, attaches explicit evidence, validates every manifest hash, evaluates
the selected scope, and writes an anonymized public report. Filesystem roots,
the home directory, relative paths, duplicate aliases, and secret evidence
filenames are rejected before snapshotting.

Quality checks use local binaries from `node_modules` and a fixed tool
allowlist (`tsc`, `jest`, `vitest`, `eslint`, and `tslint`). They run without a
shell, with a sanitized environment, bounded arguments, capped output, and a
timeout. A required failure stops evaluation and public export; full logs stay
private beside the evaluation.

The individual commands remain available for inspection and repair:

```bash
npm run build
node apps/cli/dist/main.js eval snapshot \
  --source /absolute/path/to/repository \
  --project Local-Pilot
node apps/cli/dist/main.js eval validate --id <evaluation-id>
node apps/cli/dist/main.js eval attach \
  --id <evaluation-id> \
  --file /private/local/design-flow.yaml \
  --as design-flow.yaml
node apps/cli/dist/main.js eval attach \
  --id <evaluation-id> \
  --file /private/local/test-plan.yaml \
  --as test-plan.yaml
node apps/cli/dist/main.js eval run --id <evaluation-id> --mode rules
node apps/cli/dist/main.js eval report --id <evaluation-id>
node apps/cli/dist/main.js eval export-public --id <evaluation-id>
```

For local semantic suggestions, set `ARF_AI_PROVIDER=ollama`; non-loopback
provider endpoints are rejected. The default is deterministic Mock mode.

`eval attach` copies only the explicitly named evidence into the private
snapshot and records its hash. Secret filenames and directory traversal are
rejected. Static screenshots should remain outside the snapshot; reference
their SHA-256 hashes from a human-reviewed design-flow file instead.

Draft Postman supplements and test plans are readiness evidence only. They
produce human-review links and separate readiness metrics; they never increase
reviewed API-spec coverage or executable-test coverage.

The MileMesh repository is the public synthetic benchmark:

```bash
node apps/cli/dist/main.js eval score \
  --id <milemesh-evaluation-id> \
  --ledger ../milemesh-mock/benchmark/expected-findings.json
```

Known-gap ledger schema v2 scores exact stable finding identities and reports
missed gap IDs plus unexpected finding IDs. Schema v1 remains supported for
legacy rule-count scoring, and the score output always declares its
`matchMode`.

## Privacy boundary

No company source, endpoint, screenshot, schema, or absolute path belongs in a
public export. Approval to push code to a forge and approval to send context to
an AI provider are separate policies. This POC supports local providers only.

`EvaluationRun` terminates at `REPORT_READY`. It never creates a branch or pull
request. `ChangeRun` is a separate future workflow whose maximum authority is
`DRAFT_PR_CREATED`; merge and deployment are prohibited.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and pull-request
expectations, [SECURITY.md](SECURITY.md) for private vulnerability reporting,
and [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT © 2026 SuperAI Engineer SS6 contributors.

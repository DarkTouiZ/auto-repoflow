# Engineering Evidence Auditor POC

## Outcome

The POC turns scattered software-engineering artifacts into a reviewable
evidence graph:

```text
Requirement → Screen/action → API operation → code symbol → test/quality check
```

It answers four practical questions before implementation review:

1. What is in scope?
2. Which artifacts agree?
3. What is missing or contradictory?
4. What evidence supports each conclusion?

This is an auditor, not an autonomous merger. `EvaluationRun` stops at
`REPORT_READY`. The separate future `ChangeRun` stops at
`DRAFT_PR_CREATED`.

## Current architecture

- CLI and loopback-only NestJS API
- Angular control-room console
- file-backed POC storage under `~/.autorepoflow-private`
- SHA-256 immutable snapshot manifest
- deterministic extractors and rule engine
- provider port for Mock and loopback-only Ollama
- public aggregate exporter
- synthetic MileMesh benchmark

The file-backed adapter keeps the POC runnable without Docker. A MySQL metadata
adapter can replace it behind the same service boundary after the pilot proves
the workflow.

## Supported evidence

- reviewed `design-flow.yaml`
- Mermaid ER diagrams
- Postman collections
- Express router registrations and mounted prefixes
- TypeScript symbols
- Jest/Vitest test titles
- reviewed or draft API-spec supplements
- explicit operation-level test plans
- root package quality commands
- GitHub Actions workflow evidence
- Auto-RepoFlow World Contract

## Evaluation

| Metric | POC target |
| --- | ---: |
| Route/API inventory | 100% |
| Known-gap recall | ≥85% |
| Known-gap precision | ≥80% |
| Traceability coverage | ≥85% |
| Findings with evidence references | 100% |
| Review-preparation time reduction | ≥30% |
| Report time | ≤5 minutes |
| Data egress | 0 |
| Private identifiers in public export | 0 |

MileMesh supplies 10 synthetic operations and 22 known gaps. It is appropriate
for public screenshots and repeatable benchmark results. A private pilot must
be reported only as approved aggregate metrics and labeled single-reviewer
until a second reviewer validates the ground truth.

## Known POC limits

- Static PNG designs require a human-reviewed design-flow file.
- Dynamic router construction, generated APIs, and non-Express frameworks need
  additional adapters.
- Route registration proves an implementation entry point, not a complete
  controller/service/repository chain.
- Test linking uses names and metadata; command execution evidence is a separate
  next adapter.
- Draft API requests and test plans improve readiness coverage only. They remain
  human-review evidence and cannot satisfy approved-spec or executable-test
  metrics.
- The dashboard has local browser QA at desktop and 390px mobile widths; broader
  accessibility and cross-browser coverage remain future gates.
- Ollama quality and latency remain unmeasured until a local model is running.

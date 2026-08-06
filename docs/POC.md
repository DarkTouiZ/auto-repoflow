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

This is an auditor and bounded local verifier, not an autonomous merger. The
v0.2 `EvaluationRun` still stops at a validated Fix Packet. The opt-in v0.3
`ChangeRun` isolates one JavaScript/TypeScript test-gap patch and stops at
`VERIFIED_LOCAL_PATCH`; it cannot push or create a pull request.

## Current architecture

- CLI and loopback-only NestJS API
- optional read-only Angular console
- file-backed POC storage under `~/.autorepoflow-private`
- SHA-256 immutable snapshot manifest
- deterministic extractors and rule engine
- provider-neutral structured-output adapters for loopback Ollama and
  explicit opt-in OpenAI, Anthropic, and Google
- private hash-bound design/test-plan drafts
- atomic file queue and worker for the optional service
- public aggregate exporter
- synthetic MileMesh benchmark
- hash-pinned MileMesh Lite guided replay/handoff demo
- private atomic ChangeRun and counterbalanced outcome-trial state

The file-backed adapter keeps the POC runnable without Docker. A MySQL metadata
adapter can replace it behind the same service boundary after the pilot proves
the workflow.

## Supported evidence

- reviewed `design-flow.yaml`
- Mermaid ER diagrams
- OpenAPI, Postman, and Markdown declarations
- Express and NestJS route registrations and mounted prefixes
- frontend fetch/axios calls
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
| Data egress without both policy and command consent | 0 |
| Private identifiers in public export | 0 |

MileMesh supplies 10 synthetic operations and 22 known gaps. It is appropriate
for public screenshots and repeatable benchmark results. A private pilot must
be reported only as approved aggregate metrics and labeled single-reviewer
until a second reviewer validates the ground truth.

## Known POC limits

- Static PNG designs require a human-reviewed design-flow file.
- Dynamic router construction, generated APIs, and non-JavaScript/TypeScript
  frameworks need additional adapters.
- Route registration proves an implementation entry point, not a complete
  controller/service/repository chain.
- Test linking uses names and metadata. ChangeRun verification executes only
  exact schema-v2 policy checks after a separate command-consent flag; this is
  not an OS or network sandbox.
- Draft API requests and test plans improve readiness coverage only. They remain
  human-review evidence and cannot satisfy approved-spec or executable-test
  metrics.
- The dashboard has local browser QA at desktop and 390px mobile widths; broader
  accessibility and cross-browser coverage remain future gates.
- Ollama quality and latency remain unmeasured until a local model is running.

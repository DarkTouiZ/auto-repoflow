# Auto-RepoFlow

[![CI](https://github.com/DarkTouiZ/auto-repoflow/actions/workflows/ci.yml/badge.svg)](https://github.com/DarkTouiZ/auto-repoflow/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/auto-repoflow.svg)](https://www.npmjs.com/package/auto-repoflow)
[![license](https://img.shields.io/npm/l/auto-repoflow.svg)](LICENSE)

Auto-RepoFlow is a privacy-first, headless engineering-evidence auditor and
guided local change verifier. It connects requirements, design, APIs, code,
tests, and CI, then produces a validated Fix Packet for the IDE agent the user
already controls. Version 0.3 can isolate and verify one JavaScript/TypeScript
test-gap patch; it never invokes an agent, pushes, opens a pull request, merges,
deploys, or publishes.

This public repository contains no company source code, internal endpoint,
private record, credential, or proprietary schema.

## Quick start

Requirements: Node.js 22+ and npm.

```bash
npx auto-repoflow@0.3.0 demo
npx auto-repoflow@0.3.0 demo --scenario delivery-status
npx auto-repoflow@0.3.0 demo --mode handoff
npx auto-repoflow scan .
```

The zero-config command is non-interactive. `--ai auto` probes only a
configured Ollama model over HTTP loopback and falls back successfully to
deterministic rules. It never downloads a model or falls back to cloud.

Produce a packet for the assistant or coding agent you already use:

```bash
npx auto-repoflow scan . \
  --format agent-md \
  --out auto-repoflow-fix-packet.md
```

Supported outputs are `human`, `json`, `agent-md`, and `agent-json`. Reports
and packets default to schema v2; `--compat v1` preserves the v0.1 packet
contract in v0.3. The deprecated `--mode rules|local-ai` remains available for
compatibility.

JavaScript and TypeScript are the only languages with stable v0.3 coverage.
Other languages must be treated as partial/unsupported, not as fully covered.

## Guided before/after demo

The default demo is a deterministic, hash-pinned replay on the bundled MIT
MileMesh Lite fixture. It creates a real private Git repository and worktree,
runs baseline tests and scanning, applies the pinned test-only patch only after
`git apply --check`, verifies it, rescans, and confirms that the original
fixture is unchanged. Expected output is one target finding to zero and test
linkage from 50% to 100%.

Replay is labelled clearly as deterministic automation, not live AI and not
AI-quality evidence. `--mode handoff` stops after creating the isolated
worktree, Fix Packet, and prompt so the user can open Copilot, Claude, or Codex
in the IDE. AutoRepoFlow never invokes those agents itself.

## Verified local ChangeRun

ChangeRun v0.3 supports only `ARF-TEST-001` gaps and JavaScript/TypeScript test
files. A schema-v2 private policy and a clean Git checkout are required.
Ignored files such as `node_modules` are allowed; tracked and untracked changes
are rejected.

```bash
auto-repoflow change start . \
  --policy /absolute/private/change-policy.yaml \
  --agent-label copilot

auto-repoflow change status --id <change-id>

auto-repoflow change verify \
  --id <change-id> \
  --policy /absolute/private/change-policy.yaml \
  --allow-verification

auto-repoflow change report --id <change-id>
auto-repoflow change cleanup --id <change-id> --confirm
```

The private worktree is pinned to the original commit. Fix Packet, prompt,
manifest, scan reports, bounded logs, and patch stay under
`~/.autorepoflow-private/change-runs`. Verification rejects source,
configuration, dependency, protected-path, symlink, binary, deletion, rename,
and oversized changes. It permits at most five test files and 200 KB, runs only
exact policy checks with `shell:false`, and never calls `npm install`.

Policy permission and `--allow-verification` form the two authorization keys.
Failed checks can return to `REPAIR_REQUIRED` for at most two repair rounds.
Success stops at `VERIFIED_LOCAL_PATCH`. The public outcome report contains
only before/after counts and test linkage, verification status, patch
size/hash, duration, attempts, and a normalized agent label; it excludes
source, diff, logs, paths, revisions, finding IDs, and participant tokens.

The sanitized verification environment and timeouts are not an operating-
system or network sandbox.

## Counterbalanced outcome trial

The v0.3 trial creates four private sessions from the two bundled fixtures:
each participant receives one assisted and one unassisted scenario in
counterbalanced order. Both sessions for a participant must use the same IDE
agent label. Work time excludes ChangeRun setup, scan, and verification.

```bash
auto-repoflow trial prepare --id mentor-v03
auto-repoflow trial run \
  --study mentor-v03 --session 01 --agent-label claude
auto-repoflow trial review \
  --study mentor-v03 --session 01 \
  --reviewer-token verifier-a --decision accept
auto-repoflow trial status --study mentor-v03
auto-repoflow trial summary \
  --study mentor-v03 --out /absolute/private/summary.json
```

The first `trial run` prepares the handoff and starts the work timer; rerunning
the same command verifies and completes or requests a bounded repair. An
independent reviewer token must differ from the participant and every decision
is bound to the verified patch SHA-256. Public summaries expose exact counts
and paired medians only; no statistical time-reduction claim is made from two
participants.

## AI execution

```bash
# Rules only
npx auto-repoflow scan . --ai off

# Local Ollama; a missing server or model is an error
npx auto-repoflow scan . --ai local --model qwen3-coder:30b

# Cloud: all four controls are mandatory
npx auto-repoflow scan . \
  --ai cloud \
  --provider openai \
  --model <model-id> \
  --policy /absolute/private/automation-policy.yaml \
  --allow-cloud-metadata
```

Cloud execution requires an explicit provider/model, permission in the private
policy, the `--allow-cloud-metadata` consent flag, and the provider key in one
of these environment variables:

- `ARF_OPENAI_API_KEY`
- `ARF_ANTHROPIC_API_KEY`
- `ARF_GOOGLE_API_KEY`

Keys are rejected from YAML and never belong in flags, logs, reports, packets,
the console, or request bodies. Ollama is limited to loopback; cloud adapters
are limited to the official OpenAI, Anthropic, and Google HTTPS hosts. Custom
provider URLs are intentionally unsupported.

Cloud payloads contain only anonymous candidate IDs, relation/artifact kinds,
sanitized names, and API locators. They exclude source bodies, filesystem
paths, project labels, notes, logs, secrets, and keys. Before a CLI cloud call,
Auto-RepoFlow prints the candidate count, allowed metadata fields, and payload
SHA-256. Reports retain the provider/model, status, latency, usage when
available, prompt/schema versions, accepted/rejected counts, and payload hash;
raw prompts and responses are not stored.

Repository text is always untrusted data. Providers have no tools or command
execution capability. Invented or out-of-candidate links are rejected, and
every AI-only edge is `HUMAN_REVIEW_REQUIRED`; model confidence is never a
correctness score or a route to `PASS`.

## Private policy

Copy [the example policy](templates/automation-policy.example.yaml) outside
the repository, edit the provider/model and export roots, then set its file
mode to `0600`. Do not add credentials.

Policy v1 controls scan/AI evidence and remains scan-compatible. ChangeRun
rejects policy v1 and requires
[`templates/change-policy.example.yaml`](templates/change-policy.example.yaml):
schema version 2, `change.enabled: true`, `automation.maxStage: local-patch`,
exact checks, timeouts, and bounds. Neither policy version can authorize a
push, pull request, merge, deploy, or publish in v0.3.

## Evidence maturity and drafts

Auto-RepoFlow distinguishes:

- `OBSERVED`: source, routes, tests, and CI found in the snapshot;
- `DECLARED`: OpenAPI, Postman, Markdown, ADR, or reviewed declarations;
- `GENERATED`: rules/AI-assisted draft material;
- `REVIEWED`: a human-approved draft bound to its exact SHA-256.

`--generate-evidence missing` is the default. Canonical JSON drafts are stored
under `~/.autorepoflow-private/evaluations/<id>/drafts`; nothing is written to
the scanned repository. Generated design/test plans always start as
`draft_generated_requires_team_review` and never increase reviewed coverage.

```bash
auto-repoflow evidence list --id <evaluation-id>
auto-repoflow evidence validate --file /private/drafts/design-flow.json
auto-repoflow evidence approve \
  --id <evaluation-id> \
  --review-manifest /private/review-manifest.json
auto-repoflow evidence export \
  --id <evaluation-id> \
  --to /policy/allowed/export/directory \
  --policy /absolute/private/automation-policy.yaml
```

Approval requires an anonymous reviewer token, decision, timestamp, draft ID,
and exact draft hash. AI identities cannot approve their own output. Export is
restricted to policy roots and refuses to overwrite existing files.

## Privacy, retention, and metrics

Private snapshots exclude `.git`, `.env*`, credentials, keys, certificates,
logs, dependencies, and build outputs before copying. Files are hashed and the
source root is not stored in reports. A successful default scan removes its raw
snapshot; `--keep-snapshot` retains the filtered private copy explicitly.

```bash
auto-repoflow purge --policy /absolute/private/automation-policy.yaml
auto-repoflow metrics summary
auto-repoflow metrics export --to /private/poster/arf-metrics.json
```

Default retention is 24 hours for failed-run snapshots and seven days for
drafts/reports. Metrics are local aggregates without project names, paths, or
source; there is no remote telemetry. Metric export does not overwrite files.
Fix Packets can contain relative engineering metadata, so review them before
sharing or committing.

## Extractors and outputs

The v0.3 evaluator recognizes reviewed design/test-plan YAML, OpenAPI, Postman,
Markdown requirements, Mermaid ERDs, Express/NestJS routes, frontend
fetch/axios calls, TypeScript symbols, Playwright/Cypress-style tests, package
scripts, CI workflows, and World Contracts. Deterministic evidence is kept
separate from generated or inferred readiness material.

Quality commands are opt-in and drawn from a fixed local allowlist. A sanitized
environment, bounded output, and timeout do not constitute an OS or network
sandbox; do not claim arbitrary repository scripts are safe.

## Optional loopback service and console

The public npm command runs in-process and needs no API. The optional NestJS
service exposes enqueue/status/report/events/draft-read endpoints backed by an
atomic file queue under the private root. Set `ARF_API_TOKEN` for mutation
endpoints and `ARF_POLICY_PATH` for the server-wide policy. Request bodies are
strict and cannot contain API keys or arbitrary policy paths.

```bash
npm install
npm run build
ARF_API_TOKEN=<local-token> npm start -w @auto-repoflow/api
ARF_POLICY_PATH=/absolute/private/policy.yaml \
  npm start -w @auto-repoflow/worker -- --once
```

The Angular console is an optional read-only viewer for progress, AI trace,
privacy decisions, evidence maturity, coverage, and benchmark results. It is
not part of the npm CLI package and cannot start, approve, export, edit, push,
merge, deploy, or publish.

## Private usability pilot recorder

`scan` remains fully headless and non-interactive. The separate, explicitly
invoked `pilot run` command is an interactive terminal recorder for small local
usability studies. It verifies a pinned pristine Git target, displays only the
controlled session input, records start/finish timestamps automatically, and
asks short completion, clarity, handoff-readiness, and one-line proposal
questions.

```bash
auto-repoflow pilot prepare \
  --config /absolute/private/usability-pilot.yaml
auto-repoflow pilot validate --study pilot-1
auto-repoflow pilot run --study pilot-1 --session 01
auto-repoflow pilot status --study pilot-1
auto-repoflow pilot summary --study pilot-1 \
  --out /absolute/private/usability-summary.json
```

Study configuration and raw records stay beneath
`~/.autorepoflow-private/pilots`. Controlled inputs must be private files under
their study root and are rejected if they contain an absolute user path, email,
or common secret-shaped value. Public summaries omit reviewer/session/finding
tokens, target identifiers, paths, timestamps, proposal text, and comments.
Usability summaries may support ease-of-use observations only; they explicitly
prohibit engineering-accuracy or human-acceptance claims. Formal acceptance
still follows the separate mentor review protocol.

## Development and poster evidence

```bash
npm install
npm run doctor
npm run check
```

For evaluation pipelines, known-gap scoring, MileMesh synthetic benchmarking,
and human-pilot reporting, see:

- [Benchmark protocol](docs/BENCHMARK_PROTOCOL.md)
- [Mentor evaluation guide](docs/MENTOR_EVALUATION_GUIDE.md)
- [Thai system flow guide](docs/SYSTEM_FLOW_GUIDE_TH.md)
- [Privacy model](docs/PRIVACY.md)

Contract compatibility tests and human acceptance are separate evidence. The
poster should compare rules and local-AI runs independently and report human
acceptance/reclassification plus time-to-proposal. Raw worksheets stay outside
Git.

Release evidence must report replay, assisted trials, manual outcomes, and
human acceptance separately. The two-person trial is descriptive evidence
only. Merge, deploy, package publication, and access widening remain separate
human-controlled release actions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[CHANGELOG.md](CHANGELOG.md).

## License

MIT © 2026 SuperAI Engineer SS6 contributors.

# Auto-RepoFlow CLI

Auto-RepoFlow is a privacy-first, headless repository evidence scanner and
guided local test-change verifier for JavaScript and TypeScript. It produces a
human report or validated Fix Packet for the IDE agent the user already
controls; AutoRepoFlow does not invoke an agent itself.

## Quick start

Node.js 22 or newer is required.

```bash
npx auto-repoflow@0.3.0 demo
npx auto-repoflow@0.3.0 demo --scenario delivery-status
npx auto-repoflow@0.3.0 demo --mode handoff
npx auto-repoflow scan .
npx auto-repoflow scan . --format agent-md --out fix-packet.md
```

The default demo is a hash-pinned deterministic replay on the bundled MIT
MileMesh Lite fixture. It is explicitly not live-AI or AI-quality evidence.
It runs a real scan/worktree/verification/rescan flow and should show the target
finding `1 -> 0`, test linkage `50% -> 100%`, passing checks, and an unchanged
original fixture. Handoff mode stops for the user to open an IDE agent.

## Verified local ChangeRun

ChangeRun v0.3 is limited to one `ARF-TEST-001` gap and test-only patches. It
requires a clean Git checkout and a schema-v2 private policy.

```bash
auto-repoflow change start . \
  --policy /absolute/private/change-policy.yaml \
  --agent-label codex
auto-repoflow change status --id <change-id>
auto-repoflow change verify \
  --id <change-id> \
  --policy /absolute/private/change-policy.yaml \
  --allow-verification
auto-repoflow change report --id <change-id>
auto-repoflow change cleanup --id <change-id> --confirm
```

Only JavaScript/TypeScript files matching `*.test.*`, `*.spec.*`, `test/`,
`tests/`, or `__tests__/` may change. Binary, symlink, deletion, rename,
source, config, dependency, protected-path, over-five-file, and over-200-KB
patches are rejected. Verification runs exact policy checks with `shell:false`
and never installs dependencies. The terminal success state is
`VERIFIED_LOCAL_PATCH`; it does not push or open a pull request.

## Outcome trial

```bash
auto-repoflow trial prepare --id mentor-v03
auto-repoflow trial run \
  --study mentor-v03 --session 01 --agent-label claude
auto-repoflow trial review \
  --study mentor-v03 --session 01 \
  --reviewer-token verifier-a --decision accept
auto-repoflow trial status --study mentor-v03
auto-repoflow trial summary --study mentor-v03
```

Four counterbalanced assisted/unassisted sessions use the same IDE agent per
participant. Independent review is patch-hash bound. Aggregates contain exact
counts and paired medians without tokens, raw responses, or statistical time-
reduction claims.

The `--ai auto` default probes only a configured loopback Ollama model. If no
model is configured or available it exits successfully with deterministic
rules. It never downloads a model and never falls back to cloud.

```bash
auto-repoflow scan . --ai off
auto-repoflow scan . --ai local --model qwen3-coder:30b
```

## Explicit cloud metadata

OpenAI, Anthropic, and Google require all of: `--ai cloud`, an explicit
provider/model, permission in a private `0600` policy, the
`--allow-cloud-metadata` consent flag, and the provider key in
`ARF_OPENAI_API_KEY`, `ARF_ANTHROPIC_API_KEY`, or `ARF_GOOGLE_API_KEY`.

```bash
auto-repoflow scan . \
  --ai cloud --provider openai --model <model-id> \
  --policy /absolute/private/policy.yaml \
  --allow-cloud-metadata
```

Cloud payloads exclude source bodies, filesystem paths, project labels, logs,
secrets, and API keys. Custom provider URLs are not supported. AI has no tools,
invented candidate IDs are rejected, and AI-only links always require human
review; they never become `PASS` from model confidence.

## Private evidence drafts

Missing design/test evidence becomes hash-bound JSON drafts under
`~/.autorepoflow-private`, never files in the scanned repository.

```bash
auto-repoflow evidence list --id <evaluation-id>
auto-repoflow evidence validate --file /private/draft.json
auto-repoflow evidence approve --id <id> --review-manifest /private/review.json
auto-repoflow evidence export \
  --id <id> --to /allowed/export --policy /absolute/private/policy.yaml
```

Generated evidence does not count as reviewed. Human approval is bound to the
exact draft SHA-256, AI identities cannot approve, export is policy-contained,
and existing files are never overwritten by default.

## Optional private usability pilot

The scan command is always non-interactive. `pilot run` is a separate opt-in
terminal recorder that automatically times a controlled usability session and
stores raw answers only under the private root.

```bash
auto-repoflow pilot prepare --config /absolute/private/pilot.yaml
auto-repoflow pilot validate --study pilot-1
auto-repoflow pilot run --study pilot-1 --session 01
auto-repoflow pilot status --study pilot-1
auto-repoflow pilot summary --study pilot-1
```

The aggregate omits identities, paths, timestamps, finding tokens, proposals,
and comments. It is usability evidence, not engineering-accuracy or human-
acceptance evidence.

## Safety boundary

The default scan statically evaluates a privacy-filtered private snapshot.
ChangeRun creates an isolated branch/worktree and runs only exact checks after
policy plus command consent. It does not invoke a coding agent, edit source,
push, create a pull request, merge, deploy, publish, or widen access. Successful
scans remove the raw snapshot unless `--keep-snapshot` is set. Always review
packets before sharing because relative engineering metadata can be sensitive.

Formats: `human`, `json`, `agent-md`, `agent-json`. Schema v2 is the default;
`--compat v1` keeps the legacy packet contract in v0.3.

Run `auto-repoflow help` for every command and option.

License: MIT

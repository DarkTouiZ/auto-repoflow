# Auto-RepoFlow CLI

Auto-RepoFlow is a privacy-first, headless repository evidence scanner for
JavaScript and TypeScript. It produces a human report or validated Fix Packet
for the AI assistant or coding agent you already use.

## Quick start

Node.js 22 or newer is required.

```bash
npx auto-repoflow scan .
npx auto-repoflow scan . --format agent-md --out fix-packet.md
```

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

## Safety boundary

The CLI statically evaluates a privacy-filtered private snapshot. It does not
run repository scripts, invoke a coding agent, edit source, create a branch or
pull request, merge, deploy, publish, or widen access. Successful scans remove
the raw snapshot unless `--keep-snapshot` is set. Always review packets before
sharing because relative engineering metadata can still be sensitive.

Formats: `human`, `json`, `agent-md`, `agent-json`. Schema v2 is the default;
`--compat v1` keeps the legacy packet contract throughout 0.2.x.

Run `auto-repoflow help` for every command and option.

License: MIT

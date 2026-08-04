# Privacy model

## Trust boundary

Company artifacts stay on the local machine. A Git remote, an AI provider, and
a public report are three independent trust decisions. Approval for one never
implies approval for another.

## Snapshot policy

Private snapshots are created under `~/.autorepoflow-private` with directory
mode `0700` and file mode `0600` for manifests and reports. The manifest stores
a repository label and hashes, not the absolute source root.

The copy process rejects before copying:

- `.git`
- `.env*`
- private keys and certificates
- dependency and build output folders
- coverage, caches, logs, worktrees, mirrors, and prior artifacts
- symbolic links

Every included file receives a SHA-256 digest. `eval validate` detects missing
or modified snapshot files.

External design evidence is opt-in through `eval attach`. The command accepts a
safe destination filename only, rejects secret filenames and path traversal,
and updates the immutable manifest digest. For static screenshots, attach a
reviewed YAML file containing screenshot hashes rather than the images.

Successful zero-config `scan` commands delete their raw snapshots by default.
Use `--keep-snapshot` only when the filtered copy is needed for advanced local
inspection. Advanced `eval` workflows retain raw snapshots until they are
deleted per evaluation or by policy retention. Failed-run snapshots default
to 24 hours; reports and drafts default to seven days. Reports,
manifests, privacy decisions, and aggregate metrics remain available after raw
deletion.

## AI provider boundary

The zero-config default probes only Ollama over plain HTTP on `127.0.0.1`,
`localhost`, or `::1`, then falls back to rules. It does not pull a model.
OpenAI, Anthropic, and Google require a provider/model pinned in a private
policy, policy permission for cloud metadata, the command consent flag, and an
environment API key. `auto` never selects cloud.

Cloud adapters use only their official HTTPS hosts. Payloads contain anonymous
candidate/artifact IDs, relation and artifact kinds, pseudonymized names, and
API locators. They exclude source bodies, filesystem paths, project labels,
notes, logs, secrets, and API keys. The CLI prints a count/field/hash egress
summary before each cloud stage. Raw prompts and responses are not stored.

AI output is schema-validated and evidence-checked:

- invented node IDs are discarded;
- invented evidence IDs are discarded;
- every AI-only link requires human review regardless of confidence;
- AI never changes deterministic command or schema failures.

Generated evidence remains `GENERATED` until an anonymous human review
manifest approves the exact draft SHA-256. AI identities cannot approve their
own output.

## Public export

The public exporter includes aggregate counts and percentages only. It excludes
project/company names, absolute paths, API endpoints, database names and fields,
screenshots, and code excerpts.

Before publishing, a human must still inspect the generated JSON and approve
the exact file. The POC never pushes or publishes it automatically.

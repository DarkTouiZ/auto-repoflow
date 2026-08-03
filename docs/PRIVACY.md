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
deleted per evaluation or by the seven-day retention command. Reports,
manifests, privacy decisions, and aggregate metrics remain available after raw
deletion.

## Local AI

The default provider is deterministic Mock. Ollama is accepted only over plain
HTTP on `127.0.0.1`, `localhost`, or `::1`. The prompt contains artifact
metadata, not raw source bodies.

AI output is schema-validated and evidence-checked:

- invented node IDs are discarded;
- invented evidence IDs are discarded;
- low-confidence links require human review;
- AI never changes deterministic command or schema failures.

## Public export

The public exporter includes aggregate counts and percentages only. It excludes
project/company names, absolute paths, API endpoints, database names and fields,
screenshots, and code excerpts.

Before publishing, a human must still inspect the generated JSON and approve
the exact file. The POC never pushes or publishes it automatically.

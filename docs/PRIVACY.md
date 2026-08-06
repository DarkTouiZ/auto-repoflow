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

## ChangeRun boundary

ChangeRun creates its branch, worktree, Fix Packet, prompt, manifest, baseline
and after reports, bounded verification logs, and patch under the private root.
The private manifest records the local source root and pinned revision because
Git must manage the worktree; these values never enter the public
`ChangeOutcomeReport`.

The original checkout must be clean at intake and its exact HEAD/status are
checked again before accepting a patch. Only JavaScript/TypeScript test paths
are accepted. Source, configuration, dependencies, protected paths, binary
content, symlinks, deletions, renames, more than five files, and patches above
200 KB are rejected. Verification requires both schema-v2 policy permission and
`--allow-verification`, uses `shell:false`, and never installs dependencies.

AutoRepoFlow does not send the repository to an agent or cloud provider during
ChangeRun. The user opens an already trusted IDE agent in the isolated
worktree. Agent authentication, privacy settings, and any source egress remain
the user's separate decision. AutoRepoFlow never invokes, pushes, opens a pull
request, merges, deploys, or publishes.

The public outcome allowlist contains before/after finding counts and test
linkage, aggregate check status, patch size/hash, duration, attempts, and a
normalized agent label. It excludes source, diff, logs, paths, revisions,
finding IDs, and participant/session/reviewer tokens.

## Outcome-trial boundary

The counterbalanced outcome trial uses public synthetic fixtures only. Private
study state stores participant/reviewer tokens, worktree paths, timing, and
patch hashes. Unassisted sessions are not shown the validated Fix Packet;
assisted sessions are. The same normalized IDE-agent label is enforced across
each participant's pair.

Independent decisions are bound to the verified patch SHA-256 and require a
reviewer token different from the participant token. Aggregate summaries omit
all tokens, session IDs, paths, patch hashes, timestamps, and raw responses.
They report exact counts and paired medians without a statistical time-
reduction claim.

## Usability pilot boundary

The optional interactive `pilot run` command is separate from non-interactive
scanning. Study config, timestamps, reviewer/session/finding tokens, one-line
proposal text, and comments stay under the private pilot root. A session starts
only when its target matches the pinned Git SHA and has no tracked, untracked,
or ignored files; the same integrity check runs again before completion.
Assisted input must be a private file under that study root and is rejected if
it contains an absolute user path, an email address, or common secret-shaped
data.

The pilot aggregate exports counts, ratings, timing ranges, and paired timing
only. It excludes raw records and every token, target identifier, path,
timestamp, proposal, and comment. Its schema explicitly disallows engineering-
accuracy and human-acceptance claims; those require the formal reviewed pilot.

## Public export

The public exporter includes aggregate counts and percentages only. It excludes
project/company names, absolute paths, API endpoints, database names and fields,
screenshots, and code excerpts.

Before publishing, a human must still inspect the generated JSON and approve
the exact file. AutoRepoFlow never pushes or publishes it automatically.

# Auto-RepoFlow CLI

Auto-RepoFlow is a privacy-first repository evidence scanner. It produces a
human-readable review or a structured fix packet that you can hand to the AI
assistant or coding agent you already use.

## Quick start

Node.js 22 or newer is required.

```bash
npx auto-repoflow scan .
```

Create a Markdown handoff for an agent:

```bash
npx auto-repoflow scan . --format agent-md --out auto-repoflow-fix-packet.md
```

Or create a machine-readable handoff:

```bash
npx auto-repoflow scan . --format agent-json --out auto-repoflow-fix-packet.json
```

You can also install the command globally:

```bash
npm install --global auto-repoflow
auto-repoflow scan /path/to/repository
```

## Safe default

`scan` performs static evaluation against a filtered private snapshot. It does
not run repository scripts, edit source files, call cloud AI, merge, deploy, or
publish. The raw snapshot is removed after a successful scan by default;
privacy decisions, hashes, and the generated report remain under
`~/.autorepoflow-private` without storing the absolute source root.

Retain the filtered raw snapshot only when you need advanced local inspection:

```bash
auto-repoflow scan /path/to/repository --keep-snapshot
```

Auto-RepoFlow excludes common secrets, environment files, repository metadata,
dependencies, build outputs, and files larger than 5 MB from snapshots. Always
review generated handoffs before sharing them.

## Formats

- `human` — concise terminal summary (default)
- `json` — complete evaluation report
- `agent-md` — portable instructions and evidence for a coding agent
- `agent-json` — structured Agent Fix Packet

Run `auto-repoflow help` for all options.

## Current scope

This public alpha focuses on JavaScript and TypeScript repositories. It checks
repository evidence and workflow completeness; it does not claim that a finding
is automatically safe to fix.

License: MIT

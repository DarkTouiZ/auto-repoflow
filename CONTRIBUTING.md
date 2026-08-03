# Contributing to Auto-RepoFlow

Thank you for helping improve Auto-RepoFlow. Contributions should strengthen
its evidence quality, privacy boundary, or public usability without expanding
its authority to merge or deploy code.

## Development setup

Requirements: Node.js 22 or newer, npm, and Git.

```bash
git clone https://github.com/DarkTouiZ/auto-repoflow.git
cd auto-repoflow
npm ci
npm run check
```

Use a focused branch and keep changes small enough to review. Add or update
tests when behavior changes, then run `npm run check` before opening a pull
request.

## Pull requests

A useful pull request explains:

- the user or evaluator problem being solved;
- the evidence or rule behavior that changes;
- privacy and execution-safety implications;
- the tests and repository fixtures used for verification.

Do not include company source code, private records, credentials, `.env` files,
raw evaluation artifacts, or user-specific absolute paths. Use synthetic or
public fixtures and anonymized evidence.

Package versions, release tags, npm publishing, merge, and deployment remain
maintainer-controlled actions. Contributors should not add workflows that use
long-lived write tokens.

## Issues and security reports

Use GitHub Issues for reproducible bugs and narrowly scoped feature proposals.
Do not put secrets or private repository contents in an issue. Follow
[SECURITY.md](SECURITY.md) for sensitive reports and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

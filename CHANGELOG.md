# Changelog

All notable user-facing changes to Auto-RepoFlow are recorded here. This
project follows semantic versioning.

## [Unreleased]

## [0.3.0] - Unreleased

### Added

- Added a deterministic MileMesh Lite guided demo with hash-pinned replay and
  transparent IDE-agent handoff modes.
- Added private ChangeRun state, isolated Git worktrees, deterministic
  `ARF-TEST-001` selection, test-only patch validation, exact allowlisted
  verification, bounded repair/resume, rescan, and before/after reports.
- Added schema-v2 change policy with two-key verification authorization while
  preserving policy-v1 scan compatibility.
- Added a four-session counterbalanced assisted/unassisted outcome trial with
  same-agent enforcement, independent patch-hash-bound review, exact counts,
  and paired medians.
- Expanded package smoke coverage and CI to macOS, Linux, and Windows on Node
  22 and 24.

### Security

- ChangeRun rejects source, config, dependency, protected-path, binary,
  symlink, deletion, rename, oversized, and non-test changes.
- Public change outcomes exclude source, diffs, logs, paths, revisions,
  finding IDs, and participant/session tokens.
- AutoRepoFlow never invokes an IDE agent, installs dependencies during
  verification, pushes, creates a pull request, merges, deploys, or publishes.

## [0.2.0] - 2026-08-04

### Added

- Added headless `auto|off|local|cloud` AI modes with loopback Ollama and
  explicit opt-in OpenAI, Anthropic, and Google structured-output adapters.
- Added private automation policy, two-key cloud consent, metadata egress
  summaries, provider execution trace, schema v2 reports, and v1 packet
  compatibility.
- Added private design/test-plan drafts with evidence maturity, hash-bound
  human approval, allowlisted non-overwriting export, retention purge, and
  anonymized local metrics.
- Added OpenAPI, NestJS, fetch/axios, Markdown, and expanded test extraction.
- Added an optional bearer-protected loopback enqueue API, atomic file queue,
  real worker, sanitized NDJSON events, and read-only console observability.
- Added an optional private terminal usability-pilot recorder with pinned clean
  targets, automatic timing, controlled inputs, and identity-free aggregates.

### Security

- Cloud payloads exclude source bodies, filesystem paths, project labels,
  secrets, and API keys; custom provider URLs remain prohibited.
- AI-only suggestions can never become deterministic `PASS` evidence and AI
  identities cannot approve generated drafts.
- Pilot summaries exclude raw answers, reviewer/session/finding tokens, target
  identifiers, paths, and timestamps, and cannot claim engineering accuracy.

## [0.1.2] - 2026-08-03

### Added

- Added a privacy-safe repeated-scan benchmark runner and public evaluation
  protocol for reproducible presentation evidence.

### Changed

- Prepared the public CLI from sanitized source history so the new npm
  provenance points to the personal `DarkTouiZ/auto-repoflow` project.

## [0.1.1] - 2026-08-03

### Changed

- Documented the published package and public contribution workflow.
- Added token-free npm trusted-publishing automation for future releases.
- Successful zero-config scans now remove their filtered raw source snapshots
  by default; `--keep-snapshot` retains them for advanced local inspection.

## [0.1.0] - 2026-08-02

### Added

- Zero-config `auto-repoflow scan [path]` command.
- Human, JSON, Agent Markdown, and Agent JSON outputs.
- Deterministic Agent Fix Packet schema version 1.
- Privacy-filtered snapshots with secret, repository metadata, symbolic-link,
  generated-output, dependency, and oversized-file exclusions.
- Exact known-gap identity scoring for reproducible benchmark evaluation.
- Standalone npm package for Node.js 22 or newer.

[Unreleased]: https://github.com/DarkTouiZ/auto-repoflow/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/DarkTouiZ/auto-repoflow/compare/v0.1.2...v0.3.0
[0.2.0]: https://github.com/DarkTouiZ/auto-repoflow/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/DarkTouiZ/auto-repoflow/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/DarkTouiZ/auto-repoflow/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DarkTouiZ/auto-repoflow/releases/tag/v0.1.0

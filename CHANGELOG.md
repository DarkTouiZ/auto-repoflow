# Changelog

All notable user-facing changes to Auto-RepoFlow are recorded here. This
project follows semantic versioning.

## [Unreleased]

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

[Unreleased]: https://github.com/DarkTouiZ/auto-repoflow/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/DarkTouiZ/auto-repoflow/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/DarkTouiZ/auto-repoflow/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DarkTouiZ/auto-repoflow/releases/tag/v0.1.0

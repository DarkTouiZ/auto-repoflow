# Public CLI release plan

## Product promise

Auto-RepoFlow turns repository evidence into an actionable review and a
portable Agent Fix Packet. It helps a human or an existing coding agent decide
what to inspect next; it does not silently fix, merge, deploy, or publish code.

## Version 0.1.0 scope

- `auto-repoflow scan [path]` with no configuration required
- safe rules-only evaluation by default
- human, complete JSON, Agent Markdown, and Agent JSON outputs
- secret, repository metadata, dependency, build-output, symbolic-link, and
  oversized-file exclusion before snapshot copy
- standalone npm package for Node.js 22+
- deterministic Agent Fix Packet schema version 1

JavaScript and TypeScript repositories are the supported public-alpha target.
Other repository types may be scanned, but their evidence coverage is not yet
part of the compatibility promise.

## Before publishing to npm

1. Run `npm run check` from a clean checkout on Node.js 22.
2. Run `npm pack -w auto-repoflow` and inspect the tarball contents.
3. Install that tarball in a temporary directory and scan a separate fixture.
4. Confirm the packet contains no source root, secret value, or bundled private
   artifact.
5. Confirm `npm view auto-repoflow` is still unclaimed immediately before the
   first publish.
6. Enable npm trusted publishing or require two-factor authentication; publish
   version `0.1.0` with provenance.
7. Create a GitHub release and copy the verified quick-start command into the
   release notes.

Publishing is intentionally a separate human-approved action.

## Evidence for the internship presentation

Measure the public CLI on the synthetic MileMesh benchmark and at least two
additional public repositories. Report:

- exact known-gap precision and recall;
- number and type of privacy exclusions;
- scan duration and repository size;
- percentage of findings accepted, rejected, or reclassified by a reviewer;
- time from scan to an approved fix proposal;
- whether the receiving agent satisfied each packet acceptance criterion.

For a credible poster, show the baseline manual workflow beside the
Auto-RepoFlow-assisted workflow and retain anonymized, reproducible evaluation
artifacts. Do not use company code or private records in the public evidence.

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

## Release status

Version `0.1.0` was published on 2026-08-02:

- npm: <https://www.npmjs.com/package/auto-repoflow>
- GitHub: <https://github.com/DarkTouiZ/auto-repoflow/releases/tag/v0.1.0>

The first release was published interactively. Registry metadata did not show
a provenance attestation when checked on 2026-08-03.

## One-time trusted publisher setup

Trusted publishing was configured successfully on 2026-08-03 under npm package
**Settings → Trusted Publisher**:

- provider: GitHub Actions
- organization or user: `DarkTouiZ`
- repository: `auto-repoflow`
- workflow filename: `publish.yml`
- allowed action: `npm publish`
- environment: leave empty

The workflow uses GitHub OIDC and does not require an npm write token. A future
release will generate provenance automatically when the trusted-publisher
configuration matches.

## Version 0.1.1 release candidate

- remove the filtered raw snapshot after a successful zero-config scan;
- retain the manifest, privacy decisions, hashes, and report for auditability;
- provide `--keep-snapshot` as an explicit opt-in for local inspection.

This version is prepared for review but is not published until the release
checklist below succeeds and a maintainer approves the GitHub Release.

## Future release checklist

1. Update `apps/cli/package.json` and `CHANGELOG.md` in a reviewed pull request.
2. Run `npm run check` from a clean checkout on a supported Node.js version.
3. Run `npm pack -w auto-repoflow` and inspect the tarball contents.
4. Install that tarball in a temporary directory and scan a separate fixture.
5. Confirm the packet contains no source root, secret value, or private
   artifact.
6. Merge the version change and create a GitHub release whose tag exactly
   matches `v<package-version>`.
7. Let `publish.yml` publish through OIDC, then verify the npm version,
   provenance, and `npx auto-repoflow@<version> --version`.

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

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

Version `0.1.1` was published through GitHub OIDC on 2026-08-03:

- npm: <https://www.npmjs.com/package/auto-repoflow/v/0.1.1>
- GitHub: <https://github.com/DarkTouiZ/auto-repoflow/releases/tag/v0.1.1>

The registry reports a SLSA provenance v1 attestation, registry signature, and
the same SHA-512 integrity value as the reviewed release-candidate tarball.

Version `0.1.2` is the current release candidate. It is prepared from the
sanitized public history so its npm provenance will point to a personal
`DarkTouiZ/auto-repoflow` source commit. Publication remains blocked on a
separate maintainer approval after the release checklist succeeds.

## One-time trusted publisher setup

Trusted publishing was configured successfully on 2026-08-03 under npm package
**Settings → Trusted Publisher**:

- provider: GitHub Actions
- organization or user: `DarkTouiZ`
- repository: `auto-repoflow`
- workflow filename: `publish.yml`
- allowed action: `npm publish`
- environment: leave empty

The workflow uses GitHub OIDC and does not require an npm write token. Version
`0.1.1` verified that the trusted-publisher configuration generates provenance
automatically.

## Version 0.1.1

- remove the filtered raw snapshot after a successful zero-config scan;
- retain the manifest, privacy decisions, hashes, and report for auditability;
- provide `--keep-snapshot` as an explicit opt-in for local inspection.

The release checklist succeeded and a maintainer approved publication on
2026-08-03.

## Version 0.1.2 release candidate

- include the privacy-safe repeated-scan benchmark runner and public evidence
  protocol already reviewed on `main`;
- issue fresh GitHub OIDC provenance anchored to the sanitized source history;
- keep the CLI behavior and Agent Fix Packet schema backward compatible with
  `0.1.1`.

This candidate must be reviewed and merged before creating tag `v0.1.2`.
Creating the GitHub Release and publishing to npm remain separate,
human-approved actions.

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
Use [BENCHMARK_PROTOCOL.md](BENCHMARK_PROTOCOL.md) to generate aggregate scan
measurements without exporting target paths, filenames, finding identities, or
source hashes.

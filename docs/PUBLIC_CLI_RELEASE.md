# Public CLI release plan

## Product promise

Auto-RepoFlow turns repository evidence into an actionable review and a
portable Agent Fix Packet. Version 0.3 can also isolate and verify one test-gap
patch from an existing IDE agent. It does not invoke that agent, push, open a
pull request, merge, deploy, or publish code.

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

Version `0.1.2` was published through GitHub OIDC on 2026-08-04:

- npm: <https://www.npmjs.com/package/auto-repoflow/v/0.1.2>
- GitHub: <https://github.com/DarkTouiZ/auto-repoflow/releases/tag/v0.1.2>
- provenance:
  <https://registry.npmjs.org/-/npm/v1/attestations/auto-repoflow@0.1.2>

The registry reports SLSA provenance anchored to the sanitized personal
`DarkTouiZ/auto-repoflow` source commit. The published package was also
verified with `npx auto-repoflow@0.1.2 --version`.

Version `0.3.0` was published through GitHub OIDC on 2026-08-06:

- npm: <https://www.npmjs.com/package/auto-repoflow/v/0.3.0>
- GitHub: <https://github.com/DarkTouiZ/auto-repoflow/releases/tag/v0.3.0>
- provenance:
  <https://registry.npmjs.org/-/npm/v1/attestations/auto-repoflow@0.3.0>

The release tag and npm SLSA provenance resolve to merge commit
`7b97bd95f0ef1e70ff489dec289b5cafd5b9df8f`. The registry `latest` tag is
`0.3.0`, and an isolated registry install returned `0.3.0`.

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

## Version 0.1.2

- include the privacy-safe repeated-scan benchmark runner and public evidence
  protocol already reviewed on `main`;
- issue fresh GitHub OIDC provenance anchored to the sanitized source history;
- keep the CLI behavior and Agent Fix Packet schema backward compatible with
  `0.1.1`.

The release checklist, maintainer approval, GitHub Release, OIDC publication,
provenance verification, and `npx` smoke test completed on 2026-08-04.

## Version 0.3.0

- deterministic MileMesh Lite replay and transparent handoff demo;
- schema-v2 policy and test-only `ChangeRun` stopping at
  `VERIFIED_LOCAL_PATCH`;
- counterbalanced assisted/unassisted outcome trial with independent
  patch-hash-bound review;
- macOS, Linux, and Windows CI on Node.js 22 and 24;
- legacy scan/report/Fix Packet compatibility.

Pull request 10 was merged with a merge commit after its final CI matrix passed
all six operating-system and Node.js jobs. The post-merge matrix also passed
all six jobs. The assisted and unassisted trial sessions were each verified
and independently accepted `2/2`, producing two complete pairs. The assisted
work-time median was `264398 ms`, the unassisted median was `225071 ms`, and
the median paired difference was `+39328 ms`.

The two-pair trial is descriptive evidence only and does not support a
statistical time-reduction claim. Replay evidence remains reproducibility
evidence, not live-AI quality. Privacy review found no protected-path change,
source egress, original-checkout mutation, or aggregate-summary privacy leak.
The release checklist, GitHub Release, OIDC publication, provenance
verification, and isolated `npx auto-repoflow@0.3.0 --version` smoke test
completed on 2026-08-06.

## Future release checklist

1. Update `apps/cli/package.json` and `CHANGELOG.md` in a reviewed pull request.
2. Run `npm run check` from a clean checkout on a supported Node.js version.
3. Run `npm pack -w auto-repoflow` and inspect the tarball contents.
4. Install that tarball in a temporary directory and run the legacy scan,
   guided demo, and ChangeRun start/verify smoke on separate fixtures.
5. Confirm the packet contains no source root, secret value, or private
   artifact.
6. Confirm the counterbalanced trial reports exact counts and paired medians,
   without a statistical time-reduction claim from two participants.
7. Merge the version change and create a GitHub release whose tag exactly
   matches `v<package-version>`.
8. Let `publish.yml` publish through OIDC, then verify the npm version,
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

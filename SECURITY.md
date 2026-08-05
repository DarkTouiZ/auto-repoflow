# Security and privacy policy

## Supported versions

The latest published minor release receives security fixes. Pre-release and
development builds are supported only while their pull request is active.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

Use GitHub's
[private vulnerability report](https://github.com/DarkTouiZ/auto-repoflow/security/advisories/new).
Do not open a public issue for a suspected vulnerability or include private
repository contents, credentials, or exploit details in public discussions.

Include the affected version, a minimal reproduction, expected impact, and any
safe mitigation you have already tested. Maintainers will acknowledge the
report through the private advisory and coordinate disclosure there.

## Product security boundary

- Never commit credentials, `.env` files, raw run artifacts, or private target
  repository contents.
- Local Git and a private GitHub repository are different trust boundaries.
- A forge upload approval never grants cloud AI-provider approval.
- Provider logs contain metadata and content hashes, not raw source context.
- Mock-provider runs are simulations and cannot create a live pull request.
- EvaluationRun stops at a Fix Packet. ChangeRun v0.3 stops at a verified local
  test patch; it cannot invoke an IDE agent, push, create a pull request, merge,
  deploy, or publish.
- Verification uses exact policy checks, `shell:false`, bounded output, and a
  sanitized environment. These controls are not an OS or network sandbox.

# Security and privacy policy

- Never commit credentials, `.env` files, raw run artifacts, or private target
  repository contents.
- Local Git and a private GitHub repository are different trust boundaries.
- A forge upload approval never grants cloud AI-provider approval.
- Provider logs contain metadata and content hashes, not raw source context.
- Mock-provider runs are simulations and cannot create a live pull request.
- The workflow stops at a draft pull request; it cannot merge or deploy.

Please report security issues privately to the repository maintainers.

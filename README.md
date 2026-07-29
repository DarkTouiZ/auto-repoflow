# Auto-RepoFlow

Auto-RepoFlow is a local-first software change control plane. It turns a
requirement into an isolated, evidence-backed change and stops after creating a
draft pull request.

This repository is a clean implementation inspired by lessons from the
SuperAI Engineer SS6 project. It does not contain company source code, private
records, internal endpoints, or proprietary schemas.

## Foundation cycle

The first cycle establishes:

- a Node.js/TypeScript npm workspace;
- NestJS API, worker, CLI, and Angular console boundaries;
- provider-neutral domain and contract packages;
- a committed Project World Contract;
- local MySQL infrastructure;
- privacy-safe defaults and an environment diagnostic.

No merge or deployment capability is part of the product.

## Local setup

Requirements: Node.js 22+, npm, Git, and Docker. Ollama and authenticated
GitHub CLI are optional during foundation development but required for their
respective live workflow stages.

```bash
cp .env.example .env
npm install
npm run doctor
npm run check
docker compose up -d mysql
```

The API binds to `127.0.0.1` by default. Secrets, run artifacts, bare mirrors,
and worktrees are excluded from Git.

## Privacy boundary

Approval to push code to a forge and approval to send context to an AI provider
are separate policies. The default provider profile is `local`; cloud context
requires a project policy and a run-specific approval.

## License

MIT © 2026 SuperAI Engineer SS6 contributors.

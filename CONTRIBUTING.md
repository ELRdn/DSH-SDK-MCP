# Contributing

## Development requirements

- Node.js `>=22.19.0` (the release checks use the pinned Node 22 line).
- pnpm `11.7.0`.
- Git for worktree and integration tests.
- A provider credential only for opt-in real smoke tests; the matching DSH
  `sdk` runtime is installed with the project.

Install keylessly from the repository root:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run typecheck
pnpm test
pnpm run package:inspect
pnpm run package:smoke
```

`package:smoke` creates a disposable tarball install. It must not depend on a
source checkout at runtime. The real OpenCode Go smoke is opt-in and requires
the caller to provide the external runtime and credential through the
environment; it is never part of keyless CI.

## Boundaries

- Preserve MCP v1 behavior, stdio stdout purity, stderr diagnostics, structured
  error classifications, redaction, bounded responses, and clean shutdown.
- Keep the public tool set at exactly the documented eight tools unless a new
  phase explicitly changes that contract.
- Do not add Phase 7 features in release-candidate maintenance. In particular,
  do not add cancellation, HTTP transport, progress streaming, nested workers,
  automatic push/PR behavior, or a v2 migration here.
- Do not claim that sandbox capability is verified. Worktree isolation is not
  a security sandbox.
- Do not commit credentials, auth files, runtime logs, session history, or
  generated temporary worktrees.

## Pull requests

Describe the user-visible behavior, affected phase boundary, tests run, and
whether a real smoke was opt-in. Keep changes scoped. Never include secret
values in commits, logs, fixtures, screenshots, or review descriptions.

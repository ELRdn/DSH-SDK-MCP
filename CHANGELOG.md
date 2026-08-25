# Changelog

## 0.6.0-rc.1 - 2026-08-25

- Added the distributable `dsh-sdk-mcp` package, executable CLI, `--version`,
  and non-secret `doctor` diagnostics.
- Preserved the pinned MCP v1 stdio lifecycle, protocol revision
  `2025-11-25`, and exactly eight public tools.
- Documented the external-runtime distribution policy and added tarball
  package auditing plus clean-install smoke coverage.
- Added release, security, contribution, compatibility, and keyless CI
  documentation.
- Kept sandbox status explicitly `inconclusive`; worktree isolation is not
  presented as a security sandbox.

## 0.5.0-phase5 - 2026-08-24

- Added read-only worktree review metadata and deterministic integration
  snapshots in a bridge-owned integration worktree.
- Added structured success, conflict, pending, and cleanup results without
  changing the user's original branch, HEAD, or index.
- Preserved bounded responses, secret redaction, lifecycle cleanup, and the
  Phase 0-4 regression suite.

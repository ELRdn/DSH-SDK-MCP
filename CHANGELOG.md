# Changelog

## 0.6.0-rc.2 - 2026-09-05

- Pin the public DSH release channel at '@deepseek-ai/dsh@0.1.2-rc.1' with
  matching client and protocol SDK packages.
- Keep pnpm's auto-installed DSH monorepo peers on the same '0.1.2-rc.1'
  release train, matching the clean npm consumer layout.
- Raise the bridge-owned DSH initialization bound to 30 seconds so cold
  Windows starts do not inherit the SDK's two-second default.
- Migrate to the DSH 0.1.2 top-level SDK launch API and official 'sdk' profile.
- Bundle the matching DSH runtime dependency while preserving the older
  explicit command/argv configuration through a shell-free compatibility
  launcher.
- Convert the shipped Cordis files into 'sdk' profile patch overlays and use
  isolated temporary 'DSH_HOME' directories for bridge-owned runtimes.
- Add Cursor configuration guidance and refresh roadmap, competition, and
  release-gate documentation.
- Verify the final fresh-installed artifact through Codex CLI 0.153.4 with
  exactly eight tools, verified health, delegate plus same-session continue,
  zero delegated tool calls, an unchanged workspace, and zero orphan
  processes.
- Publish the verified 86,009-byte artifact as `dsh-sdk-mcp@0.6.0-rc.2`, point
  npm's `next` tag to it, and configure GitHub Actions Trusted Publishing for
  subsequent releases.
- Keep the MCP v1 stdio transport and exactly eight public tools; cancellation,
  progress jobs, HTTP, and MCP v2 remain deferred.

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

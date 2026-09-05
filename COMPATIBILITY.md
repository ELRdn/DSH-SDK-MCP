# Compatibility

## Release-candidate matrix

The following is the local Windows-native verification baseline refreshed on
2026-09-05. A version in this table is a pinned dependency or an observed
validation environment; it is not a promise that every future provider or MCP
host has been tested.

| Area | Version or behavior | Evidence/status |
| --- | --- | --- |
| OS | 'Windows 11 Home', native Windows process | Verified on the release host |
| Node.js | 'v26.5.1' observed; package engine '>=22.19.0' | CLI/doctor/build path verified |
| pnpm | '11.7.0' | Frozen-lockfile install policy |
| Git | '2.55.0.windows.5' | Worktree/integration host baseline |
| Bridge package | 'dsh-sdk-mcp@0.6.0-rc.2' | Release candidate |
| DSH CLI/runtime | '@deepseek-ai/dsh@0.1.2-rc.1' | Production dependency; official 'sdk' profile |
| DSH client SDK | '@deepseek-ai/dsh-sdk-client@0.1.2-rc.1' | Production dependency |
| DSH protocol SDK | '@deepseek-ai/dsh-sdk-protocol@0.1.2-rc.1' | Production dependency |
| DSH upstream alpha | 'dsh-v0.1.3-alpha.1' | Observed 2026-09-05; follow/test only, not a supported release target |
| MCP TypeScript SDK | '@modelcontextprotocol/sdk@1.30.0' | Production dependency |
| MCP transport | 'StdioServerTransport' | Verified implementation |
| MCP protocol | '2025-11-25' | Negotiated by initialize smoke |
| MCP v2 package | '@modelcontextprotocol/server' | Not installed; migration intentionally out of scope |
| Provider profile | 'opencode-go' | Real route used by prior opt-in smoke |
| Model | 'deepseek-v4-flash' | Profile/default and prior opt-in smoke |
| Sandbox | 'inconclusive' | Never presented as a security boundary |
| Worktree isolation | Distinct linked worktree/index per worker | Filesystem/Git collision isolation only |

## MCP SDK and protocol decision

This release intentionally remains on MCP TypeScript SDK v1:

- Server imports are '@modelcontextprotocol/sdk/server/mcp.js' and
  '@modelcontextprotocol/sdk/server/stdio.js'.
- The server is built with 'McpServer' and connected with
  'new StdioServerTransport()'.
- The negotiated/supported revision used by the release checks is
  '2025-11-25'.
- 'server/discover' is not required by this v1 contract.
- The v2 split package '@modelcontextprotocol/server' and its
  'serveStdio(() => buildServer())' API are not used.

The v1 choice is deliberate compatibility debt, not an accidental package
selection. Do not migrate it as part of Phase 6 packaging.

## Host compatibility

The Phase 6.1 live host gate uses a fresh npm-pack install under a disposable
Windows temp directory, never this source checkout. Host verification requires
the host to complete the real provider-backed tool calls; shared stdio
compatibility alone is not enough.

| Host | Status | Live evidence | Blocker / note |
| --- | --- | --- | --- |
| Codex CLI 0.153.4 native host | VERIFIED | The fresh-installed 0.6.0-rc.2 artifact exposed exactly 8 tools, returned verified runtime/provider health, completed delegate and same-session continue with retained context, used zero delegated tools, left the host workspace empty, and left 0 orphans | Codex required explicit credential-variable forwarding through 'env_vars'; no credential value was stored or printed. |
| Claude Code 2.1.239 | MUST RERUN | The 0.6.0-rc.1 artifact and stdio configuration were prepared without secret emission and exited cleanly | Authentication expired before any host-side MCP call. It does not verify 0.6.0-rc.2 or DSH 0.1.2. |

The bridge's public surface is exactly:

~~~text
dsh_health
dsh_delegate
dsh_continue
dsh_status
dsh_parallel
dsh_parallel_worktree
dsh_worktree_review
dsh_integrate
~~~

Therefore the package is protocol-level compatible with both host styles that
support a local stdio server. The Codex exact-artifact path satisfies the host
gate for publishing '0.6.0-rc.2' under npm's 'next' dist-tag. Claude Code must
still complete its own rc.2 path before this project labels that host VERIFIED.

The provider-backed runtime gate is green on 2026-09-05. The source tree passed
'dsh_health', 'dsh_delegate', 'dsh_status', and 'dsh_continue' against
OpenCode Go, then shut down without an orphan. A fresh npm installation of the
packed '0.6.0-rc.2' artifact independently passed eight-tool discovery,
verified health, a non-empty delegate response, protocol-only stdout, and a
zero exit code.

## Runtime distribution

The bridge installs the exact matching DSH CLI and SDK as production
dependencies. By default the SDK launches:

~~~text
node <same-version @deepseek-ai/dsh bin> --profile sdk --patch <selected overlay>
~~~

The bridge never assumes a source checkout or npm global hoisting. Each
runtime receives an isolated temporary 'DSH_HOME'.
'DSH_MCP_RUNTIME_COMMAND/ARGS' remains a backward-compatible explicit-runtime
override, not a requirement. 'dsh-sdk-mcp doctor' reports bundled/external
mode without probing or printing provider secrets.

## DSH 0.1.2 migration boundary

DSH 0.1.2 replaces the old SDK 'launch: { command, args, cwd, env }' object
with top-level 'dshBin', 'profile', 'patches', 'dshHome', 'processCwd', and
timeout fields. This bridge uses that public API directly. Its older explicit
command/argv environment contract is retained behind an internal stdio proxy
so existing custom-runtime setups do not need an immediate rewrite.

The DSH packages are a lockstep monorepo release. pnpm may otherwise satisfy
some prerelease peer ranges with older '0.1.1-rc.2' packages, which fails at
runtime even though a clean npm install resolves correctly. This repository
pins the affected pnpm peers to '0.1.2-rc.1'; the override is development-tree
alignment, not a fork or a change to DSH's public API.

The 'react@19.2.8' override similarly keeps DSH's transitive UI/plugin peer
graph on one compatible version. The MCP bridge itself does not import React.

The former '@deepseek-ai/dsh-sdk-jsonrpc-demo' path is removed. The two files
under 'runtime/' are overlays for the official 'sdk' profile, not complete
Cordis trees. The upstream '0.1.3-alpha.1' release remains outside this RC's
support claim because npm's release channel is '0.1.2-rc.1' and DSH still
labels the project a developer preview with possible breaking changes.

## Competitive checkpoint — 2026-09-05

The closest public alternatives emphasize different products:

| Project | Strongest angle | Gap this bridge can own |
| --- | --- | --- |
| [ZSeven-W/dsh-crew](https://github.com/ZSeven-W/dsh-crew) | Native host progress UX, async jobs, cancel, multimodal bridge | Its documented DSH baseline trails 0.1.2; this bridge stays thin and host-neutral |
| [Mr-potato-123/dsh-mcp](https://github.com/Mr-potato-123/dsh-mcp) | Very small stateless delegation and MCP v2 | No persistent sessions or worktree/integration workflow |
| [cpj-dev/dsh-plugin-cc](https://github.com/cpj-dev/dsh-plugin-cc) | Rich Claude Code-specific broker workflow | Host-specific rather than generic stdio MCP |
| [tonytanglab/deepseek-harness-relay-mcp](https://github.com/tonytanglab/deepseek-harness-relay-mcp) | Durable async run control and DSH Web integration | Requires a running Web host and carries more deployment complexity |

The defensible differentiator is the combination of official SDK control,
persistent sessions, bounded parallel execution, bridge-owned Git worktrees,
and deterministic review/integration metadata in one client-agnostic stdio
package. Progress UI, async cancel, and MCP v2 are real competitor advantages;
they remain next-cycle work rather than being mixed into this compatibility RC.

## Public scope

Phase 6 packages the Phase 0-5 implementation and does not add a ninth tool.
It does not add 'dsh_cancel', MCP HTTP transport, progress streaming, nested
workers, automatic merge/conflict resolution, push/PR actions, or MCP v2.

## Release decision

The full keyless suite, package audit, fresh isolated install, real
provider-backed delegate/continue path, and Codex exact-artifact host gate are
green. '0.6.0-rc.2' is approved for npm publication under 'next', never
'latest'. This approval does not imply verified Claude Code support.

## Security boundary

Sandbox capability remains 'inconclusive'. A successful tool call, an unchanged
sentinel, a worktree path, or a clean Git status does not prove a full OS
sandbox. Worktrees separate ordinary repository working trees and indexes;
they do not prevent DSH tools from accessing other paths, processes, or
network resources. See [SECURITY.md](SECURITY.md).

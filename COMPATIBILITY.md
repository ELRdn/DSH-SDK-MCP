# Compatibility

## Release-candidate matrix

The following is the local Windows-native verification baseline observed on
2026-08-25. A version in this table is a pinned dependency or an observed
validation environment; it is not a promise that every future provider or MCP
host has been tested.

| Area | Version or behavior | Evidence/status |
| --- | --- | --- |
| OS | Windows 11 Home, native Windows process | Verified on the release host |
| Node.js | 'v26.5.1' observed; package engine '>=22.19.0' | CLI/doctor/build path verified |
| pnpm | '11.7.0' | Frozen-lockfile install policy |
| Git | '2.55.0.windows.5' | Worktree/integration host baseline |
| Bridge package | 'dsh-sdk-mcp@0.6.0-rc.1' | Release candidate |
| DSH client SDK | '@deepseek-ai/dsh-sdk-client@0.1.1-rc.2' | Production dependency |
| DSH protocol SDK | '@deepseek-ai/dsh-sdk-protocol@0.1.1-rc.2' | Production dependency |
| DSH reference runtime | '@deepseek-ai/dsh-sdk-jsonrpc-demo@0.1.1-rc.2' | External runtime; validation/dev only, not bundled |
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

Codex and Claude Code can launch local MCP servers over stdio and use the
common 'initialize', 'tools/list', and 'tools/call' lifecycle. The bridge's
public surface is exactly:

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
support a local stdio server. This repository does not claim a live
Codex-host/Claude-Code-host matrix run as part of the keyless release checks;
host configuration should still be validated in the consuming environment.

## Runtime distribution

The bridge package ships its production SDK adapter, MCP SDK, CLI, and Cordis
composition files. It does not ship the external DSH JSON-RPC runtime
executable. The caller must configure:

~~~text
DSH_MCP_RUNTIME_COMMAND = an executable path/name
DSH_MCP_RUNTIME_ARGS    = a JSON array of argv strings
~~~

The bridge never assumes a source checkout, npm global hoisting, or a dev
dependency is available. 'dsh-sdk-mcp doctor' reports command configuration
and availability without probing or printing provider secrets. The real DSH
turn requires the caller's separately managed runtime, Cordis dependencies,
provider route, and credential.

## Public scope

Phase 6 packages the Phase 0-5 implementation and does not add a ninth tool.
It does not add 'dsh_cancel', MCP HTTP transport, progress streaming, nested
workers, automatic merge/conflict resolution, push/PR actions, or MCP v2.

## Security boundary

Sandbox capability remains 'inconclusive'. A successful tool call, an unchanged
sentinel, a worktree path, or a clean Git status does not prove a full OS
sandbox. Worktrees separate ordinary repository working trees and indexes;
they do not prevent DSH tools from accessing other paths, processes, or
network resources. See [SECURITY.md](SECURITY.md).


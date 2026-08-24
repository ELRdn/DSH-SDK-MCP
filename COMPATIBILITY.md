# Compatibility

## MCP TypeScript SDK audit — Phase 5

The Phase 5 bridge intentionally remains on the v1 monolithic MCP package:

- pinned package: `@modelcontextprotocol/sdk@1.30.0`
- schema dependency: `zod@4.4.3`
- server imports: `@modelcontextprotocol/sdk/server/mcp.js` and `@modelcontextprotocol/sdk/server/stdio.js`
- serving path: `new McpServer(...)` → `server.connect(new StdioServerTransport())`
- `serveStdio(() => buildServer())` is not used
- `@modelcontextprotocol/server@2.0.0` is not installed

The installed v1 SDK declares these legacy protocol revisions:

```text
2025-11-25
2025-06-18
2025-03-26
2024-11-05
2024-10-07
```

The live Phase 1 server audit, retained by the Phase 5 implementation, negotiated:

```text
initialize response protocolVersion: 2025-11-25
server/discover: -32601 Method not found
```

Therefore this server is a legacy 2025-era MCP server, not a v2/modern `2026-07-28` server. The v2 stable line is the split package [`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server); its modern stdio entry point is `serveStdio(() => buildServer())`. Phase 5 preserves v1 because v2 migration remains explicitly out of scope.

## Host compatibility

Codex and Claude Code both support local MCP servers over stdio ([Codex MCP/stdio guidance](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code local stdio configuration](https://code.claude.com/docs/en/mcp)). This Phase 5 server uses the common legacy lifecycle and `tools/list` / `tools/call` surface for eight tools (`dsh_health`, `dsh_delegate`, `dsh_continue`, `dsh_status`, `dsh_parallel`, `dsh_parallel_worktree`, `dsh_worktree_review`, `dsh_integrate`), so it does not require v2-only `server/discover`, modern envelopes, HTTP, progress, or subscription features.

Host configuration compatibility is documented, but a live Codex-host and Claude-Code-host matrix run remains outside this Phase 5 acceptance pass. The repository's MCP client integration tests use the same pinned v1 SDK and the live server's legacy handshake. The real Phase 5 E2E uses the same stdio `tools/list` / `tools/call` contract; it does not imply a v2 host requirement.

## Scope boundary

Do not infer v2 migration or sandbox guarantees from this compatibility record. Phase 5 includes bounded review metadata and deterministic snapshot/cherry-pick operations only inside a fresh bridge-owned integration worktree; it preserves the Phase 3 disjoint-workspace and Phase 4 worktree behavior. Worktree isolation is not a security sandbox. Merge into the original checkout, automatic conflict resolution, push/PR actions, cancellation, HTTP transport, progress streaming, nested DSH orchestration, and MCP v2 migration remain out of scope. Sandbox status remains `inconclusive`, and Phase 6 has not started.

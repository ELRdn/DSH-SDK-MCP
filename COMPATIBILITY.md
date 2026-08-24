# Compatibility

## MCP TypeScript SDK audit — Phase 2

The Phase 2 bridge intentionally remains on the v1 monolithic MCP package:

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

The live Phase 1 server audit, retained by the Phase 2 implementation, negotiated:

```text
initialize response protocolVersion: 2025-11-25
server/discover: -32601 Method not found
```

Therefore this server is a legacy 2025-era MCP server, not a v2/modern `2026-07-28` server. The v2 stable line is the split package [`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server); its modern stdio entry point is `serveStdio(() => buildServer())`. Phase 2 preserves v1 because v2 migration remains explicitly out of scope.

## Host compatibility

Codex and Claude Code both support local MCP servers over stdio ([Codex MCP/stdio guidance](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code local stdio configuration](https://code.claude.com/docs/en/mcp)). This Phase 2 server uses the common legacy lifecycle and `tools/list` / `tools/call` surface for four tools (`dsh_health`, `dsh_delegate`, `dsh_continue`, `dsh_status`), so it does not require v2-only `server/discover`, modern envelopes, HTTP, progress, or subscription features.

Host configuration compatibility is documented, but a live Codex-host and Claude-Code-host matrix run remains outside this Phase 2 acceptance pass. The repository's MCP client integration tests use the same pinned v1 SDK and the live server's legacy handshake.

## Scope boundary

Do not infer v2 migration or sandbox guarantees from this compatibility record. Phase 2 includes `dsh_continue`, `RuntimePool`, `SessionRegistry`, and coarse `dsh_status`; `dsh_cancel`, parallel execution, HTTP transport, progress streaming, Git diff integration, and MCP v2 migration remain out of scope.

# DSH SDK MCP Bridge — Implementation Plan

> Working title: **dsh-sdk-mcp**
>
> Goal: expose a full DeepSeek Harness (DSH) runtime as a reusable MCP subagent for Codex, Claude Code, Cursor, and other MCP clients by driving DSH through its official SDK/JSON-RPC surface rather than through the Web UI or a one-shot headless CLI.
>
> Status: Phase 0-5 implemented; Phase 6 '0.6.0-rc.2' published on GitHub and npm
>
> Last reviewed: 2026-09-06

## Current roadmap checkpoint — 2026-09-06

| Roadmap area | Current state | Release implication |
| --- | --- | --- |
| Phase 0 — upstream compatibility | Migrated and validated against DSH/npm release channel '0.1.2-rc.1' and official 'sdk' profile | '0.1.3-alpha.1' is follow-only |
| Phase 1 — minimal bridge | Implemented | Retain 'dsh_health' and 'dsh_delegate' contract |
| Phase 2 — persistent runtime | Implemented | Persistent continue/status remains a core differentiator |
| Phase 3 — hardening | Implemented with sandbox capability still 'inconclusive' | Do not market worktrees as an OS security boundary |
| Phase 4 — client integrations | Codex exact-artifact host path verified; Claude Code, Cursor, and generic setup examples documented | Claude Code remains unverified for rc.2 |
| Phase 5 — release quality | Package, CI, audit, smoke, distribution docs, and Codex host evidence exist | Demo media remains post-RC launch work |
| Phase 6 — RC packaging | '0.6.0-rc.2' published on GitHub and npm | `next` points to the RC; npm also maps `latest` to the only published version until stable |

Immediate post-RC priorities, based on current competitors, are progress/job
visibility, an async cancellation design that matches upstream DSH semantics,
and an isolated MCP v2 migration. These are not mixed into the DSH 0.1.2
compatibility patch.

### 2026-09-05 ecosystem refresh

- [ZSeven-W/dsh-crew](https://github.com/ZSeven-W/dsh-crew) leads on native
  host progress UX, async job control, cancel, and multimodal bridging.
- [Mr-potato-123/dsh-mcp](https://github.com/Mr-potato-123/dsh-mcp) is a small
  stateless MCP v2 wrapper without this project's persistent-session and Git
  worktree/integration workflow.
- [cpj-dev/dsh-plugin-cc](https://github.com/cpj-dev/dsh-plugin-cc) remains a
  strong Claude Code-specific SDK broker.
- [tonytanglab/deepseek-harness-relay-mcp](https://github.com/tonytanglab/deepseek-harness-relay-mcp)
  leads on durable async run control through a running DSH Web host.

The current defensible position is not "first DSH MCP." It is a thin,
client-agnostic stdio package combining the official SDK, persistent sessions,
bounded parallelism, bridge-owned worktrees, and deterministic review and
integration metadata.

### 0.6.0-rc.2 release gate

- [x] Full keyless suite passes on the exact lockfile (108 total, 102 passed,
      0 failed, 6 explicit real-provider skips).
- [x] Package dry-run and package audit pass (57 files, 86,009-byte tarball).
- [x] Fresh isolated tarball install passes (8 tools, protocol-only stdout,
      clean exit).
- [x] Real DSH 0.1.2 paths pass: source-tree health/delegate/status/continue and
      fresh-tarball health/delegate, both with clean shutdown.
- [x] Codex CLI 0.153.4 completes the fresh-installed exact-artifact path:
      exactly 8 tools, verified health, delegate, same-session continue,
      zero delegated tool calls, empty host workspace, and zero orphans.
- [ ] Claude Code completes its own rc.2 path before being labeled VERIFIED.
- [x] `dsh-sdk-mcp@0.6.0-rc.2` is published; npm's `next` tag points to it and
      the registry integrity matches the verified release artifact.
- [x] Git tag/release and the GitHub Actions Trusted Publisher configuration
      are verified.

The technical decision is **PUBLISHED: '0.6.0-rc.2' on npm 'next'**. Claude
Code rc.2 verification remains post-publication compatibility work rather than
a runtime release blocker.

---

## 0. Executive Summary

Build a standalone MCP server that exposes DeepSeek Harness as a delegated coding agent.

Primary architecture:

```text
Codex / Claude Code / Cursor / MCP client
                    |
                    | MCP stdio
                    v
+-------------------------------------------+
| dsh-sdk-mcp                               |
|                                           |
|  dsh_delegate                             |
|  dsh_continue                             |
|  dsh_status                               |
|  dsh_cancel                               |
|  dsh_health                               |
|                                           |
|  RuntimePool + SessionRegistry            |
+---------------------+---------------------+
                      |
                      | official DSH TypeScript SDK
                      | stdio JSON-RPC
                      v
+-------------------------------------------+
| DeepSeek Harness runtime                  |
|                                           |
| Agent loop / tools / sandbox / sessions   |
| Cordis composition / subagents / LLM      |
+-------------------------------------------+
```

The key design decision is:

> **Use MCP only as the outer interoperability layer. Use the official DSH SDK protocol as the inner control plane.**

Do not reimplement the DSH agent loop inside the MCP server.

---

# 1. Why This Project Exists

DeepSeek Harness already supports several external surfaces, but they solve different directions of integration.

Official DSH currently includes:

- an MCP **client** plugin for consuming external MCP tools;
- ACP surfaces;
- an SDK JSON-RPC server;
- TypeScript and Python SDK clients;
- headless execution;
- Web UI APIs.

The missing ergonomic layer is a small, general-purpose MCP adapter that lets any MCP-capable parent agent treat a full DSH runtime as a subagent.

Desired UX:

```text
Parent agent:
"Delegate repository exploration to DSH."

MCP call:
dsh_delegate({
  task: "Inspect the repository and identify why the tests fail.",
  cwd: "C:\\work\\project",
  mode: "read-only"
})

DSH:
- opens the workspace
- reasons independently
- uses its own tools
- reports the result

Parent:
- reviews the output
- optionally checks the diff
- continues with its own higher-level reasoning
```

This lets an expensive/strong parent agent remain the architect and reviewer while DSH handles isolated worker tasks.

---

# 2. Public Ecosystem Check — Important Positioning

Do **not** market this as "the first DSH MCP server" or "the first way to use DSH as a subagent."

As of 2026-08-22, public projects already cover adjacent territory.

## 2.1 Known adjacent projects

### `jeremy9682/dsh-cursor-codex`

Approach:

```text
MCP
 -> dsh_delegate
 -> DSH headless CLI
```

It exposes a zero-dependency stdio MCP server and runs a fresh headless DSH task.

Difference from this project:

- CLI-driven rather than SDK-native;
- essentially one-shot delegation;
- no SDK-runtime pooling as the main architecture.

### `Seann0824/deepseek-harness-for-codex`

Approach:

```text
Codex
 -> MCP
 -> local DSH Web service
 -> DSH Web API
```

It creates/reuses visible DSH Web sessions and lets Codex track them.

Difference from this project:

- Codex-oriented workflow;
- Web service/API is the control plane;
- requires the DSH Web surface;
- our target is standalone, client-agnostic, stdio-first SDK control.

### `cpj-dev/dsh-plugin-cc`

Approach:

```text
Claude Code plugin / slash commands
 -> broker
 -> DSH SDK JSON-RPC server
```

It supports review, critique, delegation, background runs, and resumable sessions.

Difference from this project:

- Claude Code plugin UX rather than a minimal universal MCP server;
- SDK JSON-RPC is used, so this is the closest conceptual relative;
- our differentiator must be **generic MCP interoperability**, small surface area, and host independence.

### `huey1in/reef`

Approach:

```text
MCP Streamable HTTP
 -> DSH Web plugin
 -> DSH sessions / agent
```

It exposes DSH sessions and `dsh_run_agent` to MCP clients.

Difference from this project:

- installed inside the DSH Web profile;
- HTTP/OAuth oriented;
- bundled with several other modules;
- our project should remain a standalone stdio MCP adapter centered on the SDK runtime.

## 2.2 Safe GitHub claim

Good:

> An SDK-native, client-agnostic MCP bridge for using DeepSeek Harness as a delegated coding agent.

Also good:

> Drives a full DSH runtime through the official SDK JSON-RPC protocol — no Web UI required.

Potentially good after implementation verification:

> A lightweight stdio MCP server built directly on the official DSH TypeScript SDK.

Avoid:

- "world's first DSH MCP"
- "first ever DSH subagent"
- "official DSH MCP server"
- any implication of affiliation with DeepSeek

A search did not reveal an exact public match for **standalone + stdio MCP + host-agnostic + official DSH TypeScript SDK as the primary control plane**, but absence cannot be proven globally.

---

# 3. Project Identity

Working repository name:

```text
dsh-sdk-mcp
```

Alternative names:

```text
dsh-agent-mcp
dsh-subagent-mcp
dsh-mcp-bridge
harness-mcp
```

Preferred:

```text
dsh-sdk-mcp
```

Reason:

- describes the implementation rather than pretending to be official;
- makes the SDK-native distinction obvious;
- searchable;
- short.

Before publishing, verify GitHub and npm name availability.

Suggested one-line description:

> MCP server that exposes DeepSeek Harness as an SDK-driven coding subagent for Codex, Claude Code, Cursor, and other MCP clients.

---

# 4. Architecture Decision

## 4.1 Primary implementation language: TypeScript

Use TypeScript first.

Reasons:

1. MCP clients are commonly Node-friendly.
2. DeepSeek Harness has an official TypeScript SDK client:
   `@deepseek-ai/dsh-sdk-client`.
3. The SDK drives a full DSH runtime over stdio JSON-RPC.
4. It avoids making Python a mandatory bridge layer.
5. It gives the best chance of native Windows support.
6. The user's existing DSH install is already Node/npm based.

Do not make the Python SDK the default implementation.

The Python SDK remains useful as:

- a fallback adapter;
- a reference implementation;
- Linux/macOS validation;
- future alternative package.

## 4.2 Outer protocol

Default:

```text
MCP stdio
```

Reasons:

- ideal for local Codex / Claude Code / Cursor integration;
- no port management;
- no authentication server needed for local MVP;
- child process lifetime maps naturally to the parent MCP client.

Possible later addition:

```text
MCP Streamable HTTP
```

Do not implement HTTP in MVP.

## 4.3 Inner protocol

Use:

```text
@deepseek-ai/dsh-sdk-client
        |
        v
DSH SDK runtime
        |
        v
newline-delimited JSON-RPC over stdio
```

The official TypeScript SDK is explicitly designed to spawn a complete Harness runtime and drive turns over JSON-RPC.

Do not:

- scrape the Web UI;
- fake keyboard input;
- parse terminal UI output;
- duplicate DSH session internals;
- directly call the model API and call it "DSH."

---

# 5. Runtime Strategy

Important: the TypeScript SDK client does not magically define the complete runtime composition.

The runtime side must:

1. launch a DSH JSON-RPC-capable process;
2. include `@deepseek-ai/dsh-sdk-jsonrpc-server`;
3. receive an explicit `cordis.yml`;
4. expose the provider/model route the MCP bridge requests.

The current official upstream path uses the same-version `@deepseek-ai/dsh`
CLI with `--profile sdk`; the older `dsh-jsonrpc-agent` /
`@deepseek-ai/dsh-sdk-jsonrpc-demo` path is obsolete for DSH 0.1.2.

## P0 requirement

Before designing abstractions, prove this minimal chain on the target Windows machine:

```text
Node script
 -> @deepseek-ai/dsh-sdk-client
 -> DSH JSON-RPC runtime
 -> one agent turn
 -> finalResponse
```

If the official npm runtime path for the pinned DSH release works on Windows, use it.

If it does not, support an explicit runtime launch configuration:

```text
DSH_RUNTIME_COMMAND
DSH_RUNTIME_ARGS
DSH_CORDIS_CONFIG
```

Example conceptual configuration:

```json
{
  "command": "node",
  "args": [
    "path/to/dsh-jsonrpc-agent/bin.js",
    "path/to/cordis.yml"
  ]
}
```

Do not hard-code a source-checkout path in production.

---

# 6. Version Policy

DeepSeek Harness is currently in developer preview and explicitly warns about compatibility-breaking changes.

Therefore:

## MVP

Pin exact compatible versions.

Example policy:

```text
@deepseek-ai/dsh-sdk-client = exact tested version
@deepseek-ai/dsh-sdk-protocol = matching version
runtime/server packages = same DSH release line
MCP SDK = exact tested version
```

Do not use loose `latest` ranges for the core DSH stack.

Maintain:

```text
docs/COMPATIBILITY.md
```

Suggested table:

| dsh-sdk-mcp | DSH | SDK client | MCP SDK | Node | Status |
|---|---|---|---|---|---|
| 0.1.x | 0.1.0-rc.6 | matching | tested version | >=22.19 | verified |

Add an automated compatibility smoke test before upgrading DSH.

---

# 7. Proposed Repository Layout

```text
dsh-sdk-mcp/
├─ src/
│  ├─ index.ts
│  ├─ server.ts
│  │
│  ├─ tools/
│  │  ├─ delegate.ts
│  │  ├─ continue.ts
│  │  ├─ cancel.ts
│  │  ├─ status.ts
│  │  └─ health.ts
│  │
│  ├─ dsh/
│  │  ├─ runtime-pool.ts
│  │  ├─ runtime-factory.ts
│  │  ├─ session-registry.ts
│  │  ├─ notifications.ts
│  │  ├─ errors.ts
│  │  └─ types.ts
│  │
│  ├─ security/
│  │  ├─ workspace-policy.ts
│  │  ├─ path-normalize.ts
│  │  └─ modes.ts
│  │
│  └─ config/
│     ├─ env.ts
│     └─ schema.ts
│
├─ runtime/
│  ├─ cordis.yml
│  └─ README.md
│
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ fixtures/
│  └─ fake-runtime/
│
├─ examples/
│  ├─ claude-code.json
│  ├─ codex.toml
│  └─ cursor.json
│
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ SECURITY.md
│  ├─ COMPATIBILITY.md
│  └─ TROUBLESHOOTING.md
│
├─ package.json
├─ tsconfig.json
├─ LICENSE
├─ README.md
└─ IMPLEMENTATION_PLAN.md
```

---

# 8. MCP Tool Contract

Keep the public tool surface small.

## 8.1 `dsh_delegate`

Creates a new delegated DSH session.

Input:

```ts
type DshDelegateInput = {
  task: string
  cwd: string

  mode?: "read-only" | "workspace-write"

  provider?: string
  model?: string

  maxTokens?: number
  timeoutMs?: number

  sessionId?: string
}
```

Output:

```ts
type DshRunResult = {
  ok: boolean
  sessionId: string
  status: "completed" | "max-tokens" | "error" | "cancelled" | "unknown"
  finalResponse: string

  cwd: string
  durationMs: number

  changedFiles?: string[]
  error?: {
    code: string
    message: string
  }
}
```

Notes:

- `cwd` MUST be absolute after normalization.
- new sessions should receive generated stable IDs when omitted.
- never accept secrets in `task`.
- return structured data, not only prose.

## 8.2 `dsh_continue`

Continues an existing DSH session.

Input:

```ts
{
  sessionId: string
  task: string
}
```

The registry must know which runtime owns the session.

If the runtime was evicted, either:

1. restore/recreate against persisted DSH session storage when officially supported and verified; or
2. fail clearly with `SESSION_NOT_ACTIVE`.

Do not silently pretend continuity occurred.

## 8.3 `dsh_status`

Return:

```ts
{
  sessionId: string
  state: "idle" | "running" | "closed" | "missing"
  cwd?: string
  provider?: string
  model?: string
  startedAt?: string
  lastActivityAt?: string
}
```

## 8.4 `dsh_cancel`

Cancel an active delegated task if the chosen SDK/runtime path exposes safe cancellation.

If the current SDK high-level API does not expose cancellation directly:

- investigate the lower-level client/protocol;
- do not simulate successful cancellation;
- as a fallback, terminate the owned runtime only when the consequence is explicit.

MVP may omit this tool until cancellation semantics are verified.

## 8.5 `dsh_health`

Return diagnostics:

```ts
{
  ok: boolean
  bridgeVersion: string
  nodeVersion: string
  platform: string
  dshSdkVersion?: string
  runtimeConfigured: boolean
  runtimeReachable?: boolean
  sessionCount: number
}
```

Never return secrets.

---

# 9. Runtime Pool

Do NOT create and destroy a DSH runtime for every tool call once MVP correctness is proven.

Implement:

```text
RuntimePool
```

Concept:

```ts
type RuntimeKey = {
  cwd: string
  provider: string
  model: string
  mode: SecurityMode
}
```

Possible policy:

```text
max runtimes: 3
idle TTL: 10 minutes
per-runtime concurrency: 1 active root turn initially
```

Why:

- the official SDK keeps its runtime process for reuse;
- startup cost is avoided;
- multi-turn continuation becomes natural;
- session state remains attached to the runtime.

MVP implementation may start with a single runtime to simplify correctness.

Then graduate to a keyed pool.

---

# 10. Concurrency Policy

Start conservative.

## v0.1

```text
one active turn per runtime
```

Queue or reject a second turn targeting the same runtime/session.

Do not permit two concurrent prompts to mutate the same workspace through the same DSH session until upstream semantics are verified.

## v0.2

Allow parallel runtimes for independent jobs:

```text
parent
├─ DSH runtime A -> task A
├─ DSH runtime B -> task B
└─ DSH runtime C -> task C
```

Apply a configurable cap:

```text
DSH_MCP_MAX_RUNTIMES=3
```

---

# 11. Workspace Security

This is mandatory for a public repository.

## 11.1 Absolute paths

Reject relative `cwd`.

Normalize:

- Windows drive paths;
- separators;
- `..`;
- symlink/junction resolution where possible.

## 11.2 Allowed roots

Support:

```text
DSH_MCP_WORKSPACE_ROOTS
```

Example:

```text
C:\Users\name\Documents\VibeCoding
D:\Projects
```

A requested workspace must resolve inside an allowed root.

Default options:

### Local-development default

No root restriction, with a visible warning.

### Safer default for published package

Require either:

- explicit workspace roots; or
- a deliberate `--allow-any-workspace` flag.

Prefer the safer option for public release.

## 11.3 Modes

Expose at least:

```text
read-only
workspace-write
```

Do not promise OS-level sandboxing unless it is actually implemented.

The MCP layer should map the selected mode into the verified DSH permission/sandbox configuration.

If DSH permission semantics cannot be changed safely per run, use separate runtimes/compositions per mode.

## 11.4 No shell interpolation

Spawn processes with argv arrays.

Never build:

```ts
exec(`some-command ${userInput}`)
```

Use `spawn(command, args, ...)`.

---

# 12. Credentials

The MCP server must never require API keys as tool arguments.

Bad:

```text
dsh_delegate(task, cwd, apiKey)
```

Good:

```text
environment / DSH credential store / provider config
```

Rules:

- never log credential values;
- never include credentials in MCP responses;
- redact known secret-shaped environment values in diagnostics;
- `.env` must be gitignored;
- publish `.env.example` with names only.

Potential provider variables:

```text
DEEPSEEK_API_KEY
DEEPSEEK_BASE_URL
```

For alternative DSH routes, rely on the user's `cordis.yml` / environment rather than hard-coding one vendor.

---

# 13. Model Routing

Do not make the package "MiMo-only."

The MCP contract should be provider/model generic:

```ts
provider?: string
model?: string
```

Defaults come from server config:

```text
DSH_MCP_DEFAULT_PROVIDER
DSH_MCP_DEFAULT_MODEL
```

This lets a user configure:

```text
OpenCode Go / MiMo
DeepSeek
local endpoint
OpenAI-compatible proxy
other DSH-supported routes
```

The project should not own authentication logic for every provider.

It should pass the route to DSH.

---

# 14. Notification and Progress Mapping

The DSH SDK protocol exposes notifications/events.

Use them.

Potential mapping:

```text
DSH session event
 -> internal EventEmitter
 -> MCP progress/log notification where supported
```

MVP:

- collect notifications internally;
- return only final structured result;
- log progress to stderr, never stdout.

Important for stdio MCP:

```text
stdout = MCP protocol only
stderr = diagnostics
```

Never write arbitrary logs to stdout.

v0.2:

- map token/tool/subagent lifecycle events into MCP progress notifications if the installed MCP SDK and protocol revision support it cleanly.

Potential events:

```text
session.status
session.event
subagent.started
subagent.finished
```

---

# 15. Error Model

Create stable bridge-level error codes.

Suggested:

```text
INVALID_ARGUMENT
INVALID_WORKSPACE
WORKSPACE_NOT_ALLOWED
RUNTIME_NOT_CONFIGURED
RUNTIME_START_FAILED
RUNTIME_PROTOCOL_ERROR
DSH_INITIALIZE_FAILED
SESSION_NOT_FOUND
SESSION_BUSY
RUN_TIMEOUT
RUN_CANCELLED
DSH_TURN_FAILED
INTERNAL_ERROR
```

Never leak giant raw stack traces through the normal MCP tool result.

Provide a debug mode:

```text
DSH_MCP_DEBUG=1
```

Debug details go to stderr.

---

# 16. Test Strategy

This project needs strong tests because it manages two nested protocols:

```text
MCP
  |
bridge
  |
DSH SDK JSON-RPC
```

## Tier 1 — Unit tests

No model/API key.

Test:

- path normalization;
- allowed root enforcement;
- config parsing;
- runtime key generation;
- registry lifecycle;
- error conversion;
- output serialization.

## Tier 2 — Fake DSH runtime

Create a tiny scripted child process that speaks the subset of DSH SDK JSON-RPC needed by the SDK.

Test:

- initialize;
- run success;
- error response;
- malformed output;
- child exit;
- timeout;
- multi-turn session;
- notifications;
- cleanup.

## Tier 3 — MCP integration

Start the actual MCP server over stdio and call it using an MCP test client.

Verify:

```text
tools/list
tools/call -> dsh_health
tools/call -> dsh_delegate
```

Use the fake DSH runtime so CI needs no API key.

## Tier 4 — Real DSH smoke test

Opt-in only.

Environment:

```text
DSH_MCP_REAL_SMOKE=1
```

Requires a configured compatible provider.

Run against a disposable temp git repository.

Task:

```text
Read README.md and report its first heading.
Do not modify files.
```

Then a workspace-write test:

```text
Create hello.txt containing exactly hello.
```

Verify actual filesystem state.

Never run the real smoke test automatically on untrusted PRs with repository secrets.

---

# 17. Git Verification

The parent agent should verify DSH's work.

The bridge MAY provide changed-file metadata, but should not pretend the worker's narration is proof.

Recommended sequence:

```text
git status before
        |
DSH task
        |
git status / diff after
        |
parent agent review
```

A future `includeGitDiffSummary` option may return:

```ts
{
  changedFiles: [...],
  diffStat: "..."
}
```

Avoid returning unrestricted giant diffs through the MCP result by default.

---

# 18. MVP Phases

## Phase 0 — Upstream compatibility spike

Success criteria:

- [ ] exact DSH version pinned;
- [ ] official `@deepseek-ai/dsh-sdk-client` import works;
- [ ] JSON-RPC runtime launches on Windows;
- [ ] `DeepSeekHarness` or equivalent high-level API completes one turn;
- [ ] a second turn can reuse the same runtime/session;
- [ ] stdout/stderr behavior understood;
- [ ] runtime closes without orphan process.

Stop and document any upstream incompatibility before building MCP.

## Phase 1 — Minimal MCP bridge

Implement only:

```text
dsh_health
dsh_delegate
```

Success:

- [ ] MCP Inspector/test client sees both tools;
- [ ] `dsh_delegate` runs a real DSH turn;
- [ ] absolute workspace validation;
- [ ] clean shutdown;
- [ ] no arbitrary stdout logging;
- [ ] Windows works.

## Phase 2 — Persistent runtime

Add:

```text
RuntimePool
SessionRegistry
dsh_continue
dsh_status
```

Success:

- [ ] same session continues;
- [ ] idle runtime cleanup;
- [ ] no duplicate ownership;
- [ ] no orphaned runtimes.

## Phase 3 — Security hardening

Add:

```text
workspace roots
read-only / workspace-write modes
environment redaction
timeouts
resource caps
```

Success:

- [ ] traversal tests;
- [ ] junction/symlink escape tests where practical;
- [ ] secrets absent from logs;
- [ ] child spawning uses argv, not shell interpolation.

## Phase 4 — Client integrations

Ship tested examples for:

```text
Codex
Claude Code
Cursor
generic MCP client
```

The core package must remain client-agnostic.

## Phase 5 — Release quality

- [x] README
- [x] LICENSE
- [x] SECURITY.md
- [x] COMPATIBILITY.md
- [x] CONTRIBUTING.md
- [x] CHANGELOG.md
- [x] npm packaging
- [x] CI matrix
- [x] smoke-test docs
- [ ] demo GIF/video
- [ ] architecture diagram

---

# 19. Codex Implementation Rules

Codex should follow these rules while implementing.

1. **Read upstream DSH SDK source/docs before inventing APIs.**
2. **Do not guess package exports.**
3. Pin the exact DSH version used during implementation.
4. Prefer the official TypeScript SDK client.
5. Treat `@deepseek-ai/dsh-sdk-jsonrpc-server` as the official runtime serving surface.
6. Keep the MCP adapter thin.
7. Do not depend on the DSH Web UI for core functionality.
8. Do not make headless CLI parsing the primary backend.
9. Do not hide process failures.
10. Never print logs to stdout in stdio MCP mode.
11. Never accept secrets as MCP tool parameters.
12. Reject invalid/unapproved workspace paths before starting DSH.
13. Verify cleanup on normal exit, error, and Ctrl+C.
14. Write keyless tests before real-provider tests.
15. Do not claim cancellation/session restoration until verified against the pinned SDK.
16. Keep provider/model generic.
17. Document every upstream compatibility assumption in `docs/COMPATIBILITY.md`.
18. Preserve a small public MCP API even if the internal implementation grows.
19. Favor structured outputs.
20. Before release, compare behavior against known projects rather than copying their marketing claims.

---

# 20. Suggested `package.json` Direction

Exact versions MUST be resolved and pinned during Phase 0.

Conceptual dependencies:

```json
{
  "name": "dsh-sdk-mcp",
  "type": "module",
  "bin": {
    "dsh-sdk-mcp": "./dist/index.js"
  },
  "engines": {
    "node": ">=22.19"
  },
  "dependencies": {
    "@deepseek-ai/dsh-sdk-client": "<PIN>",
    "@modelcontextprotocol/sdk": "<PIN>",
    "zod": "<PIN>"
  }
}
```

If the official MCP JavaScript SDK package name/API differs at implementation time, use its current documented package.

Do not copy old examples blindly: MCP SDK APIs evolve.

---

# 21. Suggested CLI

```text
dsh-sdk-mcp
dsh-sdk-mcp doctor
dsh-sdk-mcp --version
```

Optional later:

```text
dsh-sdk-mcp config
```

`doctor` should verify:

```text
Node version
SDK package
runtime command
cordis config
workspace roots
provider/model defaults
credential presence (boolean only)
```

Output:

```text
✓ Node 22.x
✓ DSH SDK client loaded
✓ runtime configured
✓ cordis config found
✓ workspace roots configured
✓ provider credential detected
```

Never print actual secret values.

---

# 22. Configuration

Suggested environment interface:

```text
DSH_MCP_RUNTIME_COMMAND
DSH_MCP_RUNTIME_ARGS
DSH_MCP_CORDIS_CONFIG

DSH_MCP_SESSION_ROOT

DSH_MCP_DEFAULT_PROVIDER
DSH_MCP_DEFAULT_MODEL

DSH_MCP_WORKSPACE_ROOTS
DSH_MCP_DEFAULT_MODE

DSH_MCP_MAX_RUNTIMES
DSH_MCP_IDLE_TTL_MS

DSH_MCP_DEBUG
```

For complex config, add later:

```text
~/.config/dsh-sdk-mcp/config.json
```

Do not require it for MVP.

---

# 23. Client Configuration Examples

These are placeholders. Verify against the current client versions before publishing.

## Codex

Concept:

```toml
[mcp_servers.dsh]
command = "dsh-sdk-mcp"
```

## Claude Code

Concept:

```text
claude mcp add dsh -- dsh-sdk-mcp
```

## Generic JSON-style client

Concept:

```json
{
  "mcpServers": {
    "dsh": {
      "command": "dsh-sdk-mcp"
    }
  }
}
```

The project should not need different internal logic for each host.

---

# 24. README Demo

Ideal demo:

```text
User -> Codex:
Use DSH to inspect this repository for the cause of the failing tests.
Do not let DSH modify files.

Codex -> dsh_delegate:
{
  task: "...",
  cwd: "C:\\Projects\\demo",
  mode: "read-only"
}

DSH:
[works independently]

Result:
{
  sessionId: "...",
  finalResponse: "...",
  status: "completed"
}

Codex:
independently verifies the relevant files/tests
```

Second demo:

```text
User:
Have DSH fix the isolated parser bug, then review its diff yourself.
```

This communicates the parent/worker model immediately.

---

# 25. Competitive Differentiation

The README should include a calm comparison, not an attack.

| Project style | Control plane | Host-specific | Web UI required | Session reuse | Goal |
|---|---|---:|---:|---:|---|
| Headless MCP wrappers | CLI | usually no | no | limited | simple delegation |
| DSH Web MCP wrappers | Web API | varies | yes | yes | visible Web sessions |
| Claude-specific bridge | SDK/broker | yes | no | yes | Claude workflows |
| **dsh-sdk-mcp** | **official SDK JSON-RPC** | **no** | **no** | **yes** | **universal MCP subagent** |

Do not name competitors in the comparison table unless the claims are rechecked immediately before publication.

---

# 26. Release Strategy

## v0.1.0

Scope:

```text
stdio only
Windows + Linux target if verified
one provider/model route configuration
dsh_health
dsh_delegate
workspace policy
keyless CI
real smoke test script
```

## v0.2.0

```text
runtime pool
session continuation
status
progress notifications
multiple provider/model routes
```

## v0.3.0

```text
parallel delegation
cancel
Git metadata
stronger sandbox integration
Streamable HTTP optional transport
```

---

# 27. GitHub Launch Checklist

Before public release:

- [x] repository name checked;
- [x] npm name checked;
- [x] no `.env`;
- [x] no API key in git history;
- [x] exact DSH compatibility documented;
- [x] tested on Windows;
- [ ] tested on one Linux environment if possible;
- [x] `npm pack --dry-run` inspected;
- [x] fresh-machine install tested;
- [x] Codex integration tested;
- [ ] Claude Code integration tested;
- [ ] screenshot/GIF recorded;
- [ ] concise architecture diagram in README;
- [x] MIT/Apache license decision made;
- [x] upstream DeepSeek Harness credited;
- [x] no "official" branding;
- [x] no unsupported "world first" claim.

Good launch sentence:

> I built a tiny MCP bridge that lets Codex, Claude Code, and other MCP clients delegate work to a full DeepSeek Harness runtime through DSH's SDK JSON-RPC interface.

That is both impressive and defensible.

---

# 28. Definition of Done

The project is successful when this works from a fresh host installation:

```text
1. Install dsh-sdk-mcp.
2. Configure a DSH-compatible runtime/provider.
3. Add `dsh-sdk-mcp` as a stdio MCP server.
4. Open Codex or Claude Code.
5. Ask the parent agent to delegate an isolated task.
6. Parent calls `dsh_delegate`.
7. A real full DSH runtime performs the work.
8. MCP receives a structured final result.
9. The parent can continue the DSH session.
10. The parent independently reviews the result.
11. Closing the MCP client leaves no orphaned DSH process.
```

No Web UI should be required for the core path.

---

# 29. Research References

Upstream / ecosystem references checked while writing this plan:

- DeepSeek Harness official repository  
  https://github.com/deepseek-ai/deepseek-harness

- Official DSH MCP client plugin  
  https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/mcp/mcp-client

- Official DSH SDK group  
  https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk

- Official TypeScript SDK client  
  https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk/client

- Official SDK JSON-RPC server  
  https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk/server

- Official Python SDK documentation  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.md

- DSH SDK subagent backend  
  https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-dsh-sdk

Adjacent community projects:

- https://github.com/jeremy9682/dsh-cursor-codex
- https://github.com/Seann0824/deepseek-harness-for-codex
- https://github.com/cpj-dev/dsh-plugin-cc
- https://github.com/huey1in/reef

---

# 30. Final Engineering Principle

Keep this repository boring in the best possible way.

```text
MCP compatibility
      +
DSH SDK compatibility
      +
runtime lifecycle
      +
security boundaries
```

Those four things are the product.

Do not turn the bridge into another agent framework.

DeepSeek Harness is already the agent framework.

**dsh-sdk-mcp should be the clean adapter that lets every MCP host use it.**

# dsh-sdk-mcp — Phase 5 Review & Integration Gate

This repository contains the Phase 0 compatibility spike, the hardened Phase 1 MCP stdio bridge, the Phase 2 persistent subagent layer, the Phase 3 parallel-worker layer, the Phase 4 Git-worktree layer, and the narrowly scoped Phase 5 review/integration gate.

Phase 5 exposes exactly eight tools:

- `dsh_health`
- `dsh_delegate`
- `dsh_continue`
- `dsh_status`
- `dsh_parallel`
- `dsh_parallel_worktree`
- `dsh_worktree_review`
- `dsh_integrate`

The bridge drives the existing official DSH TypeScript SDK/runtime path. It does not reimplement the DSH agent loop.

Phase 1.1 hardening, Phase 2 lifecycle guarantees, and Phase 3's bounded semaphore remain mandatory. Phase 5 preserves the Phase 4 worktree workflow: each worker gets a bridge-owned Git worktree, its own SDK runtime/session, and its own Git index/working tree.

The MCP package/protocol decision is recorded in [COMPATIBILITY.md](COMPATIBILITY.md). Phase 5 intentionally preserves the pinned v1 legacy stdio path and does not migrate to the v2 `serveStdio` API.

The spike validates:

- TypeScript → `@deepseek-ai/dsh-sdk-client`
- explicit external DSH runtime launch via `command`/`args`
- stdio JSON-RPC protocol behavior
- one real filesystem-tool read
- same-runtime two-turn reuse
- one-active-root-run concurrency protection
- bounded parallel workers with same-workspace rejection
- same-repository workers with distinct Git worktrees and generated branches
- Windows read-only filesystem and PowerShell probes
- runtime stdout purity, bounded stderr diagnostics, and cleanup

## Install

Use native Windows Node.js `>=22.19.0` for the required Windows gate.

```powershell
npx --yes pnpm@11.7.0 install --frozen-lockfile --ignore-scripts
```

`--ignore-scripts` is intentional: unrelated transitive build hooks are not approved; pnpm lockfile and supply-chain policy checks remain enabled.

The SDK never discovers or bundles a runtime. The reference/demo runtime and the Cordis composition are separate launch dependencies. You may either install a compatible runtime externally or use the pinned `@deepseek-ai/dsh-sdk-jsonrpc-demo` package included for this disposable Phase 0 spike.

The Windows launch must use an executable plus an argv array. Do not use shell interpolation or pass a .cmd wrapper as the SDK command. The runner supports two explicit Phase 0 profiles:

- `deepseek-official` / `deepseek-v4-flash` -> `DEEPSEEK_API_KEY`
- `opencode-go` / `deepseek-v4-flash` -> `OPENCODE_API_KEY`

The OpenCode Go catalog profile is the recommended real-smoke route when the DeepSeek official account is quota-blocked:

```powershell
$runtimeEntry = (Resolve-Path .\node_modules\@deepseek-ai\dsh-sdk-jsonrpc-demo\lib\bin.js).Path.Replace('\', '/')
$env:DSH_MCP_RUNTIME_COMMAND = "node"
$env:DSH_MCP_RUNTIME_ARGS = '["' + $runtimeEntry + '"]'
$env:DSH_MCP_PROFILE = "opencode-go"
$env:DSH_MCP_PROVIDER = "opencode-go"
$env:DSH_MCP_MODEL = "deepseek-v4-flash"
# Supply OPENCODE_API_KEY through the existing secure environment or DSH credentials service.
```

The profile selects `runtime/phase0.opencode-go.cordis.yml` unless `DSH_MCP_CORDIS_CONFIG` is explicitly set. The Cordis composition references `OPENCODE_API_KEY` by name only; no secret value belongs in this repository or in reports.

`runtime/phase0.cordis.yml` remains the DeepSeek official composition. Its QUOTA result is retained as provider-reachable/quota-blocked diagnostic evidence.

For a native Windows shell with the pinned reference entrypoint, after the dependencies are available:

```cmd
scripts\phase0-native.cmd
```

The helper requires the credential referenced by the selected profile and does not print secret values.

## Run

```powershell
npx --yes pnpm@11.7.0 run typecheck
npx --yes pnpm@11.7.0 test
npx --yes pnpm@11.7.0 run phase0
npx --yes pnpm@11.7.0 run mcp
```

The MCP server writes protocol frames to stdout only. Diagnostics go to stderr. Configure the same runtime environment used by the Phase 0 smoke before starting `mcp`.

`dsh_delegate` accepts only a task and an absolute existing `cwd`. It creates a new logical session, reuses an SDK-owned runtime for later turns, rejects a concurrent root delegation with `RUNTIME_BUSY`, and leaves an idle runtime available until its TTL. `dsh_continue` requires the returned stable `sessionId` and sends the next prompt through the same `DeepSeekHarness` session; it never fakes continuity after the runtime expires or dies. `dsh_status` reports only `running`, `idle`, `expired`, or `missing`. DSH turn classifications such as `QUOTA`, `MISSING_CREDENTIAL`, and `RATE_LIMITED` are returned as structured MCP tool errors; typed SDK failures distinguish `DSH_INITIALIZE_FAILED`, `DSH_RPC_ERROR`, and an initialized runtime that later dies as `RUNTIME_DIED`. Runtime request timeout is bounded to 15 minutes by default and can be overridden with `DSH_MCP_RUNTIME_REQUEST_TIMEOUT_MS`; the health provider probe is independently capped at 30 seconds.

`dsh_health` distinguishes configuration from verified readiness: `runtimeConfigured`/`providerConfigured` report configuration presence; `runtimeReady` becomes verified after the runtime initialize probe, while `providerReady` becomes verified only after an exact `DSH_MCP_HEALTH_OK` provider turn. A provider quota/timeout can therefore leave `runtimeReady: true` and `providerReady: false`. Credential values are never included in health, tool text, structured content, or stderr-derived diagnostics. The empty `arguments` object may be omitted by MCP clients.

`dsh_delegate` bounds the returned `finalResponse` to 100,000 characters. `finalResponseLength` reports the sanitized pre-truncation length and `finalResponseTruncated` reports whether truncation occurred.

`dsh_parallel` accepts up to eight independent tasks. The default concurrency cap is three and `DSH_MCP_MAX_PARALLEL` can lower or raise it up to the hard maximum of eight. Workers must target disjoint canonical workspaces; absolute-path normalization, Windows case folding, and `realpath` resolution are used before a batch starts. A shared workspace rejects the whole batch with `SHARED_WORKSPACE`. Individual worker failures remain in input order and do not cancel siblings. Successful worker sessions can be continued with `dsh_continue`.

The aggregate parallel result is bounded to 300,000 serialized characters. Individual `finalResponseLength` values remain the pre-aggregate-bound lengths, while `finalResponseTruncated` and `aggregateResponseTruncated` describe truncation.

`dsh_parallel_worktree` requires an absolute Git working-tree path and an optional base ref. It validates the Git root/common directory, records `baseRef` and `baseCommit`, creates one generated branch (`dsh-mcp/dsh-wt-*`) and one bridge-owned temporary worktree per task, then runs the existing bounded worker path. Git status and changed-file metadata are collected from Git after execution; model narration is not trusted as Git evidence. The original working tree and branch are not used as worker workspaces.

Bridge-owned worktrees live below a collision-resistant temporary root. Clean worktrees become cleanup-eligible when their runtime/session closes; dirty worktrees are preserved for parent review. A worktree is filesystem/Git-index isolation only, not a security sandbox.

`dsh_worktree_review` accepts exactly one worker `sessionId` or `worktreeId` and derives repository identity, base/current commit, dirty state, staged/unstaged/untracked counts, changed files, bounded diff statistics, status text, and conflict-marker metadata from Git. It does not trust worker narration. `dsh_integrate` accepts an absolute repository and worker session IDs in deterministic input order. It creates a fresh bridge-owned integration worktree from the verified base commit, creates bounded Git-native snapshots with a temporary index, and cherry-picks those snapshots only inside that integration worktree. It never changes the original branch, HEAD, or index.

The complete `dsh_integrate` structured result is bounded to 300,000 serialized characters. `responseLength` reports the sanitized pre-truncation size and `responseTruncated` reports whether the bounded response policy reduced summaries or snapshot file lists.

Integration conflicts are returned as structured metadata. Earlier workers are marked applied, the conflicting worker is marked conflict, later workers are marked pending, and the dirty integration worktree is preserved for inspection. There is no automatic conflict resolution, merge into the original checkout, push, PR, or LLM-based Git decision. Ignored and secret-like untracked files are excluded from snapshots; worker worktrees remain preserved. Clean integration worktrees are cleanup-eligible at bridge shutdown, while dirty conflict worktrees are not force-deleted.

The keyless MCP tests use `test/fake-runtime.mjs`, including overlap, cap, workspace collision, partial failure, independent TTL, aggregate bounding, redaction, worktree isolation, review metadata, deterministic integration, conflict handling, clean/dirty cleanup, and shutdown coverage. The real OpenCode Go Phase 5 success/conflict smoke is opt-in:

```powershell
$env:DSH_MCP_PHASE5_REAL_SMOKE = "1"
npx --yes pnpm@11.7.0 test
```

The smoke exercises `tools/list`, `dsh_health`, three real OpenCode Go workers with non-empty responses, `dsh_worktree_review`, A+B success integration, A+C conflict integration, original-tree protection, child JSON-RPC stdout purity, secret-free stderr, and clean shutdown. It exits non-zero until the Windows gate passes.

For an explicitly non-Windows protocol experiment only:

```powershell
$env:DSH_MCP_REQUIRE_WINDOWS = "0"
$env:DSH_MCP_ALLOW_NON_WINDOWS = "1"
npx --yes pnpm@11.7.0 run phase0
```

That mode is not a Phase 0 completion result.

## Environment safety

- `DSH_MCP_PROFILE` selects `deepseek-official` or `opencode-go`; `DSH_MCP_PROVIDER`/`DSH_MCP_MODEL` may override the route values.
- `DSH_MCP_CREDENTIAL_REF` changes only the credential reference name; it never carries the credential value.
- `DSH_MCP_RUNTIME_ARGS` must be a JSON array of strings.
- If no override is needed, the SDK receives no `env` object and inherits the parent environment verbatim.
- When overrides are needed, the implementation merges them over `process.env` so `PATH` is retained.
- `DSH_MCP_CORDIS_CONFIG` is forwarded to the runtime as `DSH_CORDIS_CONFIG`.
- `DSH_MCP_RUNTIME_IDLE_TTL_MS` controls how long an idle pooled runtime remains restorable; the default is five minutes.
- `DSH_MCP_MAX_PARALLEL` controls the bounded parallel-worker semaphore; the default is three and the hard maximum is eight.
- Reports include secret-like environment variable names only, never values; exact configured credential values are scrubbed from diagnostics and responses.
- Runtime stdout is audited as newline-delimited JSON-RPC; diagnostics stay on stderr.
- A `RuntimeRunGate` rejects a second root run on the same runtime with `RUNTIME_BUSY`; it never queues it.

## Phase 5 gate

Phase 5 closes only when the review metadata path, deterministic success integration, structured conflict path, original-tree protection, clean/dirty worktree lifecycle, stdout/stderr, secret redaction, and zero-orphan checks pass in keyless tests and the opt-in Windows-native OpenCode Go E2E. Phase 0–4 compatibility remains mandatory.

Sandbox capability remains inconclusive and is not exposed as a security boundary or guarantee. Positive tool text and unchanged sentinels do not produce a `verified-full` result.

Phase 5 intentionally does not include merge into the original checkout, automatic conflict resolution, push/PR automation, `dsh_cancel`, nested DSH orchestration, progress streaming, HTTP transport, MCP v2 migration, or security sandbox claims. Phase 6 has not started.

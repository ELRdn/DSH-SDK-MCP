# dsh-sdk-mcp — Phase 0

This repository currently contains only the Phase 0 compatibility spike. It does **not** expose an MCP server yet.

The spike validates:

- TypeScript → `@deepseek-ai/dsh-sdk-client`
- explicit external DSH runtime launch via `command`/`args`
- stdio JSON-RPC protocol behavior
- one real filesystem-tool read
- same-runtime two-turn reuse
- one-active-root-run concurrency protection
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
```

The smoke command prints one JSON report. It exits non-zero until the Windows gate passes.

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
- Reports include secret-like environment variable names only, never values.
- Runtime stdout is audited as newline-delimited JSON-RPC; diagnostics stay on stderr.
- A `RuntimeRunGate` rejects a second root run on the same runtime with `RUNTIME_BUSY`; it never queues it.

## Phase 0 gate

Phase 0 Core closes only when Protocol Smoke, Tool Smoke, lifecycle/concurrency, stdout/stderr, version, cleanup, and orphan-process checks pass on Windows native.

Sandbox capability is reported separately. `unknown`, `partial`, or unpaired tool evidence is never reported as a verified security boundary, and no sandbox `mode` is exposed by this Phase 0 project. Phase 1 remains intentionally out of scope.

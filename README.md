# dsh-sdk-mcp

Use DeepSeek Harness as a persistent, parallel coding subagent from MCP
clients.

'dsh-sdk-mcp' is a release-candidate MCP stdio bridge. It reuses the official
DeepSeek Harness TypeScript SDK and its JSON-RPC runtime path; it does not
reimplement the DSH agent loop. The package is intended for local MCP hosts
such as Codex and Claude Code.

> Release candidate: '0.6.0-rc.1'. This repository does not publish an npm
> release as part of the release-candidate checks.

## What it is

The bridge turns MCP tool calls into bounded DSH runtime turns, preserves
same-session lifecycle, and adds bounded parallel workers, Git worktree
isolation, review metadata, and a deterministic integration gate. It keeps
protocol frames on stdout and diagnostics on stderr.

~~~text
Codex / Claude Code / MCP client
              |
              | MCP stdio, protocol 2025-11-25
              v
        dsh-sdk-mcp
              |
              | official DSH TypeScript SDK / JSON-RPC
              v
        DeepSeek Harness
              |
        external provider/model
~~~

For parallel repository work, the boundary is intentionally explicit:

~~~text
Parent MCP client
       |
       +-- DSH A -- worktree A -- review/integration metadata
       +-- DSH B -- worktree B -- review/integration metadata
       +-- DSH C -- worktree C -- review/integration metadata
~~~

## Features

- MCP v1 stdio server with exactly eight public tools.
- Persistent DSH sessions with a per-runtime single-active-run gate.
- Bounded parallel workers with a default cap of 3 and hard cap of 8.
- Git worktree isolation for same-repository parallel writes.
- Read-only worktree review and a bridge-owned deterministic integration gate.
- Structured DSH error classifications, timeout handling, secret redaction,
  bounded responses, stdin-EOF cleanup, and orphan-process checks.
- 'dsh-sdk-mcp --version' and 'dsh-sdk-mcp doctor [--json]' for distribution
  diagnostics.

## Runtime distribution policy

The npm package ships the MCP bridge, its production SDK dependencies, the
CLI, and the two reference Cordis composition files. It **does not bundle or
install the external DSH JSON-RPC runtime executable**. A caller must provide
an explicit runtime command and JSON argv array through
'DSH_MCP_RUNTIME_COMMAND' and 'DSH_MCP_RUNTIME_ARGS'.

This is deliberate: the bridge does not rely on npm global dependency
hoisting, a source checkout, or an accidental dev dependency. The release
package treats the runtime as an external launch dependency. 'doctor' reports
whether that command is configured and available; it never prints command
arguments or credential values. The pinned
'@deepseek-ai/dsh-sdk-jsonrpc-demo@0.1.1-rc.2' package is used by repository
validation and is not a production dependency of the published bridge.

## Requirements

- Node.js '>=22.19.0'.
- An MCP client that can launch a local stdio server.
- Git for worktree and integration tools.
- A separately installed and configured DSH JSON-RPC runtime for real turns.

## Installation

Install the release candidate globally with npm or pnpm:

~~~powershell
npm install --global dsh-sdk-mcp@0.6.0-rc.1
# or
pnpm add --global dsh-sdk-mcp@0.6.0-rc.1
~~~

Verify the installed CLI without starting a runtime:

~~~powershell
dsh-sdk-mcp --version
dsh-sdk-mcp doctor
~~~

Configure an external runtime with an executable plus argv array. The example
uses placeholders for a separately installed runtime; do not replace them with
shell-interpolated input or put credentials in the argument array.

~~~powershell
$env:DSH_MCP_RUNTIME_COMMAND = "C:\Program Files\nodejs\node.exe"
$env:DSH_MCP_RUNTIME_ARGS = '["C:/path/to/external/dsh-runtime/lib/bin.js"]'
$env:DSH_MCP_PROFILE = "opencode-go"
$env:DSH_MCP_PROVIDER = "opencode-go"
$env:DSH_MCP_MODEL = "deepseek-v4-flash"
# Supply OPENCODE_API_KEY through the secure host environment or credential service.
dsh-sdk-mcp doctor
dsh-sdk-mcp
~~~

The default Cordis file is selected from the installed package. Set
'DSH_MCP_CORDIS_CONFIG' only when the external runtime needs a different
composition. 'doctor --json' reports configuration presence and command
availability, not provider readiness; the MCP 'dsh_health' tool performs the
bounded runtime/provider probe.

## MCP client setup

### Codex

Register the installed executable as a local stdio server using the MCP
configuration mechanism available in the Codex host:

~~~json
{
  "mcpServers": {
    "dsh-sdk-mcp": {
      "command": "dsh-sdk-mcp",
      "args": []
    }
  }
}
~~~

Keep runtime configuration in the host process environment or its secure
credential mechanism. Do not put API keys in this JSON file.

### Claude Code

Claude Code can register the same installed executable over local stdio:

~~~powershell
claude mcp add --transport stdio dsh-sdk-mcp -- dsh-sdk-mcp
~~~

The command registers the transport. Configure the external runtime and
credential in the environment used when Claude Code launches the server.

### Generic MCP configuration

~~~json
{
  "mcpServers": {
    "dsh-sdk-mcp": {
      "command": "dsh-sdk-mcp",
      "args": [],
      "env": {
        "DSH_MCP_PROFILE": "opencode-go",
        "DSH_MCP_PROVIDER": "opencode-go",
        "DSH_MCP_MODEL": "deepseek-v4-flash"
      }
    }
  }
}
~~~

Prefer the host's secure credential store or environment injection for
'OPENCODE_API_KEY'/'DEEPSEEK_API_KEY'; never commit a value into a config file.

## Public tools

The release candidate exposes exactly these eight tools:

| Tool | Purpose |
| --- | --- |
| 'dsh_health' | Report configuration and bounded runtime/provider readiness. |
| 'dsh_delegate' | Start a new DSH session for one absolute workspace. |
| 'dsh_continue' | Continue an active session using the same runtime. |
| 'dsh_status' | Return coarse 'running', 'idle', 'expired', or 'missing' state. |
| 'dsh_parallel' | Run bounded tasks in distinct existing workspaces. |
| 'dsh_parallel_worktree' | Create bridge-owned worktrees for parallel repository tasks. |
| 'dsh_worktree_review' | Derive bounded review metadata from Git state. |
| 'dsh_integrate' | Apply worker snapshots inside a fresh integration worktree. |

All delegation 'cwd' values are absolute existing paths. A second active run
against the same runtime is rejected with a structured 'RUNTIME_BUSY' result.
Common DSH classifications such as 'QUOTA', 'MISSING_CREDENTIAL', and
'RATE_LIMITED' remain structured rather than being inferred from a free-form
model response.

Responses are bounded. A single final response is capped at 100,000
characters; parallel and integration aggregate responses are capped at
300,000 characters. Length and truncation fields are part of the structured
contract.

## Worktrees and integration

'dsh_parallel_worktree' validates a real Git repository, records the base ref
and commit, and gives each task a distinct bridge-owned linked worktree. Git
status and changed-file metadata are read from Git after execution. The
original checkout, branch, HEAD, and index are not used as worker workspaces.

Dirty worker or conflict worktrees are preserved for inspection. Clean
bridge-owned worktrees are eligible for cleanup when their session lifecycle
ends. There is no automatic merge into the original branch, conflict
resolution, push, pull request, or commit-generation policy.

## Security model

Credentials are never returned through 'structuredContent', text content,
stderr-derived diagnostics, or health output. Runtime commands use explicit
argv execution; stdout is reserved for MCP JSON-RPC and diagnostics go to
stderr. Runtime startup, active runs, stdin EOF, and shutdown are covered by
cleanup tests.

Sandbox capability is **inconclusive**. This project makes no verified-full
sandbox claim. Git worktree isolation prevents ordinary working-tree/index
collisions; it is not an OS security boundary and does not promise that DSH
cannot read, write, spawn processes, or access the network outside a worktree.
See [SECURITY.md](SECURITY.md) for the threat-model limits.

## Compatibility

This release intentionally uses '@modelcontextprotocol/sdk@1.30.0', the v1
' StdioServerTransport' path, and negotiated protocol revision
'2025-11-25'. It does not install or migrate to MCP v2's split
'@modelcontextprotocol/server' package. The exact package, runtime, host, and
platform matrix is in [COMPATIBILITY.md](COMPATIBILITY.md).

Codex and Claude Code are compatible at the common local-stdio/
'tools/list'/'tools/call' contract level. A live host-specific matrix is not
claimed by the keyless release checks.

## Troubleshooting

### 'doctor' says 'needs-configuration'

Set 'DSH_MCP_RUNTIME_COMMAND' and 'DSH_MCP_RUNTIME_ARGS' for the separately
installed runtime. Configure the profile/provider and credential reference
without putting the secret value in tool arguments or logs.

### Runtime is configured but 'dsh_health' is not ready

'doctor' checks configuration and command availability only. 'dsh_health'
distinguishes runtime initialization from provider readiness. Check the
external runtime, Cordis composition, provider route, and credential service;
quota and missing-credential failures are returned as structured errors.

### MCP client reports a protocol or tool-list problem

Confirm that the host launches 'dsh-sdk-mcp' directly, that the process uses
stdout only for JSON-RPC, and that the installed package is the expected
version. Do not wrap the command in a shell that prints a banner or diagnostic
to stdout.

## Development and release checks

~~~powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run typecheck
pnpm test
pnpm run package:dry-run
pnpm run package:inspect
pnpm run package:smoke
~~~

'package:smoke' packs the repository, installs the tarball into a disposable
empty directory, and verifies the installed CLI and MCP handshake. It is
keyless. The real OpenCode Go fresh-install smoke is opt-in and requires
'DSH_MCP_FRESH_REAL_SMOKE=1' plus an external runtime command, argv array, and
credential supplied by the caller. CI never receives credentials.

## Roadmap boundary

Phase 0 through Phase 5 are implemented and this release-candidate work
packages them as '0.6.0-rc.1'. No Phase 7 work is started by this release
candidate. Cancellation, MCP v2 migration, HTTP transport, progress
streaming, nested orchestration, and automatic remote/GitHub integration are
outside this scope.

## License

MIT. See [LICENSE](LICENSE).


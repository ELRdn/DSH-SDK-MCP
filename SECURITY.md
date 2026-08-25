# Security

## Security position

`dsh-sdk-mcp` is an MCP stdio bridge around the official DeepSeek Harness
TypeScript SDK. It is an orchestration adapter, not an operating-system
sandbox. The bridge does not claim that DSH, a worktree, or a Cordis
composition prevents access to paths, processes, or network resources outside
the requested workspace. Sandbox capability remains **inconclusive** until a
separate, independently designed security assessment proves otherwise.

Worktrees provide filesystem and Git-index collision isolation for parallel
workers. A worktree is not a security boundary.

## Credential handling

- Provide credentials through the external runtime's supported environment or
  credential service. Never put a credential value in a tool argument, task,
  runtime argument, Cordis file, issue, test fixture, or documentation.
- The bridge reports only boolean credential presence. It never reports a
  credential value or a secret-bearing environment value.
- Secret-like values from configured credential references and runtime
  overrides are redacted from structured MCP results, text content, diagnostics,
  and stderr-derived errors.
- Do not enable shell interpolation for runtime launch. Runtime commands and
  arguments are passed as explicit argv values.
- Treat provider prompts, model responses, runtime logs, and Git metadata as
  potentially sensitive. Do not paste them into public bug reports without
  redaction.

## Process and protocol boundaries

- stdout is reserved for MCP JSON-RPC frames. Diagnostics belong on stderr.
- Runtime startup, initialization, active runs, stdin EOF, and bridge shutdown
  are all lifecycle paths. The bridge closes starting and active runtimes and
  checks for orphan-free shutdown in its regression and opt-in real tests.
- A runtime/session has one active run at a time. Concurrent use is rejected
  with a structured busy classification.
- Default delegation timeout is 15 minutes; health probing is capped at 30
  seconds. Git subprocesses and doctor command probes are bounded as well.
- A single delegation response is bounded to 100,000 characters. Parallel and
  integration aggregate results are bounded to 300,000 characters and include
  explicit truncation metadata.
- Git commands use argv-based execution and derive review/integration metadata
  from Git state rather than model narration.

## Scope limitations

The bridge can still be affected by the permissions of the external DSH
runtime, its provider, the host process, the filesystem, and the network. In
particular, this project does not promise:

- OS-level isolation or a verified sandbox;
- prevention of network access or process creation by DSH tools;
- protection from a compromised provider/runtime or host environment;
- automatic merge conflict resolution, push, pull-request creation, or branch
  integration into the user's original checkout.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the repository maintainer
through the project's configured security contact or private repository
channel. Include a minimal reproduction, affected version, platform, and
impact. Do not include API keys, access tokens, full environment dumps, or
unredacted runtime logs. If a secret was exposed, revoke or rotate it first.

This repository is a release candidate. Do not treat the release-candidate
artifact as a security certification.

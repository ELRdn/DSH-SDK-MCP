import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { arch, platform, release, tmpdir, version } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DeepSeekHarness, type RunResult } from '@deepseek-ai/dsh-sdk-client'
import type { InitializeParams, InitializeResult } from '@deepseek-ai/dsh-sdk-protocol'

import {
  loadPhase0Options,
  loadRuntimeLaunchConfig,
  redactSecretLike,
  type RuntimeLaunchConfig,
} from './config.js'
import { RuntimeRunGate } from './run-gate.js'
import {
  classifySandboxCapability,
  summarizeRunResult,
  summarizeToolEvents,
  type InitializeDiagnostic,
  type RunDiagnostic,
} from './diagnostics.js'
import {
  makeLaunchReport,
  packageVersion,
  safeError,
  stageFailed,
  stageInconclusive,
  stagePassed,
  stageSkipped,
  type Phase0Report,
  type SandboxCapabilityStatus,
  type StageResult,
} from './report.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeProbePath = resolve(projectRoot, 'scripts', 'runtime-probe.mjs')

interface AuditRecord {
  probePid?: number
  childPid?: number
  childExitCode: number | null
  childSignal: string | null
  stdoutBytes: number
  protocolLines: number
  nonProtocolLines: string[]
  stderrBytes: number
  stderrTail: string[]
  error?: string
}

interface WorkspaceFixture {
  root: string
  sessions: string
  auditPath: string
  readmePath: string
  fsSentinelPath: string
  shellSentinelPath: string
}

function createProbeLaunch(
  launch: RuntimeLaunchConfig,
  auditPath: string,
): RuntimeLaunchConfig {
  return {
    command: process.execPath,
    args: [
      runtimeProbePath,
      launch.command,
      JSON.stringify(launch.args),
      auditPath,
      launch.cwd ?? process.cwd(),
    ],
    cwd: launch.cwd,
    env: launch.env,
  }
}

function withWorkspaceEnvironment(
  launch: RuntimeLaunchConfig,
  fixture: WorkspaceFixture,
): RuntimeLaunchConfig {
  return {
    ...launch,
    env: {
      ...(launch.env ?? process.env),
      DSH_CWD: fixture.root,
      DSH_SESSION_ROOT: fixture.sessions,
    },
  }
}

async function readAudit(auditPath: string): Promise<AuditRecord | null> {
  try {
    return JSON.parse(await readFile(auditPath, 'utf8')) as AuditRecord
  } catch {
    return null
  }
}

async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

async function createWorkspaceFixture(): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase0-'))
  const sessions = await mkdtemp(join(root, 'sessions-'))
  const auditPath = join(root, 'runtime-audit.json')
  const readmePath = join(root, 'README.md')
  const fsSentinelPath = join(root, 'fs-sentinel.txt')
  const shellSentinelPath = join(root, 'pwsh-sentinel.txt')

  await writeFile(
    readmePath,
    '# DSH_PHASE0_TOOL_SMOKE\n\nThis file is intentionally known to the smoke test.\n',
    'utf8',
  )
  await writeFile(fsSentinelPath, 'FS_SENTINEL_ORIGINAL\n', 'utf8')
  await writeFile(shellSentinelPath, 'PWSH_SENTINEL_ORIGINAL\n', 'utf8')

  return { root, sessions, auditPath, readmePath, fsSentinelPath, shellSentinelPath }
}

function eventTypes(result: RunResult): string[] {
  return [...new Set(result.events.map((event) => event.type))]
}

function serializedEvents(result: RunResult): string {
  return JSON.stringify(result.events).toLowerCase()
}

function idleObserved(result: RunResult): boolean {
  return result.notifications.some((notification) => (
    notification.method === 'session.status'
    && notification.params.status === 'idle'
  ))
}

function toolEvents(result: RunResult): ReturnType<typeof summarizeToolEvents> & { serialized: string } {
  return {
    ...summarizeToolEvents(result),
    serialized: serializedEvents(result),
  }
}

function enforcementFromResult(result: RunResult): 'full' | 'partial' | 'unknown' {
  const serialized = serializedEvents(result)
  if (serialized.includes('"enforcement":"partial"')) return 'partial'
  if (serialized.includes('"enforcement":"full"')) return 'full'
  return 'unknown'
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

async function runWithGate<T>(gate: RuntimeRunGate, task: () => Promise<T>): Promise<T> {
  return gate.runExclusive(task)
}

interface InitializeObserver {
  current(): InitializeDiagnostic
}

function observeInitialize(harness: DeepSeekHarness): InitializeObserver {
  const client = harness.client
  const originalInitialize = client.initialize.bind(client)
  let diagnostic: InitializeDiagnostic = { success: false }

  client.initialize = async (params: InitializeParams): Promise<InitializeResult> => {
    try {
      const result = await originalInitialize(params)
      diagnostic = { success: true, serverInfo: result.serverInfo }
      return result
    } catch (error) {
      diagnostic = { success: false, error: safeError(error) }
      throw error
    }
  }

  return { current: () => diagnostic }
}

function protocolFailure(diagnostic: RunDiagnostic): Error & { code: string } {
  const code = diagnostic.failureClassification ?? 'PROTOCOL_SMOKE_FAILED'
  const error = new Error(`Protocol Smoke failed: ${code}`) as Error & { code: string }
  error.code = code
  return error
}

async function runProtocolSmoke(
  harness: DeepSeekHarness,
  gate: RuntimeRunGate,
  options: ReturnType<typeof loadPhase0Options>,
): Promise<StageResult> {
  const initialize = observeInitialize(harness)
  let diagnostic: RunDiagnostic | undefined
  try {
    const result = await runWithGate(gate, () => harness.run(
      'Reply with exactly: DSH_PHASE0_PROTOCOL_OK',
      { sessionId: 'phase0-protocol' },
    ))
    diagnostic = summarizeRunResult(result, {
      marker: 'DSH_PHASE0_PROTOCOL_OK',
      provider: options.provider,
      model: options.model,
      initialize: initialize.current(),
    })
    const details = {
      diagnostics: diagnostic,
      sessionId: result.sessionId,
      finalResponseNonEmpty: diagnostic.finalResponse.nonEmpty,
      markerFound: diagnostic.finalResponse.markerFound,
      idleObserved: idleObserved(result),
      eventTypes: eventTypes(result),
    }
    if (!diagnostic.finalResponse.nonEmpty || !diagnostic.finalResponse.markerFound) {
      return stageFailed(protocolFailure(diagnostic), details)
    }
    return stagePassed(details)
  } catch (error) {
    return stageFailed(error, {
      diagnostics: diagnostic,
      initialize: initialize.current(),
    })
  }
}

async function runToolSmoke(
  harness: DeepSeekHarness,
  gate: RuntimeRunGate,
  fixture: WorkspaceFixture,
): Promise<StageResult> {
  try {
    const beforeReadme = await hashFile(fixture.readmePath)
    const beforeFsSentinel = await hashFile(fixture.fsSentinelPath)
    const result = await runWithGate(gate, () => harness.run(
      [
        'Use the filesystem read tool to read README.md in the current workspace.',
        'Do not use PowerShell, Bash, or any other tool.',
        'Return the exact heading and do not modify any file.',
      ].join(' '),
      { sessionId: 'phase0-tool' },
    ))
    const evidence = toolEvents(result)
    const afterReadme = await hashFile(fixture.readmePath)
    const afterFsSentinel = await hashFile(fixture.fsSentinelPath)
    const readEvidence = /(?:"name":"read"|read(?:_file)?|tool-fs|filesystem)/i.test(evidence.serialized)

    if (!evidence.paired || !readEvidence) {
      throw new Error('Tool Smoke did not provide a paired filesystem read tool event')
    }
    if (!result.finalResponse.includes('DSH_PHASE0_TOOL_SMOKE')) {
      throw new Error('Tool Smoke response did not contain the README marker')
    }
    assertEqual(afterReadme, beforeReadme, 'README changed during read-only Tool Smoke')
    assertEqual(afterFsSentinel, beforeFsSentinel, 'filesystem sentinel changed during Tool Smoke')

    return stagePassed({
      sessionId: result.sessionId,
      toolCalls: evidence.calls,
      toolResults: evidence.results,
      pairedToolEvents: evidence.paired,
      toolCallIds: evidence.callIds,
      toolResultIds: evidence.resultIds,
      unpairedToolCallIds: evidence.unpairedCallIds,
      toolNames: evidence.toolNames,
      readEvidence,
      finalResponseNonEmpty: result.finalResponse.trim().length > 0,
      idleObserved: idleObserved(result),
      filesUnchanged: true,
      eventTypes: eventTypes(result),
    })
  } catch (error) {
    return stageFailed(error)
  }
}

async function runLifecycleSmoke(
  harness: DeepSeekHarness,
  gate: RuntimeRunGate,
  fixture: WorkspaceFixture,
): Promise<StageResult> {
  try {
    const first = await runWithGate(gate, () => harness.run(
      'Reply with exactly: DSH_PHASE0_TURN_ONE',
      { sessionId: 'phase0-lifecycle' },
    ))
    const second = await runWithGate(gate, () => harness.run(
      'Reply with exactly: DSH_PHASE0_TURN_TWO',
      { sessionId: 'phase0-lifecycle' },
    ))

    const firstResponseOk = first.finalResponse.includes('DSH_PHASE0_TURN_ONE')
    const secondResponseOk = second.finalResponse.includes('DSH_PHASE0_TURN_TWO')
    const firstEventsIsolated = !serializedEvents(first).includes('dsh_phase0_turn_two')
    const secondEventsIsolated = !serializedEvents(second).includes('dsh_phase0_turn_one')
    if (!firstResponseOk || !secondResponseOk) {
      throw new Error('Lifecycle Smoke did not return both turn markers')
    }
    if (!firstEventsIsolated || !secondEventsIsolated) {
      throw new Error('Lifecycle Smoke returned events from the other turn')
    }
    assertEqual(first.sessionId, second.sessionId, 'Lifecycle session id was not reused')

    const firstRun = runWithGate(gate, () => harness.run(
      'Read README.md with the filesystem read tool and reply with DSH_PHASE0_CONCURRENT_FIRST.',
      { sessionId: 'phase0-concurrency-first' },
    ))
    const secondRun = runWithGate(gate, () => harness.run(
      'Reply with DSH_PHASE0_CONCURRENT_SECOND.',
      { sessionId: 'phase0-concurrency-second' },
    ))

    const secondOutcome = await secondRun.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error: safeError(error) }),
    )
    if (secondOutcome.ok) throw new Error('Concurrent root run was not rejected')
    if (secondOutcome.error.code !== 'RUNTIME_BUSY') {
      throw new Error('Concurrent root run was not rejected with RUNTIME_BUSY')
    }
    await firstRun

    return stagePassed({
      sessionId: first.sessionId,
      firstResponseMarkerFound: firstResponseOk,
      secondResponseMarkerFound: secondResponseOk,
      sameSession: true,
      firstEventsIsolated,
      secondEventsIsolated,
      firstIdleObserved: idleObserved(first),
      secondIdleObserved: idleObserved(second),
      concurrentRunRejected: true,
      concurrencyErrorCode: secondOutcome.error.code,
      workspace: basename(fixture.root),
    })
  } catch (error) {
    return stageFailed(error)
  }
}

async function runSandboxSmoke(
  launch: RuntimeLaunchConfig,
  options: ReturnType<typeof loadPhase0Options>,
  fixture: WorkspaceFixture,
): Promise<StageResult> {
  if (platform() !== 'win32') {
    return stageSkipped('Windows native sandbox probe is required; current platform is not win32')
  }
  if (!existsSync(options.sandboxCordisConfig)) {
    return stageFailed(new Error(
      `Sandbox Cordis config does not exist: ${options.sandboxCordisConfig}`,
    ))
  }

  const auditPath = join(fixture.root, 'sandbox-runtime-audit.json')
  const sandboxEnvironment = {
    ...(launch.env ?? process.env),
    DSH_CORDIS_CONFIG: options.sandboxCordisConfig,
    DSH_PERMISSION_MODE: 'read-only',
    DSH_CWD: fixture.root,
    DSH_SESSION_ROOT: fixture.sessions,
  }
  const sandboxLaunch = createProbeLaunch(
    { ...launch, env: sandboxEnvironment },
    auditPath,
  )
  const harness = new DeepSeekHarness({
    launch: sandboxLaunch,
    cwd: fixture.root,
    provider: options.provider,
    model: options.model,
    maxTokens: options.maxTokens,
  })
  const gate = new RuntimeRunGate()
  let smoke: StageResult
  let cleanup: StageResult = stageSkipped('sandbox runtime was not closed')

  try {
    const beforeFs = await hashFile(fixture.fsSentinelPath)
    const fsResult = await runWithGate(gate, () => harness.run(
      'Use the filesystem write tool only. Overwrite fs-sentinel.txt with MUST_NOT_CHANGE. Do not use PowerShell. Report the tool result.',
      { sessionId: 'phase0-sandbox-fs' },
    ))
    const afterFs = await hashFile(fixture.fsSentinelPath)
    const fsEvents = toolEvents(fsResult)
    const fsDenied = afterFs === beforeFs
      && fsEvents.paired
      && /(?:denied|sandbox|read-only|FS_SANDBOX_DENIED)/i.test(fsEvents.serialized)

    const beforeShell = await hashFile(fixture.shellSentinelPath)
    const shellResult = await runWithGate(gate, () => harness.run(
      'Use the PowerShell tool only. Overwrite pwsh-sentinel.txt with MUST_NOT_CHANGE. Do not use the filesystem tool. Report the tool result.',
      { sessionId: 'phase0-sandbox-pwsh' },
    ))
    const afterShell = await hashFile(fixture.shellSentinelPath)
    const shellEvents = toolEvents(shellResult)
    const shellDenied = afterShell === beforeShell
      && shellEvents.paired
      && /(?:denied|sandbox|read-only|SANDBOX_UNAVAILABLE)/i.test(shellEvents.serialized)
      && /(?:pwsh|powershell|tool-pwsh|shell)/i.test(shellEvents.serialized)

    const enforcement = enforcementFromResult(shellResult) === 'unknown'
      ? enforcementFromResult(fsResult)
      : enforcementFromResult(shellResult)
    const capabilityStatus: SandboxCapabilityStatus = classifySandboxCapability({
      enforcement,
      filesystemToolEventsPaired: fsEvents.paired,
      powerShellToolEventsPaired: shellEvents.paired,
      filesystemWriteDenied: fsDenied,
      powerShellWriteDenied: shellDenied,
      sentinelsUnchanged: afterFs === beforeFs && afterShell === beforeShell,
    })
    const details = {
      capabilityStatus,
      mode: 'read-only',
      enforcement,
      filesystemWriteDenied: fsDenied,
      powerShellWriteDenied: shellDenied,
      sentinelsUnchanged: afterFs === beforeFs && afterShell === beforeShell,
      filesystemToolEventsPaired: fsEvents.paired,
      powerShellToolEventsPaired: shellEvents.paired,
      filesystemToolNames: fsEvents.toolNames,
      powerShellToolNames: shellEvents.toolNames,
      filesystemToolCallIds: fsEvents.callIds,
      powerShellToolCallIds: shellEvents.callIds,
    }
    smoke = capabilityStatus === 'verified-full'
      ? stagePassed(details)
      : capabilityStatus === 'failed'
        ? stageFailed(new Error('Sandbox read-only enforcement was not proven'), details)
        : stageInconclusive(details)
  } catch (error) {
    smoke = stageFailed(error)
  } finally {
    cleanup = await closeHarness(harness, auditPath)
  }

  if (cleanup.status === 'failed') {
    return stageFailed(new Error('Sandbox runtime cleanup did not prove process exit'), {
      smoke,
      cleanup,
    })
  }
  if (smoke.status === 'passed') return stagePassed({ ...smoke.details, cleanup: cleanup.details })
  if (smoke.status === 'inconclusive') {
    return stageInconclusive({ ...smoke.details, cleanup: cleanup.details })
  }
  return smoke
}

function processAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function closeHarness(
  harness: DeepSeekHarness,
  auditPath: string,
): Promise<StageResult> {
  try {
    await harness.close()
    const audit = await readAudit(auditPath)
    if (audit === null) throw new Error('Runtime probe audit was not written')
    await new Promise((resolve) => setTimeout(resolve, 25))
    const protocolOnly = audit.nonProtocolLines.length === 0
    const childExited = audit.childExitCode !== null || audit.childSignal !== null || audit.error !== undefined
    const orphanPids = [audit.probePid, audit.childPid].filter((pid) => processAlive(pid))
    if (!protocolOnly) throw new Error('Runtime emitted non-JSON-RPC stdout frames')
    if (!childExited) throw new Error('Runtime probe did not observe child process exit')
    if (orphanPids.length > 0) throw new Error(`Runtime process remained alive: ${orphanPids.join(',')}`)
    return stagePassed({
      stdoutProtocolOnly: protocolOnly,
      childExited,
      childExitCode: audit.childExitCode,
      childSignal: audit.childSignal,
      probePid: audit.probePid,
      childPid: audit.childPid,
      orphanPids,
      orphanProcesses: false,
      stderrBytes: audit.stderrBytes,
      stderrTail: audit.stderrTail.slice(-16).map(redactSecretLike),
      runtimeProbeError: audit.error === undefined ? undefined : redactSecretLike(audit.error),
    })
  } catch (error) {
    return stageFailed(error, { auditPath })
  }
}

export async function runPhase0(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Phase0Report> {
  const startedAt = new Date().toISOString()
  const options = loadPhase0Options(environment, projectRoot)
  const launchEnvironment = environment.DSH_MCP_CORDIS_CONFIG?.trim()
    ? environment
    : { ...environment, DSH_MCP_CORDIS_CONFIG: options.cordisConfig }
  const launch = loadRuntimeLaunchConfig(launchEnvironment, projectRoot)
  const fixture = await createWorkspaceFixture()
  const effectiveLaunch = withWorkspaceEnvironment(launch, fixture)
  const probeLaunch = createProbeLaunch(effectiveLaunch, fixture.auditPath)
  const dependencies = {
    '@deepseek-ai/dsh-sdk-client': packageVersion('@deepseek-ai/dsh-sdk-client'),
    '@deepseek-ai/dsh-sdk-protocol': packageVersion('@deepseek-ai/dsh-sdk-protocol'),
    '@deepseek-ai/dsh-llm-pi-ai': packageVersion('@deepseek-ai/dsh-llm-pi-ai'),
    '@earendil-works/pi-ai': packageVersion('@earendil-works/pi-ai'),
    [options.runtimePackage]: packageVersion(options.runtimePackage),
  }
  const failures: string[] = []
  const stages = {
    protocol: stageSkipped('not run'),
    tool: stageSkipped('not run'),
    lifecycle: stageSkipped('not run'),
    sandbox: stageSkipped('not run'),
    cleanup: stageSkipped('not run'),
  }

  if (options.requireWindows && platform() !== 'win32') failures.push('WINDOWS_REQUIRED')

  let harness: DeepSeekHarness | undefined
  try {
    harness = new DeepSeekHarness({
      launch: probeLaunch,
      cwd: fixture.root,
      provider: options.provider,
      model: options.model,
      maxTokens: options.maxTokens,
    })
    const gate = new RuntimeRunGate()

    if (failures.length === 0 || environment.DSH_MCP_ALLOW_NON_WINDOWS === '1') {
      stages.protocol = await runProtocolSmoke(harness, gate, options)
      stages.tool = stages.protocol.status === 'passed'
        ? await runToolSmoke(harness, gate, fixture)
        : stageSkipped('Protocol Smoke failed')
      stages.lifecycle = stages.tool.status === 'passed'
        ? await runLifecycleSmoke(harness, gate, fixture)
        : stageSkipped('Tool Smoke failed')
      stages.sandbox = await runSandboxSmoke(effectiveLaunch, options, fixture)
    }
  } catch (error) {
    failures.push(safeError(error).message)
  } finally {
    if (harness !== undefined) stages.cleanup = await closeHarness(harness, fixture.auditPath)
    try {
      await rm(fixture.root, { recursive: true, force: true })
    } catch (error) {
      failures.push(`TEMP_CLEANUP_FAILED: ${safeError(error).message}`)
    }
  }

  const coreStageEntries = [
    ['protocol', stages.protocol],
    ['tool', stages.tool],
    ['lifecycle', stages.lifecycle],
    ['cleanup', stages.cleanup],
  ] as const
  const coreFailures = failures.slice()
  for (const [name, stage] of coreStageEntries) {
    if (stage.status === 'failed') {
      const failure = `${name}: ${stage.error?.message ?? 'failed'}`
      failures.push(failure)
      coreFailures.push(failure)
    }
  }
  if (stages.sandbox.status === 'failed') {
    failures.push(`sandbox: ${stages.sandbox.error?.message ?? 'failed'}`)
  }

  const sandboxDetailStatus = stages.sandbox.details.capabilityStatus
  const sandboxStatus: SandboxCapabilityStatus = sandboxDetailStatus === 'verified-full'
    || sandboxDetailStatus === 'observed-partial'
    || sandboxDetailStatus === 'inconclusive'
    || sandboxDetailStatus === 'failed'
    ? sandboxDetailStatus
    : stages.sandbox.status === 'failed' ? 'failed' : 'inconclusive'
  const coreExecutedStages = coreStageEntries
    .map(([, stage]) => stage)
    .filter((stage) => stage.status !== 'skipped')
  const coreStatus = coreFailures.length === 0
    && coreExecutedStages.length > 0
    && coreExecutedStages.every((stage) => stage.status === 'passed')
    ? 'passed'
    : 'failed'
  const sandboxCapability = {
    status: sandboxStatus,
    details: stages.sandbox.details,
  }

  const finishedAt = new Date().toISOString()
  return {
    schemaVersion: 3,
    status: coreStatus,
    coreStatus,
    phase1Eligible: false,
    profile: options.profile,
    provider: options.provider,
    model: options.model,
    credentialRef: options.credentialRef,
    startedAt,
    finishedAt,
    platform: {
      node: process.version,
      platform: process.platform,
      arch: arch(),
      release: release(),
      osVersion: version(),
      windowsRequired: options.requireWindows,
    },
    dependencies,
    launch: makeLaunchReport(
      effectiveLaunch.command,
      effectiveLaunch.args,
      effectiveLaunch.cwd,
      effectiveLaunch.env ?? environment,
    ),
    stages,
    sandboxCapability,
    coreFailures,
    failures,
  }
}

export async function main(): Promise<void> {
  try {
    const report = await runPhase0()
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.status === 'failed') process.exitCode = 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 2,
      status: 'failed',
      coreStatus: 'failed',
      phase1Eligible: false,
      sandboxCapability: { status: 'inconclusive', details: { reason: 'phase0 threw before report construction' } },
      error: safeError(error),
    }, null, 2)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main()
}

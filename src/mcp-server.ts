import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { arch, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DeepSeekHarness,
  JsonRpcResponseError,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
  type RunResult,
} from '@deepseek-ai/dsh-sdk-client'
import type { InitializeParams, InitializeResult } from '@deepseek-ai/dsh-sdk-protocol'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  MAX_PARALLEL_HARD_LIMIT,
  loadPhase0Options,
  loadRuntimeLaunchConfig,
  redactSecretLike,
  secretValuesFromEnvironment,
  type Phase0Options,
  type RuntimeLaunchConfig,
} from './config.js'
import {
  summarizeRunResult,
  type InitializeDiagnostic,
  type RunDiagnostic,
} from './diagnostics.js'
import { RuntimeBusyError, RuntimeRunGate } from './run-gate.js'
import { safeError } from './report.js'
import {
  RuntimePool,
  RuntimePoolClosedError,
  type RuntimeHandle,
  type RuntimeLease,
  type RuntimeResource,
  type RuntimeSpec,
} from './runtime-pool.js'
import { ParallelSemaphore, ParallelSemaphoreClosedError } from './parallel-semaphore.js'
import { SessionRegistry } from './session-registry.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const PHASE3_VERSION = '0.3.0-phase3'
/** Kept as export aliases for earlier host integrations. */
export const PHASE2_VERSION = PHASE3_VERSION
export const PHASE1_VERSION = PHASE3_VERSION
export const DEFAULT_DELEGATION_TIMEOUT_MS = 900_000
export const DEFAULT_HEALTH_TIMEOUT_MS = 30_000
export const DEFAULT_RUNTIME_IDLE_TTL_MS = 300_000
export const DEFAULT_MAX_PARALLEL = 3
export const MAX_PARALLEL_AGGREGATE_RESPONSE_CHARS = 300_000
export const MAX_DELEGATE_RESPONSE_CHARS = 100_000
const HEALTH_PROBE_TASK = 'Reply with exactly DSH_MCP_HEALTH_OK. Do not use any tools or modify files.'

const READINESS_STATES = ['verified', 'unverified', 'unavailable'] as const
type ReadinessState = typeof READINESS_STATES[number]

const HealthOutputSchema = z.object({
  ok: z.boolean(),
  bridgeVersion: z.string(),
  nodeVersion: z.string(),
  platform: z.string(),
  arch: z.string(),
  runtimeConfigured: z.boolean(),
  runtimeReady: z.boolean(),
  runtimeReadiness: z.enum(READINESS_STATES),
  provider: z.string(),
  model: z.string(),
  providerConfigured: z.boolean(),
  providerReady: z.boolean(),
  providerReadiness: z.enum(READINESS_STATES),
  credentialConfigured: z.boolean(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
})

const DelegateInputSchema = z.object({
  task: z.string().min(1).max(200_000),
  cwd: z.string().min(1).max(4_096),
}).strict()

const ContinueInputSchema = z.object({
  sessionId: z.string().min(1).max(256),
  task: z.string().min(1).max(200_000),
}).strict()

const ParallelTaskInputSchema = z.object({
  task: z.string().min(1).max(200_000),
  cwd: z.string().min(1).max(4_096),
}).strict()

const ParallelInputSchema = z.object({
  tasks: z.array(ParallelTaskInputSchema).min(1).max(MAX_PARALLEL_HARD_LIMIT),
}).strict()

const StatusInputSchema = z.object({
  sessionId: z.string().min(1).max(256),
}).strict()

const DelegateDiagnosticsSchema = z.object({
  failureClassification: z.string().optional(),
  providerOutcome: z.string().optional(),
  eventsCount: z.number().int().nonnegative(),
  notificationsCount: z.number().int().nonnegative(),
  assistantMessageEvents: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolResults: z.number().int().nonnegative(),
})

const DelegateOutputSchema = z.object({
  ok: z.boolean(),
  status: z.enum(['completed', 'error']),
  sessionId: z.string(),
  cwd: z.string(),
  durationMs: z.number().int().nonnegative(),
  finalResponse: z.string(),
  finalResponseLength: z.number().int().nonnegative(),
  finalResponseTruncated: z.boolean(),
  diagnostics: DelegateDiagnosticsSchema.optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
})

const SessionStatusOutputSchema = z.object({
  ok: z.boolean(),
  status: z.enum(['running', 'idle', 'expired', 'missing']),
  sessionId: z.string(),
  cwd: z.string().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
})

const ParallelWorkerResultSchema = z.object({
  index: z.number().int().nonnegative(),
  ok: z.boolean(),
  status: z.enum(['completed', 'error']),
  sessionId: z.string(),
  cwd: z.string(),
  durationMs: z.number().int().nonnegative(),
  finalResponse: z.string(),
  finalResponseLength: z.number().int().nonnegative(),
  finalResponseTruncated: z.boolean(),
  diagnostics: DelegateDiagnosticsSchema.optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
})

const ParallelOutputSchema = z.object({
  ok: z.boolean(),
  results: z.array(ParallelWorkerResultSchema),
  aggregateResponseLength: z.number().int().nonnegative(),
  aggregateResponseTruncated: z.boolean(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
})

export type DshHealthOutput = z.infer<typeof HealthOutputSchema>
export type DshDelegateInput = z.infer<typeof DelegateInputSchema>
export type DshDelegateOutput = z.infer<typeof DelegateOutputSchema>
export type DshContinueInput = z.infer<typeof ContinueInputSchema>
export type DshStatusInput = z.infer<typeof StatusInputSchema>
export type DshSessionStatusOutput = z.infer<typeof SessionStatusOutputSchema>
export type DshParallelInput = z.infer<typeof ParallelInputSchema>
export type DshParallelOutput = z.infer<typeof ParallelOutputSchema>
export type DshParallelWorkerResult = z.infer<typeof ParallelWorkerResultSchema>

type BridgeError = {
  code: string
  message: string
}

class Phase1InputError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'Phase1InputError'
    this.code = code
  }
}

function boundedSafeMessage(message: string, secretValues: readonly string[] = []): string {
  const redacted = redactSecretLike(message, secretValues)
  return redacted.length <= 400 ? redacted : `${redacted.slice(0, 400)}…`
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RequestTimeoutError(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function healthProbeFailure(diagnostic: RunDiagnostic): Error & { code: string } {
  const code = diagnostic.failureClassification === undefined
    ? 'PROVIDER_PROBE_FAILED'
    : exactClassification(diagnostic.failureClassification) ?? diagnostic.failureClassification
  const error = new Phase1InputError(
    code,
    `DSH provider health probe failed: ${code}`,
  ) as Error & { code: string }
  return error
}

function safeCode(value: string, secretValues: readonly string[] = []): string {
  const redacted = redactSecretLike(value, secretValues).toUpperCase()
  const normalized = redacted.replace(/[^A-Z0-9_:-]/g, '_')
  return normalized.slice(0, 80) || 'INTERNAL_ERROR'
}

function errorFrom(error: unknown, secretValues: readonly string[] = []): BridgeError {
  const safe = safeError(error, secretValues)
  return {
    code: safeCode(safe.code ?? 'INTERNAL_ERROR', secretValues),
    message: boundedSafeMessage(safe.message, secretValues),
  }
}

const DSH_CLASSIFICATIONS = [
    'QUOTA',
    'MISSING_CREDENTIAL',
  'AUTHENTICATION_FAILED',
  'RATE_LIMITED',
    'CONTEXT_LIMIT',
    'RUNTIME_BUSY',
] as const

const DSH_CLASSIFICATION_ALIASES: Record<string, string> = {
  RATE_LIMIT: 'RATE_LIMITED',
}

const TERMINAL_RUNTIME_CODES = new Set([
  'BRIDGE_CLOSED',
  'RUN_TIMEOUT',
  'RUNTIME_DIED',
  'RUNTIME_START_FAILED',
  'DSH_INITIALIZE_FAILED',
  'RUNTIME_PROTOCOL_ERROR',
])

function exactClassification(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_')
  if ((DSH_CLASSIFICATIONS as readonly string[]).includes(normalized)) return normalized
  return DSH_CLASSIFICATION_ALIASES[normalized]
}

function structuredClassification(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const candidate = error as { code?: unknown; data?: unknown }
  const direct = exactClassification(candidate.code)
  if (direct !== undefined) return direct
  if (candidate.data === null || typeof candidate.data !== 'object') return undefined
  const data = candidate.data as Record<string, unknown>
  for (const key of ['classification', 'failureClassification', 'errorCode', 'code']) {
    const classification = exactClassification(data[key])
    if (classification !== undefined) return classification
  }
  return undefined
}

function textClassification(value: string): string | undefined {
  const upper = value.toUpperCase()
  const token = [...DSH_CLASSIFICATIONS, ...Object.keys(DSH_CLASSIFICATION_ALIASES)].find((candidate) => (
    new RegExp(`(?:^|[^A-Z0-9_])${candidate}(?:$|[^A-Z0-9_])`).test(upper)
  ))
  return token === undefined ? undefined : exactClassification(token)
}

function classifyThrownError(
  error: unknown,
  initialize: InitializeDiagnostic,
  secretValues: readonly string[] = [],
  closing = false,
): BridgeError {
  const safe = safeError(error, secretValues)
  if (error instanceof RuntimeBusyError) {
    return { code: 'RUNTIME_BUSY', message: 'The DSH runtime already has an active delegation' }
  }
  const structured = structuredClassification(error)
  if (structured !== undefined) {
    return {
      code: structured,
      message: boundedSafeMessage(safe.message, secretValues),
    }
  }
  if (error instanceof Phase1InputError) {
    return {
      code: safeCode(error.code, secretValues),
      message: boundedSafeMessage(error.message, secretValues),
    }
  }
  if (error instanceof RequestTimeoutError) {
    return { code: 'RUN_TIMEOUT', message: boundedSafeMessage(error.message, secretValues) }
  }
  if (error instanceof SdkProtocolError) {
    return {
      code: 'RUNTIME_PROTOCOL_ERROR',
      message: boundedSafeMessage(error.message, secretValues),
    }
  }
  if (error instanceof TransportClosedError) {
    return {
      code: closing
        ? 'BRIDGE_CLOSED'
        : initialize.success
          ? 'RUNTIME_DIED'
          : 'RUNTIME_START_FAILED',
      message: closing
        ? 'The DSH runtime was closed during MCP bridge shutdown'
        : boundedSafeMessage(error.message, secretValues),
    }
  }
  if (error instanceof JsonRpcResponseError) {
    return {
      code: initialize.success ? 'DSH_RPC_ERROR' : 'DSH_INITIALIZE_FAILED',
      message: boundedSafeMessage(error.message, secretValues),
    }
  }
  if (!initialize.success) {
    return {
      code: 'DSH_INITIALIZE_FAILED',
      message: boundedSafeMessage(initialize.error?.message ?? safe.message, secretValues),
    }
  }
  const fallback = textClassification(safe.message)
  if (fallback !== undefined) {
    return { code: fallback, message: boundedSafeMessage(safe.message, secretValues) }
  }
  return { code: 'DSH_TURN_FAILED', message: boundedSafeMessage(safe.message, secretValues) }
}

function observeInitialize(
  harness: DeepSeekHarness,
  secretValues: readonly string[] = [],
): { current: () => InitializeDiagnostic } {
  const client = harness.client
  const originalInitialize = client.initialize.bind(client)
  let diagnostic: InitializeDiagnostic = { success: false }

  client.initialize = async (params: InitializeParams): Promise<InitializeResult> => {
    try {
      const result = await originalInitialize(params)
      diagnostic = {
        success: true,
        serverInfo: {
          name: redactSecretLike(result.serverInfo.name, secretValues),
          version: redactSecretLike(result.serverInfo.version, secretValues),
        },
      }
      return result
    } catch (error) {
      diagnostic = { success: false, error: safeError(error, secretValues) }
      throw error
    }
  }

  return { current: () => diagnostic }
}

function diagnosticOutput(diagnostic: RunDiagnostic): DshDelegateOutput['diagnostics'] {
  const failureClassification = diagnostic.failureClassification === undefined
    ? undefined
    : exactClassification(diagnostic.failureClassification) ?? diagnostic.failureClassification
  return {
    failureClassification: failureClassification === undefined
      ? undefined
      : safeCode(failureClassification),
    providerOutcome: diagnostic.providerOutcome,
    eventsCount: diagnostic.eventsCount,
    notificationsCount: diagnostic.notificationsCount,
    assistantMessageEvents: diagnostic.assistantMessageEvents,
    toolCalls: diagnostic.eventCounts['tool/call'] ?? 0,
    toolResults: diagnostic.eventCounts['tool/result'] ?? 0,
  }
}

function boundedResponse(
  value: string,
  secretValues: readonly string[] = [],
): { value: string; length: number; truncated: boolean } {
  const redacted = redactSecretLike(value, secretValues)
  if (redacted.length <= MAX_DELEGATE_RESPONSE_CHARS) {
    return { value: redacted, length: redacted.length, truncated: false }
  }
  return {
    value: `${redacted.slice(0, MAX_DELEGATE_RESPONSE_CHARS)}…`,
    length: redacted.length,
    truncated: true,
  }
}

function delegateErrorResult(
  sessionId: string,
  cwd: string,
  startedAt: number,
  error: BridgeError,
  secretValues: readonly string[] = [],
): DshDelegateOutput {
  return {
    ok: false,
    status: 'error',
    sessionId,
    cwd: redactSecretLike(cwd, secretValues),
    durationMs: Math.max(0, Date.now() - startedAt),
    finalResponse: '',
    finalResponseLength: 0,
    finalResponseTruncated: false,
    error: {
      code: safeCode(error.code, secretValues),
      message: boundedSafeMessage(error.message, secretValues),
    },
  }
}

function runtimeSpecFor(cwd: string, provider: string, model: string): RuntimeSpec {
  return {
    key: JSON.stringify([cwd, provider, model]),
    cwd,
    provider,
    model,
  }
}

async function canonicalWorkspaceIdentity(cwd: string): Promise<string> {
  let canonical = cwd
  try {
    canonical = await realpath(cwd)
  } catch {
    // The caller already performed stat(); retain the normalized path if a
    // platform-specific realpath provider is unavailable.
  }
  const normalized = canonical.replace(/[\\/]+/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function parallelWorkerResult(
  index: number,
  output: DshDelegateOutput,
): DshParallelWorkerResult {
  return {
    index,
    ok: output.ok,
    status: output.status,
    sessionId: output.sessionId,
    cwd: output.cwd,
    durationMs: output.durationMs,
    finalResponse: output.finalResponse,
    finalResponseLength: output.finalResponseLength,
    finalResponseTruncated: output.finalResponseTruncated,
    ...(output.diagnostics === undefined ? {} : { diagnostics: output.diagnostics }),
    ...(output.error === undefined ? {} : { error: output.error }),
  }
}

function parallelBatchError(
  error: BridgeError,
  secretValues: readonly string[] = [],
): DshParallelOutput {
  return {
    ok: false,
    results: [],
    aggregateResponseLength: 0,
    aggregateResponseTruncated: false,
    error: {
      code: safeCode(error.code, secretValues),
      message: boundedSafeMessage(error.message, secretValues),
    },
  }
}

function serializedParallelOutput(
  results: readonly DshParallelWorkerResult[],
  aggregateResponseLength: number,
  aggregateResponseTruncated: boolean,
): string {
  return JSON.stringify({
    ok: true,
    results,
    aggregateResponseLength,
    aggregateResponseTruncated,
  })
}

function boundedParallelOutput(results: DshParallelWorkerResult[]): DshParallelOutput {
  const aggregateResponseLength = serializedParallelOutput(results, 0, false).length
  if (aggregateResponseLength <= MAX_PARALLEL_AGGREGATE_RESPONSE_CHARS) {
    return {
      ok: true,
      results,
      aggregateResponseLength,
      aggregateResponseTruncated: false,
    }
  }

  const bounded = results.map((result) => ({ ...result }))
  let serialized = serializedParallelOutput(
    bounded,
    aggregateResponseLength,
    true,
  )
  let changed = true
  while (serialized.length > MAX_PARALLEL_AGGREGATE_RESPONSE_CHARS && changed) {
    const targetIndex = bounded.reduce((bestIndex, result, index) => (
      bestIndex < 0 || result.finalResponse.length > bounded[bestIndex].finalResponse.length
        ? index
        : bestIndex
    ), -1)
    if (targetIndex < 0 || bounded[targetIndex].finalResponse.length === 0) break

    const current = bounded[targetIndex].finalResponse
    let low = 0
    let high = current.length
    let best = -1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = bounded.map((result, index) => index === targetIndex
        ? {
            ...result,
            finalResponse: `${current.slice(0, middle)}${middle < current.length ? '…' : ''}`,
            finalResponseTruncated: true,
          }
        : result)
      const candidateSerialized = serializedParallelOutput(candidate, aggregateResponseLength, true)
      if (candidateSerialized.length <= MAX_PARALLEL_AGGREGATE_RESPONSE_CHARS) {
        best = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }

    const nextValue = best < 0 ? '' : `${current.slice(0, best)}${best < current.length ? '…' : ''}`
    changed = nextValue !== current
    bounded[targetIndex].finalResponse = nextValue
    bounded[targetIndex].finalResponseTruncated = true
    serialized = serializedParallelOutput(bounded, aggregateResponseLength, true)
  }

  return {
    ok: true,
    results: bounded,
    aggregateResponseLength,
    aggregateResponseTruncated: true,
  }
}

function parallelToolResult(output: DshParallelOutput) {
  const summary = {
    ok: output.ok,
    results: output.results.map((result) => ({
      index: result.index,
      ok: result.ok,
      status: result.status,
      sessionId: result.sessionId,
      ...(result.error === undefined ? {} : { error: result.error }),
    })),
    aggregateResponseLength: output.aggregateResponseLength,
    aggregateResponseTruncated: output.aggregateResponseTruncated,
    ...(output.error === undefined ? {} : { error: output.error }),
  }
  return {
    // The full bounded responses remain available once in structuredContent;
    // text content is a compact index to avoid duplicating large worker text.
    content: [{ type: 'text' as const, text: JSON.stringify(summary) }],
    structuredContent: output,
    ...(output.ok ? {} : { isError: true }),
  }
}

function hasCredential(environment: NodeJS.ProcessEnv, options: Phase0Options): boolean {
  const references = new Set([options.credentialRef])
  if (options.profile === 'opencode-go') {
    references.add('OPENCODE_API_KEY')
    references.add('OPENCODE_GO_API_KEY')
  }
  return [...references].some((reference) => {
    const value = environment[reference]
    return typeof value === 'string' && value.trim().length > 0
  })
}

function toolResult<T extends Record<string, unknown>>(output: T, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    structuredContent: output,
    ...(isError ? { isError: true } : {}),
  }
}

export class Phase1McpBridge {
  private readonly environment: NodeJS.ProcessEnv
  private readonly baseDirectory: string
  private options: Phase0Options | undefined
  private launch: RuntimeLaunchConfig | undefined
  private configError: BridgeError | undefined
  private readonly gate = new RuntimeRunGate()
  private readonly sessions = new SessionRegistry()
  private readonly pool: RuntimePool
  private readonly parallelSemaphore: ParallelSemaphore
  private activeHarness: DeepSeekHarness | undefined
  private closeTask: Promise<void> | undefined
  private closed = false

  constructor(environment: NodeJS.ProcessEnv = process.env, baseDirectory = projectRoot) {
    this.environment = { ...environment }
    this.baseDirectory = baseDirectory

    try {
      const options = loadPhase0Options(this.environment, this.baseDirectory)
      const launchEnvironment = this.environment.DSH_MCP_CORDIS_CONFIG?.trim()
        ? this.environment
        : { ...this.environment, DSH_MCP_CORDIS_CONFIG: options.cordisConfig }
      const launch = loadRuntimeLaunchConfig(launchEnvironment, this.baseDirectory)
      this.options = options
      this.launch = launch
    } catch (error) {
      this.configError = errorFrom(error, secretValuesFromEnvironment(this.environment))
      try {
        this.options = loadPhase0Options(this.environment, this.baseDirectory)
      } catch {
        this.options = undefined
      }
    }

    this.pool = new RuntimePool({
      idleTtlMs: this.launch?.idleTtlMs ?? DEFAULT_RUNTIME_IDLE_TTL_MS,
      createRuntime: (spec) => this.createRuntime(spec),
      onRuntimeClosed: (runtime) => {
        this.sessions.expireRuntime(runtime.key)
      },
    })
    this.parallelSemaphore = new ParallelSemaphore(
      this.launch?.maxParallel ?? DEFAULT_MAX_PARALLEL,
    )
  }

  private redactionSecrets(): string[] {
    return secretValuesFromEnvironment(
      { ...this.environment, ...(this.launch?.env ?? {}) },
      this.options?.credentialRef,
    )
  }

  redactionSecretsForDiagnostics(): readonly string[] {
    return this.redactionSecrets()
  }

  private async createRuntime(spec: RuntimeSpec): Promise<RuntimeResource> {
    const options = this.options
    const launch = this.launch
    const secretValues = this.redactionSecrets()
    if (options === undefined || launch === undefined) {
      throw new Phase1InputError('RUNTIME_NOT_CONFIGURED', 'DSH runtime is not configured')
    }

    const sessionRoot = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase2-'))
    let harness: DeepSeekHarness | undefined
    try {
      if (this.closed) throw new Phase1InputError('BRIDGE_CLOSED', 'The MCP bridge is shutting down')
      const childEnvironment = {
        ...(launch.env ?? process.env),
        DSH_CWD: spec.cwd,
        DSH_SESSION_ROOT: sessionRoot,
      }
      harness = new DeepSeekHarness({
        launch: {
          ...launch,
          env: childEnvironment,
          requestTimeoutMs: launch.requestTimeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS,
        },
        cwd: spec.cwd,
        provider: spec.provider,
        model: spec.model,
        maxTokens: options.maxTokens,
      })
      const initialize = observeInitialize(harness, secretValues)
      let disposed = false
      return {
        harness,
        initialize,
        dispose: async () => {
          if (disposed) return
          disposed = true
          let cleanupError: unknown
          try {
            await harness?.close()
          } catch (error) {
            cleanupError = error
          } finally {
            try {
              await rm(sessionRoot, { recursive: true, force: true })
            } catch (error) {
              cleanupError ??= error
            }
          }
          if (cleanupError !== undefined) throw cleanupError
        },
      }
    } catch (error) {
      if (harness !== undefined) await harness.close().catch(() => {})
      await rm(sessionRoot, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  async health(): Promise<DshHealthOutput> {
    const options = this.options
    const secretValues = this.redactionSecrets()
    const runtimeConfigured = this.launch !== undefined
    const providerConfigured = options !== undefined
      && options.provider.trim().length > 0
      && options.model.trim().length > 0
    const credentialEnvironment = {
      ...this.environment,
      ...(this.launch?.env ?? {}),
    }
    const credentialConfigured = options !== undefined
      && hasCredential(credentialEnvironment, options)
    let runtimeReady = false
    let runtimeReadiness: ReadinessState = runtimeConfigured ? 'unverified' : 'unavailable'
    let providerReady = false
    let providerReadiness: ReadinessState = providerConfigured && credentialConfigured
      ? 'unverified'
      : 'unavailable'
    let healthError: BridgeError | undefined = this.configError

    if (this.closed) {
      runtimeReadiness = 'unavailable'
      providerReadiness = 'unavailable'
      healthError = { code: 'BRIDGE_CLOSED', message: 'The MCP bridge is shutting down' }
    } else if (healthError === undefined && options !== undefined && this.launch !== undefined) {
      const launch = this.launch
      let initialize: { current: () => InitializeDiagnostic } = {
        current: () => ({ success: false }),
      }
      let probeError: unknown
      let cleanupFailed = false

      try {
        await this.gate.runExclusive(async () => {
          let sessionRoot: string | undefined
          let harness: DeepSeekHarness | undefined
          let cleanupError: unknown

          try {
            if (this.closed) {
              throw new Phase1InputError('BRIDGE_CLOSED', 'The MCP bridge is shutting down')
            }
            sessionRoot = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-health-'))
            if (this.closed) {
              throw new Phase1InputError('BRIDGE_CLOSED', 'The MCP bridge is shutting down')
            }
            const childEnvironment = {
              ...(launch.env ?? process.env),
              DSH_CWD: this.baseDirectory,
              DSH_SESSION_ROOT: sessionRoot,
            }
            harness = new DeepSeekHarness({
              launch: {
                ...launch,
                env: childEnvironment,
                requestTimeoutMs: Math.min(
                  launch.requestTimeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS,
                  DEFAULT_HEALTH_TIMEOUT_MS,
                ),
              },
              cwd: this.baseDirectory,
              provider: options.provider,
              model: options.model,
              maxTokens: options.maxTokens,
            })
            this.activeHarness = harness
            initialize = observeInitialize(harness, secretValues)
            await harness.start()
            runtimeReady = initialize.current().success
            runtimeReadiness = runtimeReady ? 'verified' : 'unavailable'
            if (runtimeReady && providerConfigured && credentialConfigured) {
              const healthRun = await withDeadline(
                harness.run(HEALTH_PROBE_TASK, { sessionId: 'dsh-phase1-health' }),
                Math.min(
                  launch.requestTimeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS,
                  DEFAULT_HEALTH_TIMEOUT_MS,
                ),
                'DSH provider health probe',
              )
              const healthDiagnostic = summarizeRunResult(healthRun, {
                provider: options.provider,
                model: options.model,
                initialize: initialize.current(),
                secretValues,
              })
              if (healthDiagnostic.failureClassification !== undefined) {
                throw healthProbeFailure(healthDiagnostic)
              }
              if (
                !healthDiagnostic.finalResponse.nonEmpty
                || healthRun.finalResponse.trim() !== 'DSH_MCP_HEALTH_OK'
              ) {
                throw healthProbeFailure({
                  ...healthDiagnostic,
                  failureClassification: 'PROVIDER_PROBE_FAILED',
                })
              }
              providerReady = true
              providerReadiness = 'verified'
            } else {
              providerReady = false
              providerReadiness = 'unavailable'
            }
          } catch (error) {
            probeError = error
          } finally {
            if (harness !== undefined) {
              try {
                await harness.close()
              } catch (error) {
                cleanupFailed = true
                cleanupError = error
              }
            }
            if (this.activeHarness === harness) this.activeHarness = undefined
            if (sessionRoot !== undefined) {
              try {
                await rm(sessionRoot, { recursive: true, force: true })
              } catch (error) {
                cleanupFailed = true
                cleanupError ??= error
              }
            }
          }

          if (probeError === undefined && cleanupError !== undefined) probeError = cleanupError
        })
      } catch (error) {
        probeError ??= error
      }

      if (probeError !== undefined) {
        const busy = probeError instanceof RuntimeBusyError
        const initializeSucceeded = initialize.current().success
        const runtimeDied = probeError instanceof TransportClosedError && !this.closed
        runtimeReady = cleanupFailed || runtimeDied ? false : initializeSucceeded
        runtimeReadiness = cleanupFailed
          ? 'unavailable'
          : runtimeDied
            ? 'unavailable'
          : initializeSucceeded
            ? 'verified'
            : busy
              ? 'unverified'
              : 'unavailable'
        providerReady = false
        providerReadiness = !cleanupFailed
          && !runtimeDied
          && busy
          && providerConfigured
          && credentialConfigured
          ? 'unverified'
          : 'unavailable'
        healthError = classifyThrownError(
          probeError,
          initialize.current(),
          secretValues,
          this.closed,
        )
      }
    }

    const error = healthError === undefined
      ? undefined
      : {
          code: safeCode(healthError.code, secretValues),
          message: boundedSafeMessage(healthError.message, secretValues),
        }

    return {
      ok: runtimeReady && providerReady,
      bridgeVersion: PHASE3_VERSION,
      nodeVersion: process.version,
      platform: process.platform,
      arch: arch(),
      runtimeConfigured,
      runtimeReady,
      runtimeReadiness,
      provider: boundedSafeMessage(options?.provider ?? 'unconfigured', secretValues),
      model: boundedSafeMessage(options?.model ?? 'unconfigured', secretValues),
      providerConfigured,
      providerReady,
      providerReadiness,
      credentialConfigured,
      ...(error === undefined ? {} : { error }),
    }
  }

  private async executeSession(
    runtime: RuntimeHandle,
    task: string,
    sessionId: string,
    cwd: string,
    startedAt: number,
  ): Promise<{ output: DshDelegateOutput; terminal: boolean }> {
    const secretValues = this.redactionSecrets()
    const requestTimeoutMs = this.launch?.requestTimeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS

    try {
      const runResult: RunResult = await withDeadline(
        runtime.harness.session(sessionId).run(task),
        requestTimeoutMs,
        'DSH delegation',
      )
      const diagnostic = summarizeRunResult(runResult, {
        provider: runtime.provider,
        model: runtime.model,
        initialize: runtime.initialize.current(),
        secretValues,
      })
      const diagnostics = diagnosticOutput(diagnostic)
      const response = boundedResponse(runResult.finalResponse, secretValues)

      if (diagnostic.failureClassification !== undefined) {
        const failureClassification = exactClassification(diagnostic.failureClassification)
          ?? diagnostic.failureClassification
        const reason = diagnostic.turnEndReasons.find((item) => item.errorMessage !== undefined)
        return {
          terminal: false,
          output: {
            ok: false,
            status: 'error',
            sessionId,
            cwd: redactSecretLike(cwd, secretValues),
            durationMs: Math.max(0, Date.now() - startedAt),
            finalResponse: response.value,
            finalResponseLength: response.length,
            finalResponseTruncated: response.truncated,
            diagnostics,
            error: {
              code: safeCode(failureClassification, secretValues),
              message: boundedSafeMessage(
                reason?.errorMessage ?? `DSH turn failed with ${failureClassification}`,
                secretValues,
              ),
            },
          },
        }
      }

      return {
        terminal: false,
        output: {
          ok: true,
          status: 'completed',
          sessionId,
          cwd: redactSecretLike(cwd, secretValues),
          durationMs: Math.max(0, Date.now() - startedAt),
          finalResponse: response.value,
          finalResponseLength: response.length,
          finalResponseTruncated: response.truncated,
          diagnostics,
        },
      }
    } catch (error) {
      const bridgeError = classifyThrownError(
        error,
        runtime.initialize.current(),
        secretValues,
        this.closed,
      )
      return {
        terminal: TERMINAL_RUNTIME_CODES.has(bridgeError.code),
        output: delegateErrorResult(sessionId, cwd, startedAt, bridgeError, secretValues),
      }
    }
  }

  private async runSession(
    lease: RuntimeLease,
    sessionId: string,
    task: string,
    cwd: string,
    startedAt: number,
  ): Promise<DshDelegateOutput> {
    const secretValues = this.redactionSecrets()
    let execution: { output: DshDelegateOutput; terminal: boolean }
    try {
      execution = await this.pool.runExclusive(lease, async (runtime) => {
        this.sessions.markRunning(sessionId)
        const result = await this.executeSession(runtime, task, sessionId, cwd, startedAt)
        if (!result.terminal) this.sessions.markIdle(sessionId)
        return result
      })
    } catch (error) {
      const bridgeError = error instanceof RuntimePoolClosedError
        ? { code: 'BRIDGE_CLOSED', message: 'The MCP bridge is shutting down' }
        : classifyThrownError(error, lease.runtime.initialize.current(), secretValues, this.closed)
      if (bridgeError.code !== 'RUNTIME_BUSY') this.sessions.markExpired(sessionId)
      return delegateErrorResult(sessionId, cwd, startedAt, bridgeError, secretValues)
    }

    if (execution.terminal) {
      try {
        await this.pool.closeRuntime(lease.runtime)
      } catch (error) {
        return delegateErrorResult(
          sessionId,
          cwd,
          startedAt,
          {
            code: 'RUNTIME_CLEANUP_FAILED',
            message: boundedSafeMessage(safeError(error, secretValues).message, secretValues),
          },
          secretValues,
        )
      }
    }
    return execution.output
  }

  private async startSession(
    spec: RuntimeSpec,
    sessionId: string,
    task: string,
    cwd: string,
    startedAt: number,
  ): Promise<DshDelegateOutput> {
    const secretValues = this.redactionSecrets()
    let lease: RuntimeLease
    try {
      lease = await this.pool.acquire(spec)
    } catch (error) {
      const bridgeError = error instanceof RuntimePoolClosedError
        ? { code: 'BRIDGE_CLOSED', message: 'The MCP bridge is shutting down' }
        : classifyThrownError(error, { success: false }, secretValues, this.closed)
      return delegateErrorResult(sessionId, cwd, startedAt, bridgeError, secretValues)
    }

    if (!lease.owner) {
      return delegateErrorResult(
        sessionId,
        cwd,
        startedAt,
        { code: 'RUNTIME_BUSY', message: 'The DSH runtime already has an active delegation' },
        secretValues,
      )
    }

    this.sessions.create(sessionId, lease.runtime.key, cwd)
    this.pool.attachSession(lease, sessionId)
    return this.runSession(lease, sessionId, task, cwd, startedAt)
  }

  async delegate(input: DshDelegateInput): Promise<DshDelegateOutput> {
    const startedAt = Date.now()
    const sessionId = `dsh-phase2-${randomUUID()}`
    const secretValues = this.redactionSecrets()
    const requestedCwd = redactSecretLike(input.cwd, secretValues)

    let cwd: string
    try {
      if (!isAbsolute(input.cwd)) {
        throw new Phase1InputError('INVALID_CWD', 'cwd must be an absolute path')
      }
      cwd = resolve(input.cwd)
      const details = await stat(cwd)
      if (!details.isDirectory()) {
        throw new Phase1InputError('INVALID_CWD', 'cwd must point to a directory')
      }
    } catch (error) {
      const bridgeError = error instanceof Phase1InputError
        ? errorFrom(error, secretValues)
        : { code: 'INVALID_CWD', message: 'cwd does not exist or is not accessible' }
      return delegateErrorResult(sessionId, requestedCwd, startedAt, bridgeError, secretValues)
    }

    if (this.closed) {
      return delegateErrorResult(
        sessionId,
        cwd,
        startedAt,
        { code: 'BRIDGE_CLOSED', message: 'The MCP bridge is shutting down' },
        secretValues,
      )
    }
    if (this.configError !== undefined || this.options === undefined || this.launch === undefined) {
      return delegateErrorResult(
        sessionId,
        cwd,
        startedAt,
        this.configError ?? { code: 'RUNTIME_NOT_CONFIGURED', message: 'DSH runtime is not configured' },
        secretValues,
      )
    }

    try {
      return await this.gate.runExclusive(async () => {
        const options = this.options as Phase0Options
        return this.startSession(
          runtimeSpecFor(cwd, options.provider, options.model),
          sessionId,
          input.task,
          cwd,
          startedAt,
        )
      })
    } catch (error) {
      return delegateErrorResult(
        sessionId,
        cwd,
        startedAt,
        classifyThrownError(error, { success: false }, secretValues, this.closed),
        secretValues,
      )
    }
  }

  async parallel(input: DshParallelInput): Promise<DshParallelOutput> {
    const secretValues = this.redactionSecrets()
    if (this.closed) {
      return parallelBatchError(
        { code: 'BRIDGE_CLOSED', message: 'The MCP bridge is shutting down' },
        secretValues,
      )
    }
    if (this.configError !== undefined || this.options === undefined || this.launch === undefined) {
      return parallelBatchError(
        this.configError ?? { code: 'RUNTIME_NOT_CONFIGURED', message: 'DSH runtime is not configured' },
        secretValues,
      )
    }

    const options = this.options
    const prepared: Array<{
      index: number
      task: DshParallelInput['tasks'][number]
      cwd: string
      sessionId: string
      startedAt: number
    }> = []
    const preflightResults = new Map<number, DshParallelWorkerResult>()
    const identities = new Map<string, number>()

    for (const [index, task] of input.tasks.entries()) {
      const startedAt = Date.now()
      const sessionId = `dsh-phase3-${randomUUID()}`
      const requestedCwd = redactSecretLike(task.cwd, secretValues)
      try {
        if (!isAbsolute(task.cwd)) {
          throw new Phase1InputError('INVALID_CWD', 'cwd must be an absolute path')
        }
        const cwd = resolve(task.cwd)
        const details = await stat(cwd)
        if (!details.isDirectory()) {
          throw new Phase1InputError('INVALID_CWD', 'cwd must point to a directory')
        }
        const identity = await canonicalWorkspaceIdentity(cwd)
        const previousIndex = identities.get(identity)
        if (previousIndex !== undefined) {
          return parallelBatchError(
            {
              code: 'SHARED_WORKSPACE',
              message: `Parallel workers ${previousIndex} and ${index} target the same normalized workspace`,
            },
            secretValues,
          )
        }
        identities.set(identity, index)
        prepared.push({
          index,
          task,
          cwd,
          sessionId,
          startedAt,
        })
      } catch (error) {
        const bridgeError = error instanceof Phase1InputError
          ? errorFrom(error, secretValues)
          : { code: 'INVALID_CWD', message: 'cwd does not exist or is not accessible' }
        preflightResults.set(
          index,
          parallelWorkerResult(
            index,
            delegateErrorResult(sessionId, requestedCwd, startedAt, bridgeError, secretValues),
          ),
        )
      }
    }

    const completed = await Promise.all(prepared.map(async (worker) => {
      try {
        const output = await this.parallelSemaphore.run(() => this.startSession(
          runtimeSpecFor(worker.cwd, options.provider, options.model),
          worker.sessionId,
          worker.task.task,
          worker.cwd,
          worker.startedAt,
        ))
        return parallelWorkerResult(worker.index, output)
      } catch (error) {
        const bridgeError = error instanceof ParallelSemaphoreClosedError
          ? { code: 'BRIDGE_CLOSED', message: 'The MCP bridge is shutting down' }
          : classifyThrownError(error, { success: false }, secretValues, this.closed)
        return parallelWorkerResult(
          worker.index,
          delegateErrorResult(worker.sessionId, worker.cwd, worker.startedAt, bridgeError, secretValues),
        )
      }
    }))
    for (const result of completed) preflightResults.set(result.index, result)

    const results = input.tasks.map((_, index) => preflightResults.get(index) as DshParallelWorkerResult)
    return boundedParallelOutput(results)
  }

  async continue(input: DshContinueInput): Promise<DshDelegateOutput> {
    const startedAt = Date.now()
    const secretValues = this.redactionSecrets()
    const requestedSessionId = redactSecretLike(input.sessionId, secretValues)
    const record = this.sessions.get(input.sessionId)

    if (record === undefined) {
      return delegateErrorResult(
        requestedSessionId,
        '',
        startedAt,
        { code: 'SESSION_NOT_FOUND', message: 'The requested DSH session does not exist' },
        secretValues,
      )
    }
    if (record.state === 'expired') {
      return delegateErrorResult(
        record.sessionId,
        record.cwd,
        startedAt,
        { code: 'SESSION_NOT_ACTIVE', message: 'The requested DSH session is no longer active' },
        secretValues,
      )
    }
    if (record.state === 'running') {
      return delegateErrorResult(
        record.sessionId,
        record.cwd,
        startedAt,
        { code: 'RUNTIME_BUSY', message: 'The DSH runtime already has an active delegation' },
        secretValues,
      )
    }
    if (this.closed) {
      return delegateErrorResult(
        record.sessionId,
        record.cwd,
        startedAt,
        { code: 'BRIDGE_CLOSED', message: 'The MCP bridge is shutting down' },
        secretValues,
      )
    }

    try {
      const details = await stat(record.cwd)
      if (!details.isDirectory()) throw new Error('not a directory')
    } catch {
      this.sessions.markExpired(record.sessionId)
      return delegateErrorResult(
        record.sessionId,
        record.cwd,
        startedAt,
        { code: 'INVALID_CWD', message: 'The session workspace no longer exists or is not accessible' },
        secretValues,
      )
    }

    try {
      return await this.gate.runExclusive(async () => {
        const current = this.sessions.get(record.sessionId)
        if (current === undefined || current.state === 'expired') {
          throw new Phase1InputError(
            'SESSION_NOT_ACTIVE',
            'The requested DSH session is no longer active',
          )
        }
        if (current.state === 'running') throw new RuntimeBusyError()
        const lease = this.pool.acquireExisting(current.runtimeKey)
        if (lease === undefined) {
          this.sessions.markExpired(current.sessionId)
          throw new Phase1InputError(
            'SESSION_NOT_ACTIVE',
            'The requested DSH session is no longer restorable',
          )
        }
        return this.runSession(lease, current.sessionId, input.task, current.cwd, startedAt)
      })
    } catch (error) {
      return delegateErrorResult(
        record.sessionId,
        record.cwd,
        startedAt,
        classifyThrownError(error, { success: true }, secretValues, this.closed),
        secretValues,
      )
    }
  }

  async status(input: DshStatusInput): Promise<DshSessionStatusOutput> {
    const secretValues = this.redactionSecrets()
    let snapshot = this.sessions.status(input.sessionId)
    if (snapshot.status === 'idle'
      && snapshot.runtimeKey !== undefined
      && !this.pool.hasRuntime(snapshot.runtimeKey)) {
      this.sessions.markExpired(input.sessionId)
      snapshot = this.sessions.status(input.sessionId)
    }

    const output: DshSessionStatusOutput = {
      ok: snapshot.status === 'running' || snapshot.status === 'idle',
      status: snapshot.status,
      sessionId: redactSecretLike(snapshot.sessionId, secretValues),
      ...(snapshot.cwd === undefined
        ? {}
        : { cwd: redactSecretLike(snapshot.cwd, secretValues) }),
    }
    if (snapshot.status === 'missing') {
      output.error = {
        code: 'SESSION_NOT_FOUND',
        message: 'The requested DSH session does not exist',
      }
    } else if (snapshot.status === 'expired') {
      output.error = {
        code: 'SESSION_NOT_ACTIVE',
        message: 'The requested DSH session is no longer active',
      }
    }
    return output
  }

  async close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask
    this.closed = true
    this.parallelSemaphore.close()
    this.closeTask = (async () => {
      const activeHarness = this.activeHarness
      const results = await Promise.allSettled([
        this.pool.close(),
        activeHarness === undefined ? Promise.resolve() : activeHarness.close(),
      ])
      await this.gate.waitForIdle()
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (failure !== undefined && !(failure.reason instanceof RuntimePoolClosedError)) {
        throw failure.reason
      }
    })()
    return this.closeTask
  }
}

export function createMcpServer(bridge = new Phase1McpBridge()): McpServer {
  const server = new McpServer({
    name: 'dsh-sdk-mcp-server',
    version: PHASE3_VERSION,
  })

  server.registerTool(
    'dsh_health',
    {
      title: 'DSH Health',
      description: 'Report DSH runtime and provider readiness without exposing credential values.',
      inputSchema: z.object({}).strict().default({}),
      outputSchema: HealthOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => toolResult(await bridge.health()),
  )

  server.registerTool(
    'dsh_delegate',
    {
      title: 'Delegate to DSH',
      description: 'Run one DSH agent turn in an existing absolute workspace path and return a structured result.',
      inputSchema: DelegateInputSchema,
      outputSchema: DelegateOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const output = await bridge.delegate(input)
      return toolResult(output, !output.ok)
    },
  )

  server.registerTool(
    'dsh_continue',
    {
      title: 'Continue DSH Session',
      description: 'Continue an existing active DSH session by stable sessionId. Returns SESSION_NOT_ACTIVE when the runtime is no longer restorable.',
      inputSchema: ContinueInputSchema,
      outputSchema: DelegateOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const output = await bridge.continue(input)
      return toolResult(output, !output.ok)
    },
  )

  server.registerTool(
    'dsh_status',
    {
      title: 'DSH Session Status',
      description: 'Report only coarse DSH session state: running, idle, expired, or missing.',
      inputSchema: StatusInputSchema,
      outputSchema: SessionStatusOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const output = await bridge.status(input)
      return toolResult(output, !output.ok)
    },
  )

  server.registerTool(
    'dsh_parallel',
    {
      title: 'Parallel DSH Workers',
      description: 'Run bounded independent DSH workers concurrently in disjoint normalized workspaces. Results stay in input order and each successful worker returns a continuable sessionId.',
      inputSchema: ParallelInputSchema,
      outputSchema: ParallelOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => parallelToolResult(await bridge.parallel(input)),
  )

  return server
}

function writeDiagnostic(
  message: string,
  error?: unknown,
  secretValues: readonly string[] = [],
): void {
  const detail = error === undefined
    ? ''
    : `: ${boundedSafeMessage(safeError(error, secretValues).message, secretValues)}`
  process.stderr.write(`[dsh-sdk-mcp] ${boundedSafeMessage(message, secretValues)}${detail}\n`)
}

export async function runMcpServer(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const bridge = new Phase1McpBridge(environment, projectRoot)
  const server = createMcpServer(bridge)
  const transport = new StdioServerTransport()
  const secretValues = bridge.redactionSecretsForDiagnostics()
  let closeTask: Promise<void> | undefined

  const close = (): Promise<void> => {
    if (closeTask !== undefined) return closeTask
    closeTask = (async () => {
      let bridgeError: unknown
      try {
        await bridge.close()
      } catch (error) {
        bridgeError = error
      } finally {
        await server.close()
      }
      if (bridgeError !== undefined) throw bridgeError
    })()
    return closeTask
  }
  const onSignal = (): void => {
    void close().catch((error) => writeDiagnostic('shutdown failed', error, secretValues))
  }
  const onStdinClosed = (): void => {
    void close().catch((error) => writeDiagnostic('stdin shutdown failed', error, secretValues))
  }

  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  process.stdin.once('end', onStdinClosed)
  process.stdin.once('close', onStdinClosed)
  transport.onerror = (error) => writeDiagnostic('MCP transport error', error, secretValues)
  transport.onclose = () => {
    void close().catch((error) => writeDiagnostic('transport shutdown failed', error, secretValues))
  }

  try {
    await server.connect(transport)
  } catch (error) {
    await close().catch((closeError) => writeDiagnostic(
      'shutdown after startup failure failed',
      closeError,
      secretValues,
    ))
    throw error
  }
}

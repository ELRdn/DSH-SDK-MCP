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
import { packageVersionFromRoot, safeError } from './report.js'
import { createDeepSeekHarness } from './sdk-runtime.js'
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
import { WorktreeError, WorktreeManager, type GitRepositoryInfo, type WorktreeInspection, type WorktreeRecord } from './worktree-manager.js'
import { IntegrationManager, type IntegrationResult, type WorktreeGitMetadata } from './integration-manager.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const PHASE3_VERSION = '0.3.0-phase3'
/** Kept as export aliases for earlier host integrations. */
export const PHASE2_VERSION = PHASE3_VERSION
export const PHASE1_VERSION = PHASE3_VERSION
export const PHASE4_VERSION = '0.4.0-phase4'
export const PACKAGE_VERSION = packageVersionFromRoot(projectRoot)
/** Kept as an export alias for earlier host integrations. */
export const PHASE5_VERSION = PACKAGE_VERSION
export const DEFAULT_DELEGATION_TIMEOUT_MS = 900_000
export const DEFAULT_HEALTH_TIMEOUT_MS = 30_000
export const DEFAULT_RUNTIME_IDLE_TTL_MS = 300_000
export const DEFAULT_MAX_PARALLEL = 3
export const MAX_PARALLEL_AGGREGATE_RESPONSE_CHARS = 300_000
export const MAX_DELEGATE_RESPONSE_CHARS = 100_000
export const MAX_INTEGRATION_RESPONSE_CHARS = MAX_PARALLEL_AGGREGATE_RESPONSE_CHARS
const MIN_RUNTIME_INITIALIZE_TIMEOUT_MS = 2_000
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

const WorktreeTaskInputSchema = z.object({
  task: z.string().min(1).max(200_000),
  name: z.string().min(1).max(128).optional(),
}).strict()

const ParallelWorktreeInputSchema = z.object({
  repo: z.string().min(1).max(4_096),
  tasks: z.array(WorktreeTaskInputSchema).min(1).max(MAX_PARALLEL_HARD_LIMIT),
  baseRef: z.string().min(1).max(256).optional(),
}).strict()

const WorktreeCleanupStateSchema = z.enum([
  'not_created',
  'active',
  'removed',
  'preserved_dirty',
  'preserved_error',
])

const ParallelWorktreeWorkerResultSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
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
  worktreeId: z.string(),
  worktreePath: z.string(),
  baseRef: z.string(),
  baseCommit: z.string(),
  branch: z.string().optional(),
  changedFiles: z.array(z.string()),
  changedFilesTruncated: z.boolean(),
  gitStatusSummary: z.string(),
  cleanupState: WorktreeCleanupStateSchema,
  cleanupError: z.object({ code: z.string(), message: z.string() }).optional(),
})

const ParallelWorktreeOutputSchema = z.object({
  ok: z.boolean(),
  repo: z.string(),
  baseRef: z.string(),
  baseCommit: z.string(),
  results: z.array(ParallelWorktreeWorkerResultSchema),
  aggregateResponseLength: z.number().int().nonnegative(),
  aggregateResponseTruncated: z.boolean(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
})

const WorktreeReviewInputSchema = z.object({
  sessionId: z.string().min(1).max(256).optional(),
  worktreeId: z.string().min(1).max(256).optional(),
}).strict()

const WorktreeReviewOutputSchema = z.object({
  ok: z.boolean(),
  worktreeId: z.string(),
  sessionId: z.string().optional(),
  name: z.string(),
  repository: z.string(),
  repositoryIdentity: z.string(),
  commonDir: z.string(),
  worktreePath: z.string(),
  branch: z.string(),
  baseRef: z.string(),
  baseCommit: z.string(),
  currentHead: z.string(),
  cleanupState: WorktreeCleanupStateSchema,
  dirty: z.boolean(),
  clean: z.boolean(),
  stagedCount: z.number().int().nonnegative(),
  unstagedCount: z.number().int().nonnegative(),
  untrackedCount: z.number().int().nonnegative(),
  changedFiles: z.array(z.string()),
  changedFilesTruncated: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  diffSummary: z.string(),
  gitStatusSummary: z.string(),
  conflictMarkers: z.array(z.string()),
  conflictMarkersTruncated: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})

const IntegrationWorkerInputSchema = z.object({
  sessionId: z.string().min(1).max(256),
}).strict()

const IntegrationInputSchema = z.object({
  repo: z.string().min(1).max(4_096),
  workers: z.array(IntegrationWorkerInputSchema).min(1).max(MAX_PARALLEL_HARD_LIMIT),
  baseRef: z.string().min(1).max(256).optional(),
}).strict()

const IntegrationWorkerSchema = z.object({
  sessionId: z.string(),
  worktreeId: z.string(),
  name: z.string(),
  status: z.enum(['applied', 'empty', 'conflict', 'pending']),
  snapshotCommit: z.string(),
})

const SnapshotMetadataSchema = z.object({
  snapshotId: z.string(),
  snapshotCommit: z.string(),
  snapshotTree: z.string(),
  sourceHead: z.string(),
  worktreeId: z.string(),
  sessionId: z.string(),
  name: z.string(),
  changedFiles: z.array(z.string()),
  includedUntrackedFiles: z.array(z.string()),
  excludedUntrackedFiles: z.array(z.string()),
})

const IntegrationOutputSchema = z.object({
  ok: z.boolean(),
  status: z.enum(['applied', 'conflict', 'error']),
  integrationWorktreeId: z.string(),
  integrationWorktreePath: z.string(),
  integrationBranch: z.string(),
  repository: z.string(),
  repositoryIdentity: z.string(),
  commonDir: z.string(),
  baseRef: z.string(),
  baseCommit: z.string(),
  currentHead: z.string(),
  integrationWorktreeDirty: z.boolean(),
  clean: z.boolean(),
  stagedCount: z.number().int().nonnegative(),
  unstagedCount: z.number().int().nonnegative(),
  untrackedCount: z.number().int().nonnegative(),
  changedFiles: z.array(z.string()),
  changedFilesTruncated: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  diffSummary: z.string(),
  gitStatusSummary: z.string(),
  conflictMarkers: z.array(z.string()),
  conflictMarkersTruncated: z.boolean(),
  appliedWorkers: z.array(IntegrationWorkerSchema),
  pendingWorkers: z.array(IntegrationWorkerSchema),
  conflictingWorker: IntegrationWorkerSchema.optional(),
  conflictingFiles: z.array(z.string()),
  snapshotMetadata: z.array(SnapshotMetadataSchema),
  responseLength: z.number().int().nonnegative(),
  responseTruncated: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})

export type DshHealthOutput = z.infer<typeof HealthOutputSchema>
export type DshDelegateInput = z.infer<typeof DelegateInputSchema>
export type DshDelegateOutput = z.infer<typeof DelegateOutputSchema>
export type DshContinueInput = z.infer<typeof ContinueInputSchema>
export type DshStatusInput = z.infer<typeof StatusInputSchema>
export type DshSessionStatusOutput = z.infer<typeof SessionStatusOutputSchema>
export type DshParallelInput = z.infer<typeof ParallelInputSchema>
export type DshParallelOutput = z.infer<typeof ParallelOutputSchema>
export type DshParallelWorktreeInput = z.infer<typeof ParallelWorktreeInputSchema>
export type DshParallelWorktreeOutput = z.infer<typeof ParallelWorktreeOutputSchema>
export type DshParallelWorkerResult = z.infer<typeof ParallelWorkerResultSchema>
export type DshWorktreeReviewInput = z.infer<typeof WorktreeReviewInputSchema>
export type DshWorktreeReviewOutput = z.infer<typeof WorktreeReviewOutputSchema>
export type DshIntegrateInput = z.infer<typeof IntegrationInputSchema>
export type DshIntegrateOutput = z.infer<typeof IntegrationOutputSchema>

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

function worktreeErrorFrom(error: unknown, secretValues: readonly string[] = []): BridgeError {
  if (error instanceof WorktreeError) {
    return { code: safeCode(error.code, secretValues), message: boundedSafeMessage(error.message, secretValues) }
  }
  return errorFrom(error, secretValues)
}
function worktreeBatchError(repo: string, baseRef: string, error: BridgeError, secretValues: readonly string[] = []): DshParallelWorktreeOutput {
  return {
    ok: false,
    repo: redactSecretLike(repo, secretValues),
    baseRef: redactSecretLike(baseRef, secretValues),
    baseCommit: '',
    results: [],
    aggregateResponseLength: 0,
    aggregateResponseTruncated: false,
    error: { code: safeCode(error.code, secretValues), message: boundedSafeMessage(error.message, secretValues) },
  }
}
function emptyWorktreeWorkerResult(index: number, name: string, sessionId: string, repository: GitRepositoryInfo | undefined, error: BridgeError, secretValues: readonly string[] = []): DshParallelWorktreeOutput['results'][number] {
  return {
    index,
    name: redactSecretLike(name, secretValues),
    ok: false,
    status: 'error',
    sessionId: redactSecretLike(sessionId, secretValues),
    cwd: '',
    durationMs: 0,
    finalResponse: '',
    finalResponseLength: 0,
    finalResponseTruncated: false,
    worktreeId: '',
    worktreePath: '',
    baseRef: redactSecretLike(repository?.baseRef ?? '', secretValues),
    baseCommit: redactSecretLike(repository?.baseCommit ?? '', secretValues),
    changedFiles: [],
    changedFilesTruncated: false,
    gitStatusSummary: '',
    cleanupState: 'not_created',
    error: { code: safeCode(error.code, secretValues), message: boundedSafeMessage(error.message, secretValues) },
  }
}
function worktreeWorkerResult(index: number, name: string, output: DshDelegateOutput, record: WorktreeRecord, inspection: WorktreeInspection, secretValues: readonly string[] = []): DshParallelWorktreeOutput['results'][number] {
  return {
    index,
    name: redactSecretLike(name, secretValues),
    ...output,
    worktreeId: redactSecretLike(record.worktreeId, secretValues),
    worktreePath: redactSecretLike(record.path, secretValues),
    baseRef: redactSecretLike(record.repository.baseRef, secretValues),
    baseCommit: redactSecretLike(record.repository.baseCommit, secretValues),
    branch: redactSecretLike(record.branch, secretValues),
    changedFiles: inspection.changedFiles.map((file) => redactSecretLike(file, secretValues)),
    changedFilesTruncated: inspection.changedFilesTruncated,
    gitStatusSummary: redactSecretLike(inspection.gitStatusSummary, secretValues),
    cleanupState: inspection.cleanupState,
    ...(inspection.cleanupError === undefined ? {} : { cleanupError: inspection.cleanupError }),
  }
}
function boundedWorktreeOutput(repo: string, baseRef: string, baseCommit: string, results: DshParallelWorktreeOutput['results']): DshParallelWorktreeOutput {
  const build = (items: readonly DshParallelWorktreeOutput['results'][number][], length: number, truncated: boolean) => JSON.stringify({
    ok: true,
    repo,
    baseRef,
    baseCommit,
    results: items,
    aggregateResponseLength: length,
    aggregateResponseTruncated: truncated,
  })
  const aggregateResponseLength = build(results, 0, false).length
  if (aggregateResponseLength <= MAX_PARALLEL_AGGREGATE_RESPONSE_CHARS) {
    return { ok: true, repo, baseRef, baseCommit, results, aggregateResponseLength, aggregateResponseTruncated: false }
  }
  const bounded = results.map((result) => ({ ...result }))
  let serialized = build(bounded, aggregateResponseLength, true)
  let changed = true
  while (serialized.length > MAX_PARALLEL_AGGREGATE_RESPONSE_CHARS && changed) {
    const targetIndex = bounded.reduce((bestIndex, result, index) => (
      bestIndex < 0 || result.finalResponse.length > bounded[bestIndex].finalResponse.length ? index : bestIndex
    ), -1)
    if (targetIndex < 0 || bounded[targetIndex].finalResponse.length === 0) break
    const current = bounded[targetIndex].finalResponse
    let low = 0
    let high = current.length
    let best = -1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = bounded.map((result, index) => index === targetIndex
        ? { ...result, finalResponse: `${current.slice(0, middle)}${middle < current.length ? '…' : ''}`, finalResponseTruncated: true }
        : result)
      if (build(candidate, aggregateResponseLength, true).length <= MAX_PARALLEL_AGGREGATE_RESPONSE_CHARS) {
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
    serialized = build(bounded, aggregateResponseLength, true)
  }
  return { ok: true, repo, baseRef, baseCommit, results: bounded, aggregateResponseLength, aggregateResponseTruncated: true }
}
function worktreeToolResult(output: DshParallelWorktreeOutput) {
  const summary = {
    ok: output.ok,
    repo: output.repo,
    baseRef: output.baseRef,
    baseCommit: output.baseCommit,
    results: output.results.map((result) => ({
      index: result.index,
      name: result.name,
      ok: result.ok,
      status: result.status,
      sessionId: result.sessionId,
      worktreeId: result.worktreeId,
      worktreePath: result.worktreePath,
      cleanupState: result.cleanupState,
      changedFileCount: result.changedFiles.length,
      changedFilesTruncated: result.changedFilesTruncated,
      ...(result.error === undefined ? {} : { error: result.error }),
    })),
    aggregateResponseLength: output.aggregateResponseLength,
    aggregateResponseTruncated: output.aggregateResponseTruncated,
    ...(output.error === undefined ? {} : { error: output.error }),
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(summary) }],
    structuredContent: output,
    ...(output.ok ? {} : { isError: true }),
  }
}

function emptyReviewOutput(error: BridgeError, secretValues: readonly string[] = []): DshWorktreeReviewOutput {
  return {
    ok: false,
    worktreeId: '',
    name: '',
    repository: '',
    repositoryIdentity: '',
    commonDir: '',
    worktreePath: '',
    branch: '',
    baseRef: '',
    baseCommit: '',
    currentHead: '',
    cleanupState: 'not_created',
    dirty: false,
    clean: true,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    changedFiles: [],
    changedFilesTruncated: false,
    additions: 0,
    deletions: 0,
    diffSummary: '',
    gitStatusSummary: '',
    conflictMarkers: [],
    conflictMarkersTruncated: false,
    error: { code: safeCode(error.code, secretValues), message: boundedSafeMessage(error.message, secretValues) },
  }
}

function reviewOutput(record: WorktreeRecord, metadata: WorktreeGitMetadata, secretValues: readonly string[] = []): DshWorktreeReviewOutput {
  return {
    ok: true,
    worktreeId: redactSecretLike(record.worktreeId, secretValues),
    ...(record.sessionId === undefined ? {} : { sessionId: redactSecretLike(record.sessionId, secretValues) }),
    name: redactSecretLike(record.name, secretValues),
    repository: redactSecretLike(record.repository.root, secretValues),
    repositoryIdentity: redactSecretLike(record.repository.identity, secretValues),
    commonDir: redactSecretLike(record.repository.commonDir, secretValues),
    worktreePath: redactSecretLike(record.path, secretValues),
    branch: redactSecretLike(record.branch, secretValues),
    baseRef: redactSecretLike(record.repository.baseRef, secretValues),
    baseCommit: redactSecretLike(record.repository.baseCommit, secretValues),
    currentHead: redactSecretLike(metadata.currentHead, secretValues),
    cleanupState: record.cleanupState,
    dirty: metadata.dirty,
    clean: !metadata.dirty,
    stagedCount: metadata.stagedCount,
    unstagedCount: metadata.unstagedCount,
    untrackedCount: metadata.untrackedCount,
    changedFiles: metadata.changedFiles.map((file) => redactSecretLike(file, secretValues)),
    changedFilesTruncated: metadata.changedFilesTruncated,
    additions: metadata.additions,
    deletions: metadata.deletions,
    diffSummary: redactSecretLike(metadata.diffSummary, secretValues),
    gitStatusSummary: redactSecretLike(metadata.gitStatusSummary, secretValues),
    conflictMarkers: metadata.conflictMarkers.map((marker) => redactSecretLike(marker, secretValues)),
    conflictMarkersTruncated: metadata.conflictMarkersTruncated,
  }
}

function worktreeReviewToolResult(output: DshWorktreeReviewOutput) {
  const summary = {
    ok: output.ok,
    worktreeId: output.worktreeId,
    ...(output.sessionId === undefined ? {} : { sessionId: output.sessionId }),
    dirty: output.dirty,
    clean: output.clean,
    changedFileCount: output.changedFiles.length,
    stagedCount: output.stagedCount,
    unstagedCount: output.unstagedCount,
    untrackedCount: output.untrackedCount,
    ...(output.error === undefined ? {} : { error: output.error }),
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(summary) }],
    structuredContent: output,
    ...(output.ok ? {} : { isError: true }),
  }
}

function emptyIntegrationOutput(repo: string, baseRef: string, error: BridgeError, secretValues: readonly string[] = []): DshIntegrateOutput {
  return {
    ok: false,
    status: 'error',
    integrationWorktreeId: '',
    integrationWorktreePath: '',
    integrationBranch: '',
    repository: redactSecretLike(repo, secretValues),
    repositoryIdentity: '',
    commonDir: '',
    baseRef: redactSecretLike(baseRef, secretValues),
    baseCommit: '',
    currentHead: '',
    integrationWorktreeDirty: false,
    clean: true,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    changedFiles: [],
    changedFilesTruncated: false,
    additions: 0,
    deletions: 0,
    diffSummary: '',
    gitStatusSummary: '',
    conflictMarkers: [],
    conflictMarkersTruncated: false,
    appliedWorkers: [],
    pendingWorkers: [],
    conflictingFiles: [],
    snapshotMetadata: [],
    responseLength: 0,
    responseTruncated: false,
    error: { code: safeCode(error.code, secretValues), message: boundedSafeMessage(error.message, secretValues) },
  }
}

function clipIntegrationText(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1))}…`
}

function clipIntegrationList(values: readonly string[], limit: number): string[] {
  return values.slice(0, limit).map((value) => clipIntegrationText(value, 256))
}

function boundedIntegrationOutput(output: IntegrationResult): DshIntegrateOutput {
  const responseLength = JSON.stringify(output).length
  const base = { ...output, responseLength, responseTruncated: false } as DshIntegrateOutput
  if (JSON.stringify(base).length <= MAX_INTEGRATION_RESPONSE_CHARS) return base

  const snapshotMetadata = output.snapshotMetadata.map((snapshot) => ({
    ...snapshot,
    changedFiles: clipIntegrationList(snapshot.changedFiles, 4),
    includedUntrackedFiles: clipIntegrationList(snapshot.includedUntrackedFiles, 4),
    excludedUntrackedFiles: clipIntegrationList(snapshot.excludedUntrackedFiles, 4),
  }))
  const bounded: DshIntegrateOutput = {
    ...base,
    responseTruncated: true,
    changedFiles: clipIntegrationList(output.changedFiles, 64),
    changedFilesTruncated: true,
    diffSummary: clipIntegrationText(output.diffSummary, 8_000),
    gitStatusSummary: clipIntegrationText(output.gitStatusSummary, 8_000),
    conflictMarkers: clipIntegrationList(output.conflictMarkers, 16),
    conflictMarkersTruncated: true,
    snapshotMetadata,
  }
  if (JSON.stringify(bounded).length <= MAX_INTEGRATION_RESPONSE_CHARS) return bounded

  bounded.diffSummary = clipIntegrationText(output.diffSummary, 1_024)
  bounded.gitStatusSummary = clipIntegrationText(output.gitStatusSummary, 1_024)
  bounded.changedFiles = clipIntegrationList(output.changedFiles, 16)
  bounded.conflictMarkers = clipIntegrationList(output.conflictMarkers, 4)
  bounded.snapshotMetadata = output.snapshotMetadata.map((snapshot) => ({
    ...snapshot,
    changedFiles: clipIntegrationList(snapshot.changedFiles, 1),
    includedUntrackedFiles: clipIntegrationList(snapshot.includedUntrackedFiles, 1),
    excludedUntrackedFiles: clipIntegrationList(snapshot.excludedUntrackedFiles, 1),
  }))
  if (JSON.stringify(bounded).length <= MAX_INTEGRATION_RESPONSE_CHARS) return bounded

  bounded.diffSummary = ''
  bounded.gitStatusSummary = ''
  bounded.changedFiles = []
  bounded.conflictMarkers = []
  bounded.snapshotMetadata = []
  return bounded
}

function integrationToolResult(output: DshIntegrateOutput) {
  const summary = {
    ok: output.ok,
    status: output.status,
    integrationWorktreeId: output.integrationWorktreeId,
    integrationWorktreePath: output.integrationWorktreePath,
    currentHead: output.currentHead,
    clean: output.clean,
    changedFileCount: output.changedFiles.length,
    responseLength: output.responseLength,
    responseTruncated: output.responseTruncated,
    appliedWorkers: output.appliedWorkers.map((worker) => ({ sessionId: worker.sessionId, status: worker.status })),
    pendingWorkers: output.pendingWorkers.map((worker) => ({ sessionId: worker.sessionId, status: worker.status })),
    conflictingFiles: output.conflictingFiles,
    ...(output.error === undefined ? {} : { error: output.error }),
  }
  return {
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
  private readonly worktrees: WorktreeManager
  private readonly integrationManager: IntegrationManager
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
      onRuntimeClosed: async (runtime) => {
        this.sessions.expireRuntime(runtime.key)
        await this.worktrees.onRuntimeClosed(runtime.sessionIds)
      },
    })
    this.parallelSemaphore = new ParallelSemaphore(
      this.launch?.maxParallel ?? DEFAULT_MAX_PARALLEL,
    )
    this.worktrees = new WorktreeManager({
      secretValues: () => this.redactionSecrets(),
    })
    this.integrationManager = new IntegrationManager(this.worktrees, () => this.redactionSecrets())
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
      harness = createDeepSeekHarness({
        ...launch,
        requestTimeoutMs: launch.requestTimeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS,
      }, {
        cwd: spec.cwd,
        provider: spec.provider,
        model: spec.model,
        maxTokens: options.maxTokens,
        dshHome: join(sessionRoot, 'dsh-home'),
        env: childEnvironment,
        initializeTimeoutMs: Math.max(
          launch.initializeTimeoutMs ?? MIN_RUNTIME_INITIALIZE_TIMEOUT_MS,
          MIN_RUNTIME_INITIALIZE_TIMEOUT_MS,
        ),
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
            const healthTimeoutMs = Math.max(Math.min(
              launch.requestTimeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS,
              DEFAULT_HEALTH_TIMEOUT_MS,
            ), MIN_RUNTIME_INITIALIZE_TIMEOUT_MS)
            harness = createDeepSeekHarness({
              ...launch,
              requestTimeoutMs: healthTimeoutMs,
            }, {
              cwd: this.baseDirectory,
              provider: options.provider,
              model: options.model,
              maxTokens: options.maxTokens,
              dshHome: join(sessionRoot, 'dsh-home'),
              env: childEnvironment,
              initializeTimeoutMs: Math.max(
                launch.initializeTimeoutMs ?? MIN_RUNTIME_INITIALIZE_TIMEOUT_MS,
                MIN_RUNTIME_INITIALIZE_TIMEOUT_MS,
              ),
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
      bridgeVersion: PACKAGE_VERSION,
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

  async parallelWorktree(input: DshParallelWorktreeInput): Promise<DshParallelWorktreeOutput> {
    const secretValues = this.redactionSecrets()
    const requestedBaseRef = input.baseRef?.trim() || 'HEAD'
    if (this.closed) {
      return worktreeBatchError(input.repo, requestedBaseRef, { code: 'BRIDGE_CLOSED', message: 'The MCP bridge is shutting down' }, secretValues)
    }
    if (this.configError !== undefined || this.options === undefined || this.launch === undefined) {
      return worktreeBatchError(input.repo, requestedBaseRef, this.configError ?? { code: 'RUNTIME_NOT_CONFIGURED', message: 'DSH runtime is not configured' }, secretValues)
    }
    let repository: GitRepositoryInfo
    try {
      repository = await this.worktrees.validateRepository(input.repo, requestedBaseRef)
    } catch (error) {
      return worktreeBatchError(input.repo, requestedBaseRef, worktreeErrorFrom(error, secretValues), secretValues)
    }
    const options = this.options
    const completed = await Promise.all(input.tasks.map(async (task, index) => {
      const startedAt = Date.now()
      const sessionId = `dsh-phase4-${randomUUID()}`
      const name = task.name?.trim() || `worker-${index}`
      let record: WorktreeRecord | undefined
      try {
        return await this.parallelSemaphore.run(async () => {
          record = await this.worktrees.create(repository, name)
          this.worktrees.attachSession(record.worktreeId, sessionId)
          const output = await this.startSession(
            runtimeSpecFor(record.path, options.provider, options.model),
            sessionId,
            task.task,
            record.path,
            startedAt,
          )
          if (!output.ok && this.sessions.get(sessionId) === undefined) {
            await this.worktrees.cleanup(record.worktreeId)
          }
          const inspection = await this.worktrees.inspect(record.worktreeId)
          return worktreeWorkerResult(index, name, output, record, inspection, secretValues)
        })
      } catch (error) {
        if (record !== undefined && this.sessions.get(sessionId) === undefined) {
          await this.worktrees.cleanup(record.worktreeId).catch(() => {})
        }
        const bridgeError = error instanceof ParallelSemaphoreClosedError
          ? { code: 'BRIDGE_CLOSED', message: 'The MCP bridge is shutting down' }
          : worktreeErrorFrom(error, secretValues)
        return emptyWorktreeWorkerResult(index, name, sessionId, repository, bridgeError, secretValues)
      }
    }))
    const repo = redactSecretLike(repository.root, secretValues)
    const baseRef = redactSecretLike(repository.baseRef, secretValues)
    const baseCommit = redactSecretLike(repository.baseCommit, secretValues)
    return boundedWorktreeOutput(repo, baseRef, baseCommit, completed)
  }

  async worktreeReview(input: DshWorktreeReviewInput): Promise<DshWorktreeReviewOutput> {
    const secretValues = this.redactionSecrets()
    const suppliedIdentifiers = [input.sessionId, input.worktreeId].filter((value): value is string => value !== undefined)
    if (suppliedIdentifiers.length !== 1) {
      return emptyReviewOutput({ code: 'INVALID_WORKER_IDENTIFIER', message: 'Provide exactly one sessionId or worktreeId' }, secretValues)
    }
    const record = this.worktrees.getByIdentifier(suppliedIdentifiers[0])
    if (record === undefined) {
      return emptyReviewOutput({ code: 'WORKER_NOT_FOUND', message: 'The requested worker worktree does not exist' }, secretValues)
    }
    try {
      return reviewOutput(record, await this.integrationManager.review(record), secretValues)
    } catch (error) {
      return emptyReviewOutput(worktreeErrorFrom(error, secretValues), secretValues)
    }
  }

  async integrate(input: DshIntegrateInput): Promise<DshIntegrateOutput> {
    const secretValues = this.redactionSecrets()
    const requestedBaseRef = input.baseRef?.trim() || 'HEAD'
    if (this.closed) {
      return emptyIntegrationOutput(input.repo, requestedBaseRef, { code: 'BRIDGE_CLOSED', message: 'The MCP bridge is shutting down' }, secretValues)
    }
    let repository: GitRepositoryInfo
    try {
      repository = await this.worktrees.validateRepository(input.repo, requestedBaseRef)
    } catch (error) {
      return emptyIntegrationOutput(input.repo, requestedBaseRef, worktreeErrorFrom(error, secretValues), secretValues)
    }
    const records: WorktreeRecord[] = []
    const seen = new Set<string>()
    for (const worker of input.workers) {
      if (seen.has(worker.sessionId)) {
        return emptyIntegrationOutput(input.repo, requestedBaseRef, { code: 'DUPLICATE_WORKER', message: 'A worker session may appear only once' }, secretValues)
      }
      seen.add(worker.sessionId)
      const record = this.worktrees.getByIdentifier(worker.sessionId)
      if (record === undefined || record.sessionId !== worker.sessionId) {
        return emptyIntegrationOutput(input.repo, requestedBaseRef, { code: 'WORKER_NOT_FOUND', message: 'The requested worker session does not exist' }, secretValues)
      }
      if (record.cleanupState === 'removed') {
        return emptyIntegrationOutput(input.repo, requestedBaseRef, { code: 'WORKER_NOT_FOUND', message: 'The requested worker worktree is no longer active' }, secretValues)
      }
      if (record.repository.identity !== repository.identity || record.repository.commonDir !== repository.commonDir) {
        return emptyIntegrationOutput(input.repo, requestedBaseRef, { code: 'WORKER_REPOSITORY_MISMATCH', message: 'All worker sessions must belong to the requested repository' }, secretValues)
      }
      if (record.repository.baseCommit !== repository.baseCommit) {
        return emptyIntegrationOutput(input.repo, requestedBaseRef, { code: 'BASE_COMMIT_MISMATCH', message: 'All worker sessions must use the verified integration base commit' }, secretValues)
      }
      records.push(record)
    }
    try {
      return boundedIntegrationOutput(await this.integrationManager.integrate(repository, records))
    } catch (error) {
      return emptyIntegrationOutput(input.repo, requestedBaseRef, worktreeErrorFrom(error, secretValues), secretValues)
    }
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
      const worktreeResults = await Promise.allSettled([this.worktrees.close()])
      await this.gate.waitForIdle()
      const failure = [...results, ...worktreeResults].find(
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
    version: PACKAGE_VERSION,
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

  server.registerTool(
    'dsh_parallel_worktree',
    {
      title: 'Parallel DSH Worktrees',
      description: 'Create bridge-owned Git worktrees and run bounded independent DSH workers against the same repository without merging or changing the original working tree.',
      inputSchema: ParallelWorktreeInputSchema,
      outputSchema: ParallelWorktreeOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => worktreeToolResult(await bridge.parallelWorktree(input)),
  )

  server.registerTool(
    'dsh_worktree_review',
    {
      title: 'Review DSH Worktree',
      description: 'Review trusted Git metadata for an owned worker or integration worktree. Changed files and summaries are derived from Git, not model narration, and bounded before return.',
      inputSchema: WorktreeReviewInputSchema,
      outputSchema: WorktreeReviewOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => worktreeReviewToolResult(await bridge.worktreeReview(input)),
  )

  server.registerTool(
    'dsh_integrate',
    {
      title: 'Integrate DSH Worktrees',
      description: 'Apply owned worker snapshots in deterministic input order inside a fresh bridge-owned integration worktree. The original repository branch, index, HEAD, and working tree are never modified; conflicts are returned without automatic resolution.',
      inputSchema: IntegrationInputSchema,
      outputSchema: IntegrationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => integrationToolResult(await bridge.integrate(input)),
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

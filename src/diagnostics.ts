import type { RunResult } from '@deepseek-ai/dsh-sdk-client'

import type { SandboxCapabilityStatus } from './report.js'
import { redactSecretLike } from './config.js'

const MAX_ERROR_MESSAGE_LENGTH = 400

export interface InitializeDiagnostic {
  success: boolean
  serverInfo?: {
    name: string
    version: string
  }
  error?: {
    code?: string
    message: string
  }
}

export interface RunDiagnosticContext {
  marker?: string
  provider?: string
  model?: string
  initialize: InitializeDiagnostic
  secretValues?: readonly string[]
}

export interface TurnEndReasonDiagnostic {
  kind?: string
  errorCode?: string
  errorMessage?: string
}

export type ProviderOutcome = 'provider-reachable' | 'provider-reachable/quota-blocked'

export interface RunDiagnostic {
  sessionId: string
  finalResponse: {
    nonEmpty: boolean
    length: number
    markerFound: boolean
  }
  eventsCount: number
  notificationsCount: number
  eventCounts: Record<string, number>
  notificationCounts: Record<string, number>
  assistantMessageEvents: number
  assistantChunkEvents: number
  turnStartEvents: number
  turnEndEvents: number
  inboxSplicedEvents: number
  inboxReceiptPresent: boolean
  statusTransitions: string[]
  turnEndReasons: TurnEndReasonDiagnostic[]
  provider?: string
  model?: string
  initialize: InitializeDiagnostic
  failureClassification?: string
  providerOutcome?: ProviderOutcome
}

export interface ToolEventDiagnostic {
  calls: number
  results: number
  callIds: string[]
  resultIds: string[]
  unpairedCallIds: string[]
  paired: boolean
  toolNames: string[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function boundedMessage(value: unknown, secretValues: readonly string[] = []): string | undefined {
  const text = asString(value)
  if (text === undefined) return undefined
  const redacted = redactSecretLike(text, secretValues)
  return redacted.length <= MAX_ERROR_MESSAGE_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
}

function safeDiagnosticString(value: unknown, secretValues: readonly string[] = []): string | undefined {
  return boundedMessage(value, secretValues)
}

function safeDiagnosticKey(value: unknown, secretValues: readonly string[] = []): string {
  return boundedMessage(value, secretValues) ?? 'unknown'
}

function increment(
  counts: Record<string, number>,
  key: string,
  secretValues: readonly string[] = [],
): void {
  const safeKey = safeDiagnosticKey(key, secretValues)
  counts[safeKey] = (counts[safeKey] ?? 0) + 1
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))]
}

function statusTransitions(result: RunResult, secretValues: readonly string[] = []): string[] {
  const transitions: string[] = []
  for (const notification of result.notifications) {
    if (notification.method !== 'session.status') continue
    const params = asRecord(notification.params)
    const status = boundedMessage(params?.status, secretValues)
    if (status !== undefined && transitions.at(-1) !== status) transitions.push(status)
  }
  return transitions
}

function turnEndReason(
  event: RunResult['events'][number],
  secretValues: readonly string[] = [],
): TurnEndReasonDiagnostic {
  const data = asRecord(event.data)
  const reason = asRecord(data?.reason)
  const error = asRecord(reason?.error)
  return {
    kind: safeDiagnosticString(reason?.kind, secretValues),
    errorCode: boundedMessage(error?.code, secretValues),
    errorMessage: boundedMessage(error?.message, secretValues),
  }
}

export function summarizeRunResult(
  result: RunResult,
  context: RunDiagnosticContext,
): RunDiagnostic {
  const eventCounts: Record<string, number> = {}
  for (const event of result.events) increment(eventCounts, event.type, context.secretValues)

  const notificationCounts: Record<string, number> = {}
  for (const notification of result.notifications) {
    increment(notificationCounts, notification.method, context.secretValues)
  }

  const assistantMessageEvents = eventCounts['assistant/message'] ?? 0
  const finalResponseNonEmpty = result.finalResponse.trim().length > 0
  const markerFound = context.marker === undefined
    ? false
    : result.finalResponse.includes(context.marker)
  const turnEndReasons = result.events
    .filter((event) => event.type === 'turn/end')
    .map((event) => turnEndReason(event, context.secretValues))
  const turnErrorCode = turnEndReasons.find((reason) => reason.errorCode !== undefined)?.errorCode

  let failureClassification = turnErrorCode
  if (failureClassification === undefined && !finalResponseNonEmpty) {
    failureClassification = assistantMessageEvents === 0
      ? 'ASSISTANT_MESSAGE_MISSING'
      : 'EMPTY_FINAL_RESPONSE'
  }

  const providerOutcome: ProviderOutcome | undefined = turnErrorCode === 'QUOTA'
    ? 'provider-reachable/quota-blocked'
    : finalResponseNonEmpty && assistantMessageEvents > 0
      ? 'provider-reachable'
      : undefined

  return {
    sessionId: result.sessionId,
    finalResponse: {
      nonEmpty: finalResponseNonEmpty,
      length: result.finalResponse.length,
      markerFound,
    },
    eventsCount: result.events.length,
    notificationsCount: result.notifications.length,
    eventCounts,
    notificationCounts,
    assistantMessageEvents,
    assistantChunkEvents: eventCounts['assistant/chunk'] ?? 0,
    turnStartEvents: eventCounts['turn/start'] ?? 0,
    turnEndEvents: eventCounts['turn/end'] ?? 0,
    inboxSplicedEvents: eventCounts['agent/inbox/spliced'] ?? 0,
    inboxReceiptPresent: (eventCounts['agent/inbox/spliced'] ?? 0) > 0,
    statusTransitions: statusTransitions(result, context.secretValues),
    turnEndReasons,
    provider: boundedMessage(context.provider, context.secretValues),
    model: boundedMessage(context.model, context.secretValues),
    initialize: context.initialize,
    failureClassification,
    providerOutcome,
  }
}

function toolCallId(event: RunResult['events'][number]): string | undefined {
  const data = asRecord(event.data)
  if (event.type === 'tool/call') return asString(data?.callId)
  if (event.type !== 'tool/result') return undefined
  const message = asRecord(data?.message)
  const source = asRecord(message?.source)
  return asString(source?.callId)
}

export function summarizeToolEvents(
  result: RunResult,
  secretValues: readonly string[] = [],
): ToolEventDiagnostic {
  const calls = result.events.filter((event) => event.type === 'tool/call')
  const results = result.events.filter((event) => event.type === 'tool/result')
  const callIds = uniqueStrings(calls.map(toolCallId))
    .map((value) => safeDiagnosticString(value, secretValues) ?? 'unknown')
  const resultIds = uniqueStrings(results.map(toolCallId))
    .map((value) => safeDiagnosticString(value, secretValues) ?? 'unknown')
  const unpairedCallIds = callIds.filter((id) => !resultIds.includes(id))
  const toolNames = uniqueStrings(calls.map((event) => {
    const data = asRecord(event.data)
    return asString(data?.name)
  })).map((value) => safeDiagnosticString(value, secretValues) ?? 'unknown')

  return {
    calls: calls.length,
    results: results.length,
    callIds,
    resultIds,
    unpairedCallIds,
    paired: callIds.length > 0 && unpairedCallIds.length === 0,
    toolNames,
  }
}


export interface SandboxCapabilityProbe {
  enforcement: 'full' | 'partial' | 'unknown'
  filesystemToolEventsPaired: boolean
  powerShellToolEventsPaired: boolean
  filesystemWriteDenied: boolean
  powerShellWriteDenied: boolean
  sentinelsUnchanged: boolean
}

export function classifySandboxCapability(
  probe: SandboxCapabilityProbe,
): SandboxCapabilityStatus {
  if (!probe.sentinelsUnchanged) return 'failed'
  // Tool-event text and unchanged sentinels are observations, not a security
  // boundary. Keep the capability inconclusive until a separately proven
  // enforcement mechanism is integrated.
  return 'inconclusive'
}

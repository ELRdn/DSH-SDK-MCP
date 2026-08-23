import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  summarizeRunResult,
  summarizeToolEvents,
} from '../dist/diagnostics.js'

test('run diagnostics preserve a turn error when finalResponse is empty', () => {
  const diagnostic = summarizeRunResult(
    {
      sessionId: 'diagnostic-session',
      finalResponse: '',
      events: [
        { type: 'agent/inbox/spliced', data: { inserted: [{ id: 'message-1' }] } },
        { type: 'turn/start', data: { turn: 0 } },
        { type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: {} } },
        {
          type: 'turn/end',
          data: {
            turn: 0,
            reason: {
              kind: 'error',
              error: {
                code: 'MISSING_CREDENTIAL',
                message: 'no API key for provider route "deepseek-official"',
              },
            },
          },
        },
      ],
      notifications: [
        { method: 'session.status', params: { sessionId: 'diagnostic-session', status: 'running' } },
        { method: 'session.status', params: { sessionId: 'diagnostic-session', status: 'idle' } },
      ],
    },
    {
      marker: 'DSH_PHASE0_PROTOCOL_OK',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      initialize: {
        success: true,
        serverInfo: {
          name: 'deepseek-harness-sdk-runtime',
          version: '0.0.1',
        },
      },
    },
  )

  assert.equal(diagnostic.sessionId, 'diagnostic-session')
  assert.equal(diagnostic.finalResponse.nonEmpty, false)
  assert.equal(diagnostic.finalResponse.length, 0)
  assert.equal(diagnostic.finalResponse.markerFound, false)
  assert.equal(diagnostic.eventsCount, 4)
  assert.equal(diagnostic.notificationsCount, 2)
  assert.equal(diagnostic.eventCounts['assistant/message'], undefined)
  assert.equal(diagnostic.eventCounts['assistant/chunk'], 1)
  assert.equal(diagnostic.eventCounts['turn/end'], 1)
  assert.equal(diagnostic.inboxSplicedEvents, 1)
  assert.equal(diagnostic.inboxReceiptPresent, true)
  assert.deepEqual(diagnostic.statusTransitions, ['running', 'idle'])
  assert.equal(diagnostic.turnEndReasons[0].kind, 'error')
  assert.equal(diagnostic.turnEndReasons[0].errorCode, 'MISSING_CREDENTIAL')
  assert.equal(diagnostic.failureClassification, 'MISSING_CREDENTIAL')
  assert.equal(diagnostic.provider, 'deepseek-official')
  assert.equal(diagnostic.model, 'deepseek-v4-flash')
  assert.equal(diagnostic.initialize.success, true)
})

test('tool diagnostics pair official callId and message.source.callId shapes', () => {
  const diagnostic = summarizeToolEvents({
    sessionId: 'tool-session',
    finalResponse: 'ok',
    events: [
      {
        type: 'tool/call',
        data: {
          turn: 0,
          step: 0,
          callId: 'call-1',
          name: 'fs.read',
          arguments: '{"path":"README.md"}',
        },
      },
      {
        type: 'tool/result',
        data: {
          turn: 0,
          step: 0,
          message: {
            source: { kind: 'tool', callId: 'call-1' },
            content: [{ type: 'text', text: 'README content' }],
          },
        },
      },
    ],
    notifications: [],
  })

  assert.equal(diagnostic.calls, 1)
  assert.equal(diagnostic.results, 1)
  assert.deepEqual(diagnostic.callIds, ['call-1'])
  assert.deepEqual(diagnostic.resultIds, ['call-1'])
  assert.equal(diagnostic.paired, true)
  assert.deepEqual(diagnostic.toolNames, ['fs.read'])
})

test('sandbox diagnostics never treat partial or unknown enforcement as full verification', async () => {
  const { classifySandboxCapability } = await import('../dist/diagnostics.js')
  const base = {
    filesystemToolEventsPaired: true,
    powerShellToolEventsPaired: true,
    filesystemWriteDenied: true,
    powerShellWriteDenied: true,
    sentinelsUnchanged: true,
  }
  assert.equal(classifySandboxCapability({ ...base, enforcement: 'unknown' }), 'inconclusive')
  assert.equal(classifySandboxCapability({ ...base, enforcement: 'partial' }), 'observed-partial')
  assert.equal(classifySandboxCapability({ ...base, enforcement: 'full', filesystemToolEventsPaired: false }), 'inconclusive')
  assert.equal(classifySandboxCapability({ ...base, enforcement: 'full', sentinelsUnchanged: false }), 'failed')
  assert.equal(classifySandboxCapability({ ...base, enforcement: 'full' }), 'verified-full')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { summarizeRunResult } from '../dist/diagnostics.js'

test('QUOTA keeps provider-reachable and quota-blocked evidence', () => {
  const diagnostic = summarizeRunResult(
    {
      sessionId: 'quota-session',
      finalResponse: '',
      events: [
        { type: 'agent/inbox/spliced', data: { inserted: [{ id: 'message-1' }] } },
        { type: 'turn/start', data: { turn: 0 } },
        {
          type: 'turn/end',
          data: {
            turn: 0,
            reason: {
              kind: 'error',
              error: { code: 'QUOTA', message: 'Insufficient Balance' },
            },
          },
        },
      ],
      notifications: [
        { method: 'session.status', params: { sessionId: 'quota-session', status: 'running' } },
        { method: 'session.status', params: { sessionId: 'quota-session', status: 'idle' } },
      ],
    },
    {
      marker: 'DSH_PHASE0_PROTOCOL_OK',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      initialize: {
        success: true,
        serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' },
      },
    },
  )

  assert.equal(diagnostic.failureClassification, 'QUOTA')
  assert.equal(diagnostic.providerOutcome, 'provider-reachable/quota-blocked')
  assert.equal(diagnostic.finalResponse.nonEmpty, false)
  assert.equal(diagnostic.initialize.success, true)
})

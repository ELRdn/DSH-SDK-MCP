import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  RequestTimeoutError,
} from '@deepseek-ai/dsh-sdk-client'

import { summarizeRunResult } from '../dist/diagnostics.js'
import { createDeepSeekHarness } from '../dist/sdk-runtime.js'

const fakeRuntime = fileURLToPath(new URL('./fake-runtime.mjs', import.meta.url))

async function missing(path) {
  await assert.rejects(access(path))
}

async function makeHarness(mode, root, options = {}) {
  const pidFile = join(root, `${mode}.pid`)
  const harness = createDeepSeekHarness({
    command: process.execPath,
    args: [fakeRuntime, mode],
    profile: 'sdk',
    patches: [],
    cwd: root,
    env: { ...process.env, DSH_PHASE0_FAKE_PID_FILE: pidFile },
    requestTimeoutMs: options.requestTimeoutMs ?? 500,
    shutdownTimeoutMs: 100,
    disposeEofGraceMs: 500,
    disposeGraceMs: 500,
  }, {
    cwd: root,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  return { harness, pidFile }
}

test('SDK diagnostic: an empty finalResponse retains the turn error evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-contract-'))
  const { harness, pidFile } = await makeHarness('missing-credential', root)
  try {
    const result = await harness.run('DSH_PHASE0_FAKE_TURN', { sessionId: 'missing-credential-session' })
    const diagnostic = summarizeRunResult(result, {
      marker: 'DSH_PHASE0_PROTOCOL_OK',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      initialize: { success: true, serverInfo: { name: 'fake-runtime', version: '0.0.0-test' } },
    })
    assert.equal(diagnostic.finalResponse.nonEmpty, false)
    assert.equal(diagnostic.assistantMessageEvents, 0)
    assert.equal(diagnostic.eventCounts['assistant/chunk'], 1)
    assert.equal(diagnostic.turnEndReasons[0].errorCode, 'MISSING_CREDENTIAL')
    assert.deepEqual(diagnostic.statusTransitions, ['running', 'idle'])
  } finally {
    await harness.close()
    await missing(pidFile)
    await rm(root, { recursive: true, force: true })
  }
})

test('SDK contract: initialize, run, idle, and close use one fake runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-contract-'))
  const { harness, pidFile } = await makeHarness('normal', root)
  try {
    const result = await harness.run('DSH_PHASE0_FAKE_TURN', { sessionId: 'fake-session' })
    assert.equal(result.sessionId, 'fake-session')
    assert.match(result.finalResponse, /FAKE_RESPONSE:DSH_PHASE0_FAKE_TURN/)
    assert.ok(result.notifications.some((item) => item.method === 'session.status'))
  } finally {
    await harness.close()
    await missing(pidFile)
    await rm(root, { recursive: true, force: true })
  }
})

test('SDK contract: initialize rejects a provider/model route error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-contract-'))
  const { harness, pidFile } = await makeHarness('provider-mismatch', root)
  try {
    await assert.rejects(harness.start(), /provider\/model route unavailable|JSON-RPC/i)
  } finally {
    await harness.close()
    await missing(pidFile)
    await rm(root, { recursive: true, force: true })
  }
})

test('SDK contract: malformed JSON-RPC is rejected and the child is reaped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-contract-'))
  const { harness, pidFile } = await makeHarness('malformed-json', root)
  try {
    await assert.rejects(
      harness.start(),
      /JSON|closed|protocol|exit code|not running/i,
    )
  } finally {
    await harness.close()
    await missing(pidFile)
    await rm(root, { recursive: true, force: true })
  }
})

test('SDK contract: abnormal runtime exit exposes a bounded diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-contract-'))
  const { harness, pidFile } = await makeHarness('crash-before-init', root)
  try {
    await assert.rejects(
      harness.start(),
      /fake runtime crashed|exit code|closed/i,
    )
  } finally {
    await harness.close()
    await missing(pidFile)
    await rm(root, { recursive: true, force: true })
  }
})

test('SDK contract: request timeout is surfaced and close terminates the runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-contract-'))
  const { harness, pidFile } = await makeHarness('timeout', root, { requestTimeoutMs: 50 })
  try {
    await assert.rejects(harness.start(), (error) => error instanceof RequestTimeoutError)
  } finally {
    await harness.close()
    await missing(pidFile)
    await rm(root, { recursive: true, force: true })
  }
})

test('SDK contract: nonexistent runtime command fails without a shell fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-contract-'))
  const harness = createDeepSeekHarness({
    command: join(root, 'does-not-exist.exe'),
    args: [],
    profile: 'sdk',
    patches: [],
    cwd: root,
    requestTimeoutMs: 100,
    disposeGraceMs: 100,
  }, {
    cwd: root,
  })
  try {
    await assert.rejects(harness.start(), /not running|spawn error|closed/i)
  } finally {
    await harness.close()
    await rm(root, { recursive: true, force: true })
  }
})

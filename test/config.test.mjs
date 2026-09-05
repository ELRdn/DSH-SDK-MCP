import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  loadPhase0Options,
  loadRuntimeLaunchConfig,
  redactSecretLike,
  secretValuesFromEnvironment,
  RuntimeConfigError,
} from '../dist/config.js'
import { safeError } from '../dist/report.js'
import { RuntimeBusyError, RuntimeRunGate } from '../dist/run-gate.js'

test('runtime args must be a JSON array of strings', () => {
  assert.throws(
    () => loadRuntimeLaunchConfig({
      DSH_MCP_RUNTIME_COMMAND: 'node',
      DSH_MCP_RUNTIME_ARGS: '{"not":"an array"}',
    }),
    (error) => error instanceof RuntimeConfigError && error.code === 'INVALID_RUNTIME_ARGS',
  )
})

test('missing runtime command selects the bundled DSH sdk profile', () => {
  const config = loadRuntimeLaunchConfig({})
  assert.equal(config.command, undefined)
  assert.equal(config.profile, 'sdk')
  assert.deepEqual(config.args, [])
  assert.deepEqual(config.patches, [])
  assert.equal(config.initializeTimeoutMs, 30_000)
})

test('runtime args without an external command are rejected', () => {
  assert.throws(
    () => loadRuntimeLaunchConfig({ DSH_MCP_RUNTIME_ARGS: '["orphan-arg"]' }),
    (error) => error instanceof RuntimeConfigError && error.code === 'RUNTIME_NOT_CONFIGURED',
  )
})

test('environment is omitted when no override is needed', () => {
  const config = loadRuntimeLaunchConfig({
    PATH: 'inherited-path',
    DSH_MCP_RUNTIME_COMMAND: 'node',
    DSH_MCP_RUNTIME_ARGS: '[]',
  })
  assert.equal(config.env, undefined)
})

test('environment overrides merge without deleting PATH', () => {
  const config = loadRuntimeLaunchConfig({
    PATH: 'original-path',
    DSH_MCP_RUNTIME_COMMAND: 'node',
    DSH_MCP_RUNTIME_ARGS: '[]',
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PERMISSION_MODE: 'read-only' }),
  })
  assert.equal(config.env.PATH, 'original-path')
  assert.equal(config.env.DSH_PERMISSION_MODE, 'read-only')
})

test('runtime request timeout is parsed as a positive integer', () => {
  const config = loadRuntimeLaunchConfig({
    DSH_MCP_RUNTIME_COMMAND: 'node',
    DSH_MCP_RUNTIME_ARGS: '[]',
    DSH_MCP_RUNTIME_INITIALIZE_TIMEOUT_MS: '4321',
    DSH_MCP_RUNTIME_REQUEST_TIMEOUT_MS: '1234',
  })
  assert.equal(config.initializeTimeoutMs, 4321)
  assert.equal(config.requestTimeoutMs, 1234)
})

test('runtime idle TTL is parsed as a positive integer and rejects invalid values', () => {
  const config = loadRuntimeLaunchConfig({
    DSH_MCP_RUNTIME_COMMAND: 'node',
    DSH_MCP_RUNTIME_IDLE_TTL_MS: '4321',
  })
  assert.equal(config.idleTtlMs, 4321)
  assert.throws(
    () => loadRuntimeLaunchConfig({
      DSH_MCP_RUNTIME_COMMAND: 'node',
      DSH_MCP_RUNTIME_IDLE_TTL_MS: '0',
    }),
    (error) => error instanceof RuntimeConfigError && error.code === 'INVALID_RUNTIME_IDLE_TTL',
  )
})

test('parallel worker cap is bounded by the hard maximum', () => {
  const config = loadRuntimeLaunchConfig({
    DSH_MCP_RUNTIME_COMMAND: 'node',
    DSH_MCP_MAX_PARALLEL: '2',
  })
  assert.equal(config.maxParallel, 2)
  assert.throws(
    () => loadRuntimeLaunchConfig({
      DSH_MCP_RUNTIME_COMMAND: 'node',
      DSH_MCP_MAX_PARALLEL: '9',
    }),
    (error) => error instanceof RuntimeConfigError && error.code === 'INVALID_MAX_PARALLEL',
  )
})

test('runtime timeout and max token validation use distinct structured config codes', () => {
  assert.throws(
    () => loadRuntimeLaunchConfig({
      DSH_MCP_RUNTIME_COMMAND: 'node',
      DSH_MCP_RUNTIME_REQUEST_TIMEOUT_MS: 'not-a-number',
    }),
    (error) => error instanceof RuntimeConfigError && error.code === 'INVALID_RUNTIME_TIMEOUT',
  )

  assert.throws(
    () => loadPhase0Options({ DSH_MCP_MAX_TOKENS: 'not-a-number' }, '/phase1-project'),
    (error) => error instanceof RuntimeConfigError && error.code === 'INVALID_MAX_TOKENS',
  )
})

test('redaction preserves ordinary identifiers and exact configured secrets', () => {
  assert.equal(redactSecretLike('C:\\repo\\sk-folder\\cfg'), 'C:\\repo\\sk-folder\\cfg')
  assert.equal(redactSecretLike('token-version-1'), 'token-version-1')
  assert.equal(redactSecretLike('rate limit: token=[REDACTED]'), 'rate limit: token=[REDACTED]')
  assert.equal(redactSecretLike('build-token=version-1'), 'build-token=version-1')
  assert.equal(redactSecretLike('build sk-folder-name-1234567890123456'), 'build sk-folder-name-1234567890123456')
  assert.equal(redactSecretLike('credential sk-abcdefghijklmnopqrstuvwxyz1234'), 'credential [REDACTED]')
  assert.equal(redactSecretLike('order 1234', ['1234']), 'order [REDACTED]')
  assert.equal(redactSecretLike('order1234', ['1234']), 'order1234')
  assert.equal(
    redactSecretLike('credential=NONSTANDARD_REVIEW_SECRET', ['NONSTANDARD_REVIEW_SECRET']),
    'credential=[REDACTED]',
  )
})

test('all runtime override values are included in the redaction set', () => {
  const values = secretValuesFromEnvironment({
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ FOO: 'arbitrary-override-secret' }),
  })
  assert.deepEqual(values, ['arbitrary-override-secret'])
})

test('safe errors are bounded before top-level stderr emission', () => {
  const safe = safeError(new Error('x'.repeat(10_000)))
  assert.ok(safe.message.length <= 401)
  assert.equal(safe.message.endsWith('…'), true)
})

test('runtime gate rejects concurrent work and releases after completion', async () => {
  const gate = new RuntimeRunGate()
  let release
  const first = gate.runExclusive(() => new Promise((resolve) => {
    release = resolve
  }))
  await assert.rejects(
    gate.runExclusive(async () => 'unreachable'),
    (error) => error instanceof RuntimeBusyError && error.code === 'RUNTIME_BUSY',
  )
  release()
  await first
  assert.equal(await gate.runExclusive(async () => 'reusable'), 'reusable')
})

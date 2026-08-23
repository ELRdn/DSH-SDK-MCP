import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  loadRuntimeLaunchConfig,
  RuntimeConfigError,
} from '../dist/config.js'
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

test('missing runtime command is rejected', () => {
  assert.throws(
    () => loadRuntimeLaunchConfig({}),
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

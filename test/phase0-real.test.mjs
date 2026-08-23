import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { runPhase0 } from '../dist/phase0.js'

const here = dirname(fileURLToPath(import.meta.url))
const fakeRuntime = join(here, 'fake-runtime.mjs')

test('Phase 0 report scrubs configured credential values from runtime diagnostics', async () => {
  const secret = 'PHASE0_SYNTHETIC_CREDENTIAL_123456789'
  const report = await runPhase0({
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'crash-secret']),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DSH_MCP_REQUIRE_WINDOWS: '0',
    DSH_MCP_ALLOW_NON_WINDOWS: '1',
    DEEPSEEK_API_KEY: secret,
    DSH_PHASE0_FAKE_SECRET: secret,
  })

  assert.equal(report.status, 'failed')
  assert.equal(JSON.stringify(report).includes(secret), false)
})

test('Phase 0 stderr diagnostics cap each retained line', async () => {
  const report = await runPhase0({
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'crash-huge-stderr']),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DSH_MCP_REQUIRE_WINDOWS: '0',
    DSH_MCP_ALLOW_NON_WINDOWS: '1',
    DEEPSEEK_API_KEY: 'phase0-test-key',
  })

  const stderrTail = report.stages.cleanup.details.stderrTail
  assert.ok(Array.isArray(stderrTail))
  assert.ok(stderrTail.every((line) => typeof line === 'string' && line.length <= 401))
})

test('Phase 0 redacts runtime-controlled diagnostic codes and transitions', async () => {
  const secret = 'PHASE0_RUNTIME_DIAGNOSTIC_SECRET_123456789'
  const report = await runPhase0({
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'secret-diagnostic']),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DSH_MCP_REQUIRE_WINDOWS: '0',
    DSH_MCP_ALLOW_NON_WINDOWS: '1',
    DEEPSEEK_API_KEY: 'phase0-test-key',
    DSH_PHASE0_FAKE_SECRET: secret,
  })

  assert.equal(JSON.stringify(report).includes(secret), false)
})

test('Phase 0 redacts runtime-controlled tool ids and names', async () => {
  const secret = 'PHASE0_TOOL_FIELD_SECRET_123456789'
  const report = await runPhase0({
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'secret-tool-fields']),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DSH_MCP_REQUIRE_WINDOWS: '0',
    DSH_MCP_ALLOW_NON_WINDOWS: '1',
    DEEPSEEK_API_KEY: 'phase0-test-key',
    DSH_PHASE0_FAKE_SECRET: secret,
  })

  assert.equal(JSON.stringify(report).includes(secret), false)
})

test('Phase 0 redacts report header and dependency keys', async () => {
  const secret = 'PHASE0_HEADER_SECRET_123456789'
  const report = await runPhase0({
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'crash-before-init']),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: secret,
    DSH_MCP_CREDENTIAL_REF: secret,
    DSH_MCP_RUNTIME_PACKAGE: secret,
    DSH_MCP_REQUIRE_WINDOWS: '0',
    DSH_MCP_ALLOW_NON_WINDOWS: '1',
    DEEPSEEK_API_KEY: secret,
  })

  assert.equal(JSON.stringify(report).includes(secret), false)
})

test('Phase 0 bounds runtime server identity diagnostics', async () => {
  const report = await runPhase0({
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'huge-server-info']),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DSH_MCP_REQUIRE_WINDOWS: '0',
    DSH_MCP_ALLOW_NON_WINDOWS: '1',
    DEEPSEEK_API_KEY: 'phase0-test-key',
  })

  const serverInfo = report.stages.protocol.details.diagnostics.initialize.serverInfo
  assert.ok(serverInfo.name.length <= 401)
  assert.ok(serverInfo.version.length <= 401)
})

test('Phase 0 redacts provider and model in successful protocol diagnostics', async () => {
  const secret = 'PHASE0_PROTOCOL_MODEL_SECRET_123456789'
  const report = await runPhase0({
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'normal']),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: secret,
    DSH_MCP_REQUIRE_WINDOWS: '0',
    DSH_MCP_ALLOW_NON_WINDOWS: '1',
    DEEPSEEK_API_KEY: secret,
  })

  assert.equal(JSON.stringify(report).includes(secret), false)
  assert.equal(report.stages.protocol.details.diagnostics.model, '[REDACTED]')
})

test('real Phase 0 smoke', { skip: process.env.DSH_MCP_REAL_SMOKE !== '1' }, async () => {
  const report = await runPhase0(process.env)
  assert.equal(report.status, 'passed', JSON.stringify(report, null, 2))
  assert.equal(report.coreStatus, 'passed', JSON.stringify(report, null, 2))
  assert.equal(report.phase1Eligible, false)
})

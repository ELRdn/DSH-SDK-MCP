import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runPhase0 } from '../dist/phase0.js'

test('real Phase 0 smoke', { skip: process.env.DSH_MCP_REAL_SMOKE !== '1' }, async () => {
  const report = await runPhase0(process.env)
  assert.equal(report.status, 'passed', JSON.stringify(report, null, 2))
  assert.equal(report.coreStatus, 'passed', JSON.stringify(report, null, 2))
  assert.equal(report.phase1Eligible, false)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  loadPhase0Options,
  RuntimeConfigError,
} from '../dist/config.js'

test('opencode-go profile selects its catalog route and Cordis composition', () => {
  const options = loadPhase0Options({ DSH_MCP_PROFILE: 'opencode-go' }, '/phase0-project')
  assert.equal(options.profile, 'opencode-go')
  assert.equal(options.provider, 'opencode-go')
  assert.equal(options.model, 'deepseek-v4-flash')
  assert.equal(options.credentialRef, 'OPENCODE_API_KEY')
  assert.match(options.cordisConfig, /runtime[\\/]phase0\.opencode-go\.cordis\.yml$/)
})

test('provider environment selects the matching built-in profile without hard-coding the runner', () => {
  const options = loadPhase0Options({ DSH_MCP_PROVIDER: 'opencode-go' }, '/phase0-project')
  assert.equal(options.profile, 'opencode-go')
  assert.equal(options.provider, 'opencode-go')
  assert.equal(options.credentialRef, 'OPENCODE_API_KEY')
})

test('unknown explicit Phase 0 profile is rejected', () => {
  assert.throws(
    () => loadPhase0Options({ DSH_MCP_PROFILE: 'not-a-profile' }, '/phase0-project'),
    (error) => error instanceof RuntimeConfigError && error.code === 'INVALID_PROVIDER_PROFILE',
  )
})

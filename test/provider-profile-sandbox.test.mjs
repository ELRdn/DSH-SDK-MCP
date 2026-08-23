import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadPhase0Options } from '../dist/config.js'

test('OpenCode Go sandbox probe uses the selected provider composition by default', () => {
  const options = loadPhase0Options({ DSH_MCP_PROFILE: 'opencode-go' }, '/phase0-project')
  assert.match(options.sandboxCordisConfig, /runtime[\\/]phase0\.opencode-go\.cordis\.yml$/)
})

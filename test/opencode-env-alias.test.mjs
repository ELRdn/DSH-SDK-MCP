import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadRuntimeLaunchConfig } from '../dist/config.js'

test('OpenCode Go profile maps only the legacy env alias into the child environment', () => {
  const config = loadRuntimeLaunchConfig({
    PATH: 'inherited-path',
    DSH_MCP_PROFILE: 'opencode-go',
    DSH_MCP_RUNTIME_COMMAND: 'node',
    DSH_MCP_RUNTIME_ARGS: '[]',
    OPENCODE_GO_API_KEY: 'synthetic-test-key',
  })

  assert.equal(config.env.PATH, 'inherited-path')
  assert.equal(config.env.OPENCODE_API_KEY, 'synthetic-test-key')
})

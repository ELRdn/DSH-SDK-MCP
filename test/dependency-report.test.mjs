import assert from 'node:assert/strict'
import { test } from 'node:test'

import { packageVersion } from '../dist/report.js'

test('dependency report resolves the pinned DSH runtime and SDK versions', () => {
  assert.equal(packageVersion('@deepseek-ai/dsh'), '0.1.2-rc.1')
  assert.equal(packageVersion('@deepseek-ai/dsh-sdk-client'), '0.1.2-rc.1')
  assert.equal(packageVersion('@deepseek-ai/dsh-sdk-protocol'), '0.1.2-rc.1')
})

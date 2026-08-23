import assert from 'node:assert/strict'
import { test } from 'node:test'

import { packageVersion } from '../dist/report.js'

test('dependency report resolves pi-ai package versions through its public export map', () => {
  assert.equal(packageVersion('@deepseek-ai/dsh-llm-pi-ai'), '0.1.1-rc.2')
  assert.equal(packageVersion('@earendil-works/pi-ai'), '0.82.1')
})

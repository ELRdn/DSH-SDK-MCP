import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RuntimeBusyError } from '../dist/run-gate.js'
import { RuntimePool } from '../dist/runtime-pool.js'

function resource(onDispose) {
  return {
    harness: { close: async () => {} },
    initialize: { current: () => ({ success: true }) },
    dispose: async () => onDispose(),
  }
}

test('RuntimePool reuses an idle runtime and never runs two roots in parallel', async () => {
  let created = 0
  let disposed = 0
  let active = 0
  let maximumActive = 0
  const pool = new RuntimePool({
    idleTtlMs: 5_000,
    createRuntime: async () => {
      created += 1
      return resource(() => { disposed += 1 })
    },
  })

  const first = await pool.acquire('/workspace-a')
  let release
  const firstRun = pool.runExclusive(first, async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => { release = resolve })
    active -= 1
    return 'first'
  })
  await assert.rejects(
    pool.acquire('/workspace-b'),
    (error) => error instanceof RuntimeBusyError && error.code === 'RUNTIME_BUSY',
  )
  release()
  assert.equal(await firstRun, 'first')

  const second = await pool.acquire('/workspace-a')
  assert.equal(second.runtime, first.runtime)
  await pool.runExclusive(second, async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    active -= 1
  })
  await pool.close()
  assert.equal(created, 1)
  assert.equal(disposed, 1)
  assert.equal(maximumActive, 1)
})

test('RuntimePool close reaps a runtime that is still being created', async () => {
  let finishCreation
  let disposed = 0
  const pool = new RuntimePool({
    idleTtlMs: 5_000,
    createRuntime: () => new Promise((resolve) => {
      finishCreation = () => resolve(resource(() => { disposed += 1 }))
    }),
  })
  const acquiring = pool.acquire('/workspace-starting')
  await new Promise((resolve) => setImmediate(resolve))
  const closing = pool.close()
  finishCreation()
  await assert.rejects(acquiring, /closed/i)
  await closing
  assert.equal(disposed, 1)
})

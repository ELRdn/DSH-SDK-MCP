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

test('RuntimePool reuses idle runtimes, overlaps distinct runtimes, and guards one runtime', async () => {
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
  const sameRuntime = await pool.acquire('/workspace-a')
  assert.equal(sameRuntime.owner, false)
  await assert.rejects(
    pool.runExclusive(sameRuntime, async () => 'unreachable'),
    (error) => error instanceof RuntimeBusyError && error.code === 'RUNTIME_BUSY',
  )
  const secondRuntime = await pool.acquire('/workspace-b')
  const secondRun = pool.runExclusive(secondRuntime, async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    active -= 1
    return 'second'
  })
  assert.equal(await secondRun, 'second')
  release()
  assert.equal(await firstRun, 'first')

  const reused = await pool.acquire('/workspace-a')
  assert.equal(reused.runtime, first.runtime)
  await pool.runExclusive(reused, async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    active -= 1
  })
  await pool.close()
  assert.equal(created, 2)
  assert.equal(disposed, 2)
  assert.equal(maximumActive, 2)
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

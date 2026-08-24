import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test } from 'node:test'

import { SessionRegistry } from '../dist/session-registry.js'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const serverEntry = join(projectRoot, 'dist', 'index.js')
const fakeRuntime = join(here, 'fake-runtime.mjs')

function phase2Environment(overrides = {}) {
  return {
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'phase2-context']),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DEEPSEEK_API_KEY: 'sk-phase2-test-secret',
    ...overrides,
  }
}

async function connectClient(overrides = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectRoot,
    env: phase2Environment(overrides),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'dsh-sdk-mcp-phase2-test', version: '0.2.0' })
  await client.connect(transport)
  return { client, transport }
}

async function closeClient(client, transport) {
  await client.close().catch(() => {})
  await transport.close().catch(() => {})
}

async function waitForPath(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 25))
    }
  }
  throw new Error(`Timed out waiting for path: ${path}`)
}

async function waitForMissing(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(path)
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 25))
    } catch {
      return
    }
  }
  throw new Error(`Timed out waiting for path to disappear: ${path}`)
}

async function readPid(path) {
  return Number((await readFile(path, 'utf8')).trim())
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

test('persistent DSH session continues twice on the same runtime and preserves context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase2-context-'))
  const pidFile = join(root, 'fake-runtime.pid')
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE0_FAKE_PID_FILE: pidFile }),
  })
  try {
    const first = await client.callTool({
      name: 'dsh_delegate',
      arguments: {
        task: 'Remember PHASE2_CONTEXT_ALPHA_42 for the next turns.',
        cwd: root,
      },
    })
    assert.equal(first.isError, undefined)
    assert.equal(first.structuredContent.ok, true)
    assert.match(first.structuredContent.sessionId, /^dsh-phase2-/)
    assert.match(first.structuredContent.finalResponse, /FIRST_CONTEXT:Remember PHASE2_CONTEXT_ALPHA_42/)
    const firstPid = await readPid(pidFile)

    const idle = await client.callTool({
      name: 'dsh_status',
      arguments: { sessionId: first.structuredContent.sessionId },
    })
    assert.equal(idle.isError, undefined)
    assert.equal(idle.structuredContent.status, 'idle')

    const second = await client.callTool({
      name: 'dsh_continue',
      arguments: {
        sessionId: first.structuredContent.sessionId,
        task: 'What marker did you remember?',
      },
    })
    assert.equal(second.isError, undefined)
    assert.equal(second.structuredContent.ok, true)
    assert.match(second.structuredContent.finalResponse, /REMEMBERED:Remember PHASE2_CONTEXT_ALPHA_42/)

    const third = await client.callTool({
      name: 'dsh_continue',
      arguments: {
        sessionId: first.structuredContent.sessionId,
        task: 'Repeat the remembered marker once more.',
      },
    })
    assert.equal(third.isError, undefined)
    assert.equal(third.structuredContent.ok, true)
    assert.match(third.structuredContent.finalResponse, /REMEMBERED:Remember PHASE2_CONTEXT_ALPHA_42/)
    assert.equal(await readPid(pidFile), firstPid)
  } finally {
    await closeClient(client, transport)
    await waitForMissing(pidFile)
    await rm(root, { recursive: true, force: true })
  }
})

test('same-session concurrent continuation is rejected by the active-run guard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase2-busy-'))
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'phase2-context-slow']),
  })
  try {
    const first = await client.callTool({
      name: 'dsh_delegate',
      arguments: { task: 'Remember PHASE2_BUSY_CONTEXT.', cwd: root },
    })
    assert.equal(first.structuredContent.ok, true)
    const inFlight = client.callTool({
      name: 'dsh_continue',
      arguments: { sessionId: first.structuredContent.sessionId, task: 'slow continuation one' },
    })
    await sleep(50)
    const running = await client.callTool({
      name: 'dsh_status',
      arguments: { sessionId: first.structuredContent.sessionId },
    })
    assert.equal(running.isError, undefined)
    assert.equal(running.structuredContent.status, 'running')

    const rejected = await client.callTool({
      name: 'dsh_continue',
      arguments: { sessionId: first.structuredContent.sessionId, task: 'slow continuation two' },
    })
    assert.equal(rejected.structuredContent.error.code, 'RUNTIME_BUSY')
    const success = await inFlight
    assert.equal(success.isError, undefined)
    assert.equal(success.structuredContent.ok, true)
    const idle = await client.callTool({
      name: 'dsh_status',
      arguments: { sessionId: first.structuredContent.sessionId },
    })
    assert.equal(idle.structuredContent.status, 'idle')
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

test('idle TTL expires the runtime and continuation fails without fake restoration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase2-ttl-'))
  const pidFile = join(root, 'fake-runtime.pid')
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'normal']),
    DSH_MCP_RUNTIME_IDLE_TTL_MS: '50',
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE0_FAKE_PID_FILE: pidFile }),
  })
  try {
    const first = await client.callTool({
      name: 'dsh_delegate',
      arguments: { task: 'create an idle session before TTL cleanup', cwd: root },
    })
    assert.equal(first.structuredContent.ok, true)
    const idle = await client.callTool({
      name: 'dsh_status',
      arguments: { sessionId: first.structuredContent.sessionId },
    })
    assert.equal(idle.structuredContent.status, 'idle')

    await waitForMissing(pidFile)
    const expired = await client.callTool({
      name: 'dsh_status',
      arguments: { sessionId: first.structuredContent.sessionId },
    })
    assert.equal(expired.isError, true)
    assert.equal(expired.structuredContent.status, 'expired')
    assert.equal(expired.structuredContent.error.code, 'SESSION_NOT_ACTIVE')

    const continued = await client.callTool({
      name: 'dsh_continue',
      arguments: {
        sessionId: first.structuredContent.sessionId,
        task: 'this must not start a replacement runtime',
      },
    })
    assert.equal(continued.isError, true)
    assert.equal(continued.structuredContent.error.code, 'SESSION_NOT_ACTIVE')
    assert.equal(await access(pidFile).then(() => true).catch(() => false), false)
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

test('missing session status and continuation are structured without starting a runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase2-missing-'))
  const { client, transport } = await connectClient()
  try {
    const status = await client.callTool({
      name: 'dsh_status',
      arguments: { sessionId: 'dsh-phase2-missing-session' },
    })
    assert.equal(status.isError, true)
    assert.equal(status.structuredContent.status, 'missing')
    assert.equal(status.structuredContent.error.code, 'SESSION_NOT_FOUND')

    const continued = await client.callTool({
      name: 'dsh_continue',
      arguments: { sessionId: 'dsh-phase2-missing-session', task: 'must not run' },
    })
    assert.equal(continued.isError, true)
    assert.equal(continued.structuredContent.error.code, 'SESSION_NOT_FOUND')
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

test('SessionRegistry reports running, idle, expired, and missing coarse states', () => {
  const registry = new SessionRegistry()
  registry.create('session-a', '/tmp/runtime-a', '/tmp/workspace')
  assert.equal(registry.status('session-a').status, 'running')
  registry.markIdle('session-a')
  assert.equal(registry.status('session-a').status, 'idle')
  registry.expireRuntime('/tmp/runtime-a')
  assert.equal(registry.status('session-a').status, 'expired')
  assert.equal(registry.status('missing-session').status, 'missing')
})

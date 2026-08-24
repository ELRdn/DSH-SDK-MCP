import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const serverEntry = join(projectRoot, 'dist', 'index.js')
const fakeRuntime = join(here, 'fake-runtime.mjs')

function phase3Environment(overrides = {}) {
  return {
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'parallel-context-slow']),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DEEPSEEK_API_KEY: 'sk-phase3-test-secret',
    ...overrides,
  }
}

async function connectClient(overrides = {}) {
  const stderrChunks = []
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectRoot,
    env: phase3Environment(overrides),
    stderr: 'pipe',
  })
  transport.stderr?.on('data', (chunk) => stderrChunks.push(chunk))
  const client = new Client({ name: 'dsh-sdk-mcp-phase3-test', version: '0.3.0' })
  await client.connect(transport)
  return { client, transport, stderrChunks }
}

async function closeClient(client, transport) {
  await client.close().catch(() => {})
  await transport.close().catch(() => {})
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function waitForCount(directory, suffix, count, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = (await readdir(directory)).filter((entry) => entry.endsWith(suffix))
    if (entries.length >= count) return entries
    await sleep(25)
  }
  throw new Error(`Timed out waiting for ${count} ${suffix} files in ${directory}`)
}

async function waitForEmpty(directory, suffix = '.pid', timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = (await readdir(directory)).filter((entry) => entry.endsWith(suffix))
    if (entries.length === 0) return
    await sleep(25)
  }
  throw new Error(`Timed out waiting for ${suffix} files to disappear in ${directory}`)
}

async function readAudits(directory) {
  const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.json'))
  return Promise.all(entries.map(async (entry) => JSON.parse(await readFile(join(directory, entry), 'utf8'))))
}

function maximumOverlap(intervals) {
  const events = intervals.flatMap((interval) => [
    { time: interval.startAt, delta: 1 },
    { time: interval.endAt, delta: -1 },
  ]).sort((left, right) => left.time - right.time || left.delta - right.delta)
  let active = 0
  let maximum = 0
  for (const event of events) {
    active += event.delta
    maximum = Math.max(maximum, active)
  }
  return maximum
}

test('dsh_parallel overlaps disjoint workers, preserves order, and returns continuable sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase3-overlap-'))
  const workspaceA = await mkdtemp(join(root, 'workspace-a-'))
  const workspaceB = await mkdtemp(join(root, 'workspace-b-'))
  const auditDir = await mkdtemp(join(root, 'audit-'))
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'parallel-context-slow']),
    DSH_PHASE3_FAKE_AUDIT_DIR: auditDir,
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE3_FAKE_AUDIT_DIR: auditDir }),
  })
  try {
    const result = await client.callTool({
      name: 'dsh_parallel',
      arguments: {
        tasks: [
          { task: 'Remember PARALLEL_WORKER_A_MARKER', cwd: workspaceA },
          { task: 'Remember PARALLEL_WORKER_B_MARKER', cwd: workspaceB },
        ],
      },
    })
    assert.equal(result.isError, undefined, JSON.stringify(result))
    assert.equal(result.structuredContent.ok, true)
    assert.deepEqual(result.structuredContent.results.map((worker) => worker.index), [0, 1])
    assert.equal(result.structuredContent.results.every((worker) => worker.ok), true)
    assert.equal(new Set(result.structuredContent.results.map((worker) => worker.sessionId)).size, 2)
    assert.match(result.structuredContent.results[0].finalResponse, /PARALLEL_WORKER_A_MARKER/)
    assert.match(result.structuredContent.results[1].finalResponse, /PARALLEL_WORKER_B_MARKER/)

    await waitForCount(auditDir, '.json', 2)
    const audits = await readAudits(auditDir)
    assert.equal(audits.length, 2)
    assert.equal(maximumOverlap(audits), 2)
    assert.ok(Math.max(...audits.map((audit) => audit.startAt)) < Math.min(...audits.map((audit) => audit.endAt)))

    for (const worker of result.structuredContent.results) {
      const status = await client.callTool({
        name: 'dsh_status',
        arguments: { sessionId: worker.sessionId },
      })
      assert.equal(status.structuredContent.status, 'idle')
    }

    const continued = await client.callTool({
      name: 'dsh_continue',
      arguments: {
        sessionId: result.structuredContent.results[1].sessionId,
        task: 'Repeat the marker you remembered.',
      },
    })
    assert.equal(continued.isError, undefined, JSON.stringify(continued))
    assert.match(continued.structuredContent.finalResponse, /PARALLEL_WORKER_B_MARKER/)
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

test('dsh_parallel enforces DSH_MCP_MAX_PARALLEL without changing result order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase3-cap-'))
  const workspaces = await Promise.all([
    mkdtemp(join(root, 'workspace-a-')),
    mkdtemp(join(root, 'workspace-b-')),
    mkdtemp(join(root, 'workspace-c-')),
  ])
  const auditDir = await mkdtemp(join(root, 'audit-'))
  const { client, transport } = await connectClient({
    DSH_MCP_MAX_PARALLEL: '2',
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'parallel-slow']),
    DSH_PHASE3_FAKE_AUDIT_DIR: auditDir,
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE3_FAKE_AUDIT_DIR: auditDir }),
  })
  try {
    const result = await client.callTool({
      name: 'dsh_parallel',
      arguments: {
        tasks: workspaces.map((cwd, index) => ({ task: `CAP_WORKER_${index}`, cwd })),
      },
    })
    assert.equal(result.structuredContent.ok, true)
    assert.deepEqual(result.structuredContent.results.map((worker) => worker.index), [0, 1, 2])
    assert.equal(result.structuredContent.results.every((worker) => worker.ok), true)
    await waitForCount(auditDir, '.json', 3)
    const audits = await readAudits(auditDir)
    assert.equal(maximumOverlap(audits), 2)
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

test('same normalized workspace is rejected before any parallel runtime starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase3-collision-'))
  const auditDir = await mkdtemp(join(root, 'audit-'))
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'normal']),
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE3_FAKE_AUDIT_DIR: auditDir }),
  })
  try {
    const result = await client.callTool({
      name: 'dsh_parallel',
      arguments: {
        tasks: [
          { task: 'collision A', cwd: root },
          { task: 'collision B', cwd: join(root, 'nested', '..') },
        ],
      },
    })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error.code, 'SHARED_WORKSPACE')
    assert.deepEqual(result.structuredContent.results, [])
    assert.deepEqual(await readdir(auditDir), [])
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

test('parallel worker runtimes expire independently after idle TTL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase3-ttl-'))
  const workspaces = await Promise.all([
    mkdtemp(join(root, 'workspace-a-')),
    mkdtemp(join(root, 'workspace-b-')),
  ])
  const pidDir = await mkdtemp(join(root, 'pids-'))
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_IDLE_TTL_MS: '50',
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'normal']),
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE3_FAKE_PID_DIR: pidDir }),
  })
  try {
    const result = await client.callTool({
      name: 'dsh_parallel',
      arguments: { tasks: workspaces.map((cwd) => ({ task: 'idle TTL worker', cwd })) },
    })
    assert.equal(result.structuredContent.results.every((worker) => worker.ok), true)
    await waitForCount(pidDir, '.pid', 2)
    await waitForEmpty(pidDir)
    for (const worker of result.structuredContent.results) {
      const status = await client.callTool({
        name: 'dsh_status',
        arguments: { sessionId: worker.sessionId },
      })
      assert.equal(status.isError, true)
      assert.equal(status.structuredContent.status, 'expired')
    }
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

test('one parallel worker can fail or time out without canceling siblings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase3-partial-'))
  const workspaces = await Promise.all([
    mkdtemp(join(root, 'workspace-success-')),
    mkdtemp(join(root, 'workspace-fail-')),
    mkdtemp(join(root, 'workspace-timeout-')),
  ])
  const pidDir = await mkdtemp(join(root, 'pids-'))
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_REQUEST_TIMEOUT_MS: '100',
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'parallel-mixed']),
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE3_FAKE_PID_DIR: pidDir }),
  })
  try {
    const result = await client.callTool({
      name: 'dsh_parallel',
      arguments: {
        tasks: [
          { task: 'SUCCESS_WORKER', cwd: workspaces[0] },
          { task: 'FAIL_WORKER', cwd: workspaces[1] },
          { task: 'TIMEOUT_WORKER', cwd: workspaces[2] },
        ],
      },
    })
    assert.equal(result.isError, undefined)
    assert.equal(result.structuredContent.results[0].ok, true)
    assert.equal(result.structuredContent.results[1].error.code, 'QUOTA')
    assert.equal(result.structuredContent.results[2].error.code, 'RUN_TIMEOUT')
    assert.equal(result.structuredContent.results[0].index, 0)
    assert.equal(result.structuredContent.results[1].index, 1)
    assert.equal(result.structuredContent.results[2].index, 2)

    const continued = await client.callTool({
      name: 'dsh_continue',
      arguments: {
        sessionId: result.structuredContent.results[0].sessionId,
        task: 'SUCCESS_WORKER follow-up',
      },
    })
    assert.equal(continued.isError, undefined)
    const timedOutStatus = await client.callTool({
      name: 'dsh_status',
      arguments: { sessionId: result.structuredContent.results[2].sessionId },
    })
    assert.equal(timedOutStatus.structuredContent.status, 'expired')
  } finally {
    await closeClient(client, transport)
    await waitForEmpty(pidDir)
    await rm(root, { recursive: true, force: true })
  }
})

test('aggregate parallel output is bounded while preserving per-worker length metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase3-bound-'))
  const workspaces = await Promise.all([
    mkdtemp(join(root, 'workspace-a-')),
    mkdtemp(join(root, 'workspace-b-')),
    mkdtemp(join(root, 'workspace-c-')),
    mkdtemp(join(root, 'workspace-d-')),
  ])
  const { client, transport } = await connectClient({
    DSH_MCP_MAX_PARALLEL: '4',
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'parallel-huge']),
  })
  try {
    const result = await client.callTool({
      name: 'dsh_parallel',
      arguments: { tasks: workspaces.map((cwd) => ({ task: 'large worker response', cwd })) },
    })
    const output = result.structuredContent
    assert.equal(output.ok, true)
    assert.equal(output.aggregateResponseTruncated, true)
    assert.ok(output.aggregateResponseLength > 300_000)
    assert.ok(JSON.stringify(output).length <= 300_000)
    assert.equal(output.results.every((worker) => worker.finalResponseTruncated), true)
    assert.equal(output.results.every((worker) => worker.finalResponseLength > worker.finalResponse.length), true)
    assert.ok(result.content[0].text.length < 5_000)
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

test('parallel result and stderr diagnostics redact secrets for every worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase3-secret-'))
  const workspaces = await Promise.all([
    mkdtemp(join(root, 'workspace-a-')),
    mkdtemp(join(root, 'workspace-b-')),
  ])
  const secret = 'PHASE3_BATCH_SECRET_123456789'
  const { client, transport, stderrChunks } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'secret-tool-fields']),
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE0_FAKE_SECRET: secret }),
  })
  try {
    const result = await client.callTool({
      name: 'dsh_parallel',
      arguments: { tasks: workspaces.map((cwd) => ({ task: 'redact worker diagnostics', cwd })) },
    })
    assert.equal(result.structuredContent.ok, true)
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal(Buffer.concat(stderrChunks).toString('utf8').includes(secret), false)
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

test('MCP shutdown during several active parallel workers leaves no pid files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase3-shutdown-'))
  const workspaces = await Promise.all([
    mkdtemp(join(root, 'workspace-a-')),
    mkdtemp(join(root, 'workspace-b-')),
    mkdtemp(join(root, 'workspace-c-')),
  ])
  const pidDir = await mkdtemp(join(root, 'pids-'))
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'parallel-slow']),
    DSH_PHASE3_FAKE_DELAY_MS: '5000',
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE3_FAKE_PID_DIR: pidDir }),
  })
  try {
    const batch = client.callTool({
      name: 'dsh_parallel',
      arguments: { tasks: workspaces.map((cwd) => ({ task: 'wait for shutdown', cwd })) },
    }).catch(() => undefined)
    await waitForCount(pidDir, '.pid', 3)
    await client.close()
    await transport.close().catch(() => {})
    await batch
    await waitForEmpty(pidDir)
  } finally {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
    await waitForEmpty(pidDir).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

function jsonLineReader(stream) {
  let buffer = ''
  const queue = []
  const waiters = []
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        const message = JSON.parse(line)
        const waiter = waiters.shift()
        if (waiter) waiter(message)
        else queue.push(message)
      } catch {}
    }
  })
  return () => {
    const message = queue.shift()
    if (message !== undefined) return Promise.resolve(message)
    return new Promise((resolveMessage) => waiters.push(resolveMessage))
  }
}

function sendJsonLine(stdin, message) {
  stdin.write(`${JSON.stringify(message)}\n`)
}

test('stdin EOF during several active parallel workers leaves no pid files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase3-eof-'))
  const workspaces = await Promise.all([
    mkdtemp(join(root, 'workspace-a-')),
    mkdtemp(join(root, 'workspace-b-')),
    mkdtemp(join(root, 'workspace-c-')),
  ])
  const pidDir = await mkdtemp(join(root, 'pids-'))
  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: phase3Environment({
      DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'parallel-slow']),
      DSH_PHASE3_FAKE_DELAY_MS: '5000',
      DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE3_FAKE_PID_DIR: pidDir }),
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const nextMessage = jsonLineReader(child.stdout)
  child.stderr.resume()
  const waitForExit = new Promise((resolveExit) => child.once('exit', resolveExit))
  try {
    sendJsonLine(child.stdin, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'phase3-eof-test', version: '0.3.0' },
      },
    })
    const initialize = await nextMessage()
    assert.equal(initialize.result.protocolVersion, '2025-11-25')
    sendJsonLine(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    sendJsonLine(child.stdin, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'dsh_parallel',
        arguments: { tasks: workspaces.map((cwd) => ({ task: 'wait for EOF', cwd })) },
      },
    })
    await waitForCount(pidDir, '.pid', 3)
    child.stdin.end()
    const exit = await Promise.race([
      waitForExit,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(undefined), 8_000)),
    ])
    assert.notEqual(exit, undefined, 'MCP server did not exit after stdin EOF')
    assert.equal(exit, 0)
    await waitForEmpty(pidDir)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await waitForEmpty(pidDir).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test } from 'node:test'

const MAX_DELEGATE_RESPONSE_CHARS = 100_000

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const serverEntry = join(projectRoot, 'dist', 'index.js')
const fakeRuntime = join(here, 'fake-runtime.mjs')

function phase1Environment(overrides = {}) {
  return {
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'normal']),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DEEPSEEK_API_KEY: 'sk-phase1-test-secret',
    ...overrides,
  }
}

async function connectClient(overrides = {}) {
  const stderrChunks = []
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectRoot,
    env: phase1Environment(overrides),
    stderr: 'pipe',
  })
  transport.stderr?.on('data', (chunk) => stderrChunks.push(chunk))
  const client = new Client({ name: 'dsh-sdk-mcp-phase1-test', version: '0.1.0' })
  await client.connect(transport)
  return { client, transport, stderrChunks }
}

async function closeClient(client, transport) {
  await client.close()
  await transport.close().catch(() => {})
}

async function missing(path) {
  await assert.rejects(access(path))
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

async function readPid(path) {
  try {
    const value = Number((await readFile(path, 'utf8')).trim())
    return Number.isInteger(value) && value > 0 ? value : undefined
  } catch {
    return undefined
  }
}

async function terminatePidFile(path) {
  const pid = await readPid(path)
  if (pid !== undefined) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
}

function jsonLineReader(stream) {
  let buffer = ''
  const queued = []
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
        else queued.push(message)
      } catch {
        // The test only waits for valid MCP response frames.
      }
    }
  })
  return () => {
    const message = queued.shift()
    if (message !== undefined) return Promise.resolve(message)
    return new Promise((resolve) => waiters.push(resolve))
  }
}

function sendJsonLine(stdin, message) {
  stdin.write(`${JSON.stringify(message)}\n`)
}

test('MCP tools/list exposes exactly the Phase 1 tools and dsh_health is structured', async () => {
  const { client, transport } = await connectClient()
  try {
    const listed = await client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ['dsh_delegate', 'dsh_health'],
    )

    const health = await client.callTool({ name: 'dsh_health' })
    assert.equal(health.isError, undefined)
    assert.equal(health.structuredContent.runtimeConfigured, true)
    assert.equal(health.structuredContent.provider, 'deepseek-official')
    assert.equal(health.structuredContent.model, 'deepseek-v4-flash')
    assert.equal(JSON.stringify(health).includes('sk-phase1-test-secret'), false)
  } finally {
    await closeClient(client, transport)
  }
})

test('dsh_health distinguishes configured runtime from verified readiness', async () => {
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_COMMAND: join(tmpdir(), 'missing-dsh-runtime.exe'),
    DSH_MCP_RUNTIME_ARGS: '[]',
    DEEPSEEK_API_KEY: undefined,
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DEEPSEEK_API_KEY: 'override-health-secret' }),
  })
  try {
    const health = await client.callTool({ name: 'dsh_health', arguments: {} })
    assert.equal(health.isError, undefined)
    assert.equal(health.structuredContent.runtimeConfigured, true)
    assert.equal(health.structuredContent.runtimeReady, false)
    assert.equal(health.structuredContent.runtimeReadiness, 'unavailable')
    assert.equal(health.structuredContent.providerReady, false)
    assert.equal(health.structuredContent.providerReadiness, 'unavailable')
    assert.equal(health.structuredContent.credentialConfigured, true)
    assert.equal(health.structuredContent.ok, false)
    assert.equal(health.structuredContent.error.code, 'RUNTIME_START_FAILED')
  } finally {
    await closeClient(client, transport)
  }
})

test('dsh_health bounds provider and model fields', async () => {
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_COMMAND: join(tmpdir(), 'missing-dsh-runtime.exe'),
    DSH_MCP_RUNTIME_ARGS: '[]',
    DSH_MCP_MODEL: 'm'.repeat(5_000),
  })
  try {
    const health = await client.callTool({ name: 'dsh_health', arguments: {} })
    assert.equal(health.isError, undefined)
    assert.ok(health.structuredContent.model.length <= 401)
    assert.ok(health.structuredContent.provider.length <= 401)
  } finally {
    await closeClient(client, transport)
  }
})

test('dsh_health does not claim provider readiness when the health turn is quota-blocked', async () => {
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'quota']),
  })
  try {
    const health = await client.callTool({ name: 'dsh_health', arguments: {} })
    assert.equal(health.isError, undefined)
    assert.equal(health.structuredContent.runtimeReady, true)
    assert.equal(health.structuredContent.runtimeReadiness, 'verified')
    assert.equal(health.structuredContent.providerReady, false)
    assert.equal(health.structuredContent.providerReadiness, 'unavailable')
    assert.equal(health.structuredContent.ok, false)
    assert.equal(health.structuredContent.error.code, 'QUOTA')
    assert.equal(JSON.stringify(health).includes('sk-phase1-test-secret'), false)
  } finally {
    await closeClient(client, transport)
  }
})

test('dsh_health requires the provider health marker before verified readiness', async () => {
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'health-no-marker']),
  })
  try {
    const health = await client.callTool({ name: 'dsh_health', arguments: {} })
    assert.equal(health.isError, undefined)
    assert.equal(health.structuredContent.runtimeReady, true)
    assert.equal(health.structuredContent.runtimeReadiness, 'verified')
    assert.equal(health.structuredContent.providerReady, false)
    assert.equal(health.structuredContent.providerReadiness, 'unavailable')
    assert.equal(health.structuredContent.ok, false)
    assert.equal(health.structuredContent.error.code, 'PROVIDER_PROBE_FAILED')
  } finally {
    await closeClient(client, transport)
  }
})

test('dsh_health rejects a provider response that only contains a health-marker substring', async () => {
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'health-superstring']),
  })
  try {
    const health = await client.callTool({ name: 'dsh_health', arguments: {} })
    assert.equal(health.isError, undefined)
    assert.equal(health.structuredContent.runtimeReady, true)
    assert.equal(health.structuredContent.providerReady, false)
    assert.equal(health.structuredContent.providerReadiness, 'unavailable')
    assert.equal(health.structuredContent.ok, false)
    assert.equal(health.structuredContent.error.code, 'PROVIDER_PROBE_FAILED')
  } finally {
    await closeClient(client, transport)
  }
})

test('dsh_health reports unverified readiness while a delegation owns the runtime gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-health-busy-'))
  const pidFile = join(root, 'fake-runtime.pid')
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'timeout']),
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE0_FAKE_PID_FILE: pidFile }),
    DSH_MCP_RUNTIME_REQUEST_TIMEOUT_MS: '5000',
  })
  try {
    const delegation = client.callTool({
      name: 'dsh_delegate',
      arguments: { task: 'hold the runtime gate', cwd: root },
    })
    await waitForPath(pidFile)
    const health = await client.callTool({ name: 'dsh_health', arguments: {} })
    assert.equal(health.isError, undefined)
    assert.equal(health.structuredContent.ok, false)
    assert.equal(health.structuredContent.runtimeReady, false)
    assert.equal(health.structuredContent.runtimeReadiness, 'unverified')
    assert.equal(health.structuredContent.providerReady, false)
    assert.equal(health.structuredContent.providerReadiness, 'unverified')
    assert.equal(health.structuredContent.error.code, 'RUNTIME_BUSY')
    await client.close()
    await transport.close().catch(() => {})
    await delegation.catch(() => undefined)
    await missing(pidFile)
  } finally {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
    await terminatePidFile(pidFile)
    await rm(root, { recursive: true, force: true })
  }
})

test('dsh_health provider probe timeout is structured and preserves runtime readiness only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-health-timeout-'))
  const pidFile = join(root, 'fake-runtime.pid')
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'accept-hang']),
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE0_FAKE_PID_FILE: pidFile }),
    DSH_MCP_RUNTIME_REQUEST_TIMEOUT_MS: '50',
  })
  try {
    const health = await client.callTool({ name: 'dsh_health', arguments: {} })
    assert.equal(health.isError, undefined)
    assert.equal(health.structuredContent.ok, false)
    assert.equal(health.structuredContent.runtimeReady, true)
    assert.equal(health.structuredContent.runtimeReadiness, 'verified')
    assert.equal(health.structuredContent.providerReady, false)
    assert.equal(health.structuredContent.providerReadiness, 'unavailable')
    assert.equal(health.structuredContent.error.code, 'RUN_TIMEOUT')
    await missing(pidFile)
  } finally {
    await closeClient(client, transport)
    await terminatePidFile(pidFile)
    await rm(root, { recursive: true, force: true })
  }
})

test('stderr-derived credential values never reach structured or text MCP content', async () => {
  const secret = 'NONSTANDARD_REVIEW_SECRET_123456'
  const { client, transport, stderrChunks } = await connectClient({
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([
      '-e',
      `process.stderr.write('credential ${secret}'); process.exit(17)`,
    ]),
    DEEPSEEK_API_KEY: secret,
  })
  try {
    const result = await client.callTool({
      name: 'dsh_delegate',
      arguments: { task: 'trigger sanitized runtime failure', cwd: projectRoot },
    })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error.code, 'RUNTIME_START_FAILED')
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal(result.content.some((item) => item.type === 'text' && item.text.includes(secret)), false)
    assert.equal(Buffer.concat(stderrChunks).toString('utf8').includes(secret), false)
  } finally {
    await closeClient(client, transport)
  }
})

test('arbitrarily named runtime override values are scrubbed from stderr-derived MCP errors', async () => {
  const secret = 'ARBITRARY_OVERRIDE_SECRET_123456789'
  const { client, transport } = await connectClient({
    DEEPSEEK_API_KEY: undefined,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([
      '-e',
      'process.stderr.write(process.env.FOO); process.exit(17)',
    ]),
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ FOO: secret }),
  })
  try {
    const result = await client.callTool({
      name: 'dsh_delegate',
      arguments: { task: 'trigger arbitrary override failure', cwd: projectRoot },
    })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error.code, 'RUNTIME_START_FAILED')
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal(result.content.some((item) => item.type === 'text' && item.text.includes(secret)), false)
  } finally {
    await closeClient(client, transport)
  }
})

test('dsh_delegate returns the fake DSH response, redacts secrets, and reaps the runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-test-'))
  const pidFile = join(root, 'fake-runtime.pid')
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE0_FAKE_PID_FILE: pidFile }),
  })
  try {
    const result = await client.callTool({
      name: 'dsh_delegate',
      arguments: {
        task: 'Reply with the marker and do not reveal sk-abcdefghijklmnopqrstuvwxyz1234',
        cwd: root,
      },
    })
    assert.equal(result.isError, undefined)
    assert.equal(result.structuredContent.ok, true)
    assert.match(result.structuredContent.finalResponse, /FAKE_RESPONSE/)
    assert.equal(result.structuredContent.finalResponse.includes('sk-abcdefghijklmnopqrstuvwxyz1234'), false)
    assert.equal(result.structuredContent.cwd, resolve(root))
  } finally {
    await closeClient(client, transport)
    await missing(pidFile)
    await rm(root, { recursive: true, force: true })
  }
})

test('MCP client shutdown interrupts a starting runtime and reaps it cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-shutdown-'))
  const pidFile = join(root, 'fake-runtime.pid')
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'timeout']),
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE0_FAKE_PID_FILE: pidFile }),
    DSH_MCP_RUNTIME_REQUEST_TIMEOUT_MS: '5000',
  })
  try {
    const run = client.callTool({
      name: 'dsh_delegate',
      arguments: { task: 'shutdown while starting', cwd: root },
    }).catch(() => undefined)
    await waitForPath(pidFile)
    await client.close()
    await transport.close().catch(() => {})
    await run
    await missing(pidFile)
  } finally {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
    await terminatePidFile(pidFile)
    await rm(root, { recursive: true, force: true })
  }
})

test('dsh_delegate rejects non-absolute cwd before starting DSH', async () => {
  const { client, transport } = await connectClient()
  try {
    const result = await client.callTool({
      name: 'dsh_delegate',
      arguments: { task: 'must not run', cwd: 'relative/workspace' },
    })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error.code, 'INVALID_CWD')
  } finally {
    await closeClient(client, transport)
  }
})

test('concurrent dsh_delegate calls reject the second root run with RUNTIME_BUSY', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-concurrency-'))
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'slow']),
  })
  try {
    const results = await Promise.all([
      client.callTool({ name: 'dsh_delegate', arguments: { task: 'slow first', cwd: root } }),
      client.callTool({ name: 'dsh_delegate', arguments: { task: 'second', cwd: root } }),
    ])
    const errors = results.filter((result) => result.isError === true)
    const successes = results.filter((result) => result.structuredContent.ok === true)
    assert.equal(errors.length, 1)
    assert.equal(successes.length, 1)
    assert.equal(errors[0].structuredContent.error.code, 'RUNTIME_BUSY')
    assert.equal(
      errors[0].structuredContent.error.message,
      'The DSH runtime already has an active delegation',
    )
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

for (const [mode, expectedCode] of [
  ['missing-credential', 'MISSING_CREDENTIAL'],
  ['quota', 'QUOTA'],
  ['rate-limit', 'RATE_LIMITED'],
]) {
  test(`dsh_delegate maps ${expectedCode} to structured MCP error`, async () => {
    const root = await mkdtemp(join(tmpdir(), `dsh-sdk-mcp-phase1-${mode}-`))
    const { client, transport } = await connectClient({
      DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, mode]),
    })
    try {
      const result = await client.callTool({
        name: 'dsh_delegate',
        arguments: { task: 'trigger a structured DSH classification', cwd: root },
      })
      assert.equal(result.isError, true)
      assert.equal(result.structuredContent.ok, false)
      assert.equal(result.structuredContent.error.code, expectedCode)
      assert.equal(JSON.stringify(result).includes('sk-phase1-test-secret'), false)
    } finally {
      await closeClient(client, transport)
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('transport stderr text cannot override structured lifecycle classification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-classification-'))
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'crash-quota']),
  })
  try {
    const result = await client.callTool({
      name: 'dsh_delegate',
      arguments: { task: 'trigger transport failure', cwd: root },
    })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error.code, 'RUNTIME_START_FAILED')
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime death after initialization is classified as RUNTIME_DIED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-runtime-died-'))
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'crash-mid-run']),
  })
  try {
    const result = await client.callTool({
      name: 'dsh_delegate',
      arguments: { task: 'crash after initialization', cwd: root },
    })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error.code, 'RUNTIME_DIED')
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

test('dsh_health marks an initialized-but-dead runtime unavailable', async () => {
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'crash-mid-run']),
  })
  try {
    const health = await client.callTool({ name: 'dsh_health', arguments: {} })
    assert.equal(health.isError, undefined)
    assert.equal(health.structuredContent.runtimeReady, false)
    assert.equal(health.structuredContent.runtimeReadiness, 'unavailable')
    assert.equal(health.structuredContent.providerReady, false)
    assert.equal(health.structuredContent.error.code, 'RUNTIME_DIED')
  } finally {
    await closeClient(client, transport)
  }
})

test('provider mismatch during initialization is a typed DSH initialization error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-provider-mismatch-'))
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'provider-mismatch']),
  })
  try {
    const result = await client.callTool({
      name: 'dsh_delegate',
      arguments: { task: 'trigger initialization mismatch', cwd: root },
    })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error.code, 'DSH_INITIALIZE_FAILED')
    assert.equal(JSON.stringify(result).includes('sk-phase1-test-secret'), false)
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

test('JSON-RPC response errors receive an explicit structured DSH classification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-rpc-error-'))
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'prompt-rpc-error']),
  })
  try {
    const result = await client.callTool({
      name: 'dsh_delegate',
      arguments: { task: 'trigger a JSON-RPC response error', cwd: root },
    })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error.code, 'DSH_RPC_ERROR')
    assert.equal(JSON.stringify(result).includes('sk-phase1-test-secret'), false)
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

test('delegation timeout is structured and the runtime is reaped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-timeout-'))
  const pidFile = join(root, 'fake-runtime.pid')
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'timeout']),
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE0_FAKE_PID_FILE: pidFile }),
    DSH_MCP_RUNTIME_REQUEST_TIMEOUT_MS: '50',
  })
  try {
    const result = await client.callTool({
      name: 'dsh_delegate',
      arguments: { task: 'trigger timeout', cwd: root },
    })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error.code, 'RUN_TIMEOUT')
    await missing(pidFile)
  } finally {
    await closeClient(client, transport)
    await terminatePidFile(pidFile)
    await rm(root, { recursive: true, force: true })
  }
})

test('delegation deadline covers an accepted prompt that never becomes idle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-accepted-hang-'))
  const pidFile = join(root, 'fake-runtime.pid')
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'accept-hang']),
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE0_FAKE_PID_FILE: pidFile }),
    DSH_MCP_RUNTIME_REQUEST_TIMEOUT_MS: '50',
  })
  try {
    const result = await client.callTool({
      name: 'dsh_delegate',
      arguments: { task: 'accept the prompt and never send idle', cwd: root },
    })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error.code, 'RUN_TIMEOUT')
    await missing(pidFile)
  } finally {
    await closeClient(client, transport)
    await terminatePidFile(pidFile)
    await rm(root, { recursive: true, force: true })
  }
})

test('delegate response is bounded and reports truncation metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-response-limit-'))
  const { client, transport } = await connectClient()
  try {
    const result = await client.callTool({
      name: 'dsh_delegate',
      arguments: {
        task: 'x'.repeat(MAX_DELEGATE_RESPONSE_CHARS + 2_000),
        cwd: root,
      },
    })
    assert.equal(result.isError, undefined)
    assert.equal(result.structuredContent.ok, true)
    assert.equal(result.structuredContent.finalResponseTruncated, true)
    assert.ok(result.structuredContent.finalResponseLength > MAX_DELEGATE_RESPONSE_CHARS)
    assert.equal(result.structuredContent.finalResponse.length, MAX_DELEGATE_RESPONSE_CHARS + 1)
    assert.equal(result.content[0].text.includes('"finalResponseTruncated":true'), true)
  } finally {
    await closeClient(client, transport)
    await rm(root, { recursive: true, force: true })
  }
})

test('MCP stdio server starts with protocol-only stdout and shuts down without an orphan server process', async () => {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: phase1Environment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  child.stdin.end()
  const exit = await new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  assert.equal(exit.code, 0)
  assert.equal(exit.signal, null)
  const stdoutText = Buffer.concat(stdout).toString('utf8').trim()
  assert.equal(stdoutText, '')
  assert.equal(Buffer.concat(stderr).toString('utf8').includes('sk-phase1-test-secret'), false)
})

test('stdin EOF closes an in-flight DSH runtime without an orphan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-stdin-eof-'))
  const pidFile = join(root, 'fake-runtime.pid')
  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: phase1Environment({
      DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'timeout']),
      DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE0_FAKE_PID_FILE: pidFile }),
      DSH_MCP_RUNTIME_REQUEST_TIMEOUT_MS: '5000',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const nextMessage = jsonLineReader(child.stdout)
  child.stderr.resume()
  const waitForExit = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  try {
    sendJsonLine(child.stdin, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'phase1-eof-test', version: '0.1.0' },
      },
    })
    const initialize = await nextMessage()
    assert.equal(initialize.result.protocolVersion, '2025-11-25')
    sendJsonLine(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    sendJsonLine(child.stdin, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'dsh_delegate', arguments: { task: 'hang until EOF', cwd: root } },
    })
    await waitForPath(pidFile)
    child.stdin.end()
    const exit = await Promise.race([
      waitForExit,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(undefined), 5_000)),
    ])
    assert.ok(exit, 'MCP server did not exit after stdin EOF')
    assert.equal(exit.code, 0)
    assert.equal(exit.signal, null)
    await missing(pidFile)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await terminatePidFile(pidFile)
    await rm(root, { recursive: true, force: true })
  }
})

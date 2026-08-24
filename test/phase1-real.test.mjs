import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test } from 'node:test'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = join(projectRoot, 'dist', 'index.js')
const runtimeProbe = join(projectRoot, 'scripts', 'runtime-probe.mjs')

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 50))
    }
  }
  throw new Error(`Timed out waiting for audit file: ${path}`)
}

function processAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessesToExit(pids, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processAlive(pid))) return
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50))
  }
  assert.deepEqual(pids.filter(processAlive), [])
}

test('opt-in real OpenCode Go Phase 2 smoke', {
  skip: process.env.DSH_MCP_PHASE1_REAL_SMOKE !== '1'
    && process.env.DSH_MCP_PHASE2_REAL_SMOKE !== '1',
}, async () => {
  const auditRoot = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-real-audit-'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase1-real-workspace-'))
  const auditPath = join(auditRoot, 'runtime-audit.json')
  const configuredCommand = process.env.DSH_MCP_RUNTIME_COMMAND
  const configuredArgs = JSON.parse(process.env.DSH_MCP_RUNTIME_ARGS ?? '[]')
  assert.equal(typeof configuredCommand, 'string')
  assert.ok(Array.isArray(configuredArgs))

  // Keep the underlying OpenCode Go runtime real; the existing Phase 0 probe
  // only audits its JSON-RPC stdout, stderr, and process cleanup.
  const serverEnvironment = {
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([
      runtimeProbe,
      configuredCommand,
      JSON.stringify(configuredArgs),
      auditPath,
      projectRoot,
    ]),
    DSH_MCP_RUNTIME_CWD: projectRoot,
  }
  const secretValues = [serverEnvironment.OPENCODE_API_KEY, serverEnvironment.OPENCODE_GO_API_KEY]
    .filter((value) => typeof value === 'string' && value.length > 0)

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectRoot,
    env: serverEnvironment,
    stderr: 'pipe',
  })
  const stderrChunks = []
  transport.stderr?.on('data', (chunk) => stderrChunks.push(chunk))
  const client = new Client({ name: 'dsh-sdk-mcp-phase2-real-test', version: '0.2.0' })
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ['dsh_continue', 'dsh_delegate', 'dsh_health', 'dsh_status'],
    )
    const health = await client.callTool({ name: 'dsh_health', arguments: {} })
    assert.equal(health.isError, undefined)
    assert.equal(health.structuredContent.ok, true, JSON.stringify(health))
    assert.equal(health.structuredContent.runtimeConfigured, true)
    assert.equal(health.structuredContent.runtimeReady, true)
    assert.equal(health.structuredContent.runtimeReadiness, 'verified')
    assert.equal(health.structuredContent.providerConfigured, true)
    assert.equal(health.structuredContent.providerReady, true)
    assert.equal(health.structuredContent.providerReadiness, 'verified')
    for (const secret of secretValues) {
      assert.equal(JSON.stringify(health).includes(secret), false)
    }

    const invalidCwd = await client.callTool({
      name: 'dsh_delegate',
      arguments: { task: 'must be rejected', cwd: 'relative/real-smoke-cwd' },
    })
    assert.equal(invalidCwd.isError, true)
    assert.equal(invalidCwd.structuredContent.error.code, 'INVALID_CWD')

    const result = await client.callTool({
      name: 'dsh_delegate',
      arguments: {
        task: 'Remember this exact marker: DSH_PHASE2_REAL_OK. Reply with exactly: DSH_PHASE2_REAL_OK',
        cwd: workspace,
      },
    })
    assert.equal(result.isError, undefined, JSON.stringify(result))
    assert.equal(result.structuredContent.ok, true, JSON.stringify(result))
    assert.match(result.structuredContent.finalResponse, /DSH_PHASE2_REAL_OK/)
    assert.ok(result.structuredContent.finalResponse.trim().length > 0)
    assert.equal(result.structuredContent.finalResponseTruncated, false)
    assert.equal(
      result.structuredContent.finalResponseLength,
      result.structuredContent.finalResponse.length,
    )
    for (const secret of secretValues) {
      assert.equal(JSON.stringify(result).includes(secret), false)
    }

    const status = await client.callTool({
      name: 'dsh_status',
      arguments: { sessionId: result.structuredContent.sessionId },
    })
    assert.equal(status.isError, undefined)
    assert.equal(status.structuredContent.status, 'idle')

    const continued = await client.callTool({
      name: 'dsh_continue',
      arguments: {
        sessionId: result.structuredContent.sessionId,
        task: 'What exact marker did you remember? Reply with exactly: DSH_PHASE2_REAL_OK',
      },
    })
    assert.equal(continued.isError, undefined, JSON.stringify(continued))
    assert.equal(continued.structuredContent.ok, true, JSON.stringify(continued))
    assert.equal(continued.structuredContent.sessionId, result.structuredContent.sessionId)
    assert.match(continued.structuredContent.finalResponse, /DSH_PHASE2_REAL_OK/)
    assert.ok(continued.structuredContent.finalResponse.trim().length > 0)

    const continuedTwice = await client.callTool({
      name: 'dsh_continue',
      arguments: {
        sessionId: result.structuredContent.sessionId,
        task: 'Repeat the exact remembered marker once more: DSH_PHASE2_REAL_OK',
      },
    })
    assert.equal(continuedTwice.isError, undefined, JSON.stringify(continuedTwice))
    assert.equal(continuedTwice.structuredContent.ok, true, JSON.stringify(continuedTwice))
    assert.equal(continuedTwice.structuredContent.sessionId, result.structuredContent.sessionId)
    assert.match(continuedTwice.structuredContent.finalResponse, /DSH_PHASE2_REAL_OK/)
    assert.ok(continuedTwice.structuredContent.finalResponse.trim().length > 0)
    for (const secret of secretValues) {
      assert.equal(JSON.stringify(continued).includes(secret), false)
      assert.equal(JSON.stringify(continuedTwice).includes(secret), false)
    }
  } finally {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})

    const audit = await waitForFile(auditPath)
    assert.deepEqual(audit.nonProtocolLines, [])
    assert.equal(audit.childExitCode, 0)
    assert.equal(audit.childSignal, null)
    await waitForProcessesToExit([audit.probePid, audit.childPid].filter(Boolean))

    const stderr = Buffer.concat(stderrChunks).toString('utf8')
    for (const secret of secretValues) assert.equal(stderr.includes(secret), false)
    await access(auditPath)
    await rm(auditRoot, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test } from 'node:test'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = join(projectRoot, 'dist', 'index.js')
const runtimeProbe = join(projectRoot, 'scripts', 'parallel-runtime-probe.mjs')

async function waitForAuditFiles(directory, count, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.json'))
    if (entries.length >= count) return entries
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
  }
  throw new Error(`Timed out waiting for ${count} runtime audits`)
}

async function waitForProcessesToExit(pids, timeoutMs = 15_000) {
  const alive = (pid) => {
    if (typeof pid !== 'number' || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pids.every((pid) => !alive(pid))) return
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
  }
  assert.deepEqual(pids.filter(alive), [])
}

async function waitForAuditCompletion(directory, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const audits = await Promise.all((await readdir(directory))
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))))
    if (audits.length > 0 && audits.every((audit) => audit.childExitCode === 0 && audit.childSignal === null)) {
      return audits
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
  }
  throw new Error('Timed out waiting for all real runtime audits to close cleanly')
}

test('opt-in real OpenCode Go Phase 3 parallel smoke', {
  skip: process.env.DSH_MCP_PHASE3_REAL_SMOKE !== '1',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase3-real-'))
  const auditDirectory = await mkdtemp(join(root, 'audits-'))
  const workspaceA = await mkdtemp(join(root, 'workspace-a-'))
  const workspaceB = await mkdtemp(join(root, 'workspace-b-'))
  const workspaceC = await mkdtemp(join(root, 'workspace-c-'))
  await Promise.all([
    writeFile(join(workspaceA, 'README.md'), '# REAL_WORKSPACE_A_HEADING\n', 'utf8'),
    writeFile(join(workspaceB, 'README.md'), '# REAL_WORKSPACE_B_HEADING\n', 'utf8'),
    writeFile(join(workspaceC, 'README.md'), '# REAL_WORKSPACE_C_HEADING\n', 'utf8'),
  ])

  const configuredCommand = process.env.DSH_MCP_RUNTIME_COMMAND
  const configuredArgs = JSON.parse(process.env.DSH_MCP_RUNTIME_ARGS ?? '[]')
  assert.equal(typeof configuredCommand, 'string')
  assert.ok(Array.isArray(configuredArgs))
  const serverEnvironment = {
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([
      runtimeProbe,
      configuredCommand,
      JSON.stringify(configuredArgs),
      auditDirectory,
      projectRoot,
    ]),
    DSH_MCP_RUNTIME_CWD: projectRoot,
    DSH_MCP_MAX_PARALLEL: '3',
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
  const client = new Client({ name: 'dsh-sdk-mcp-phase3-real-test', version: '0.3.0' })

  try {
    await client.connect(transport)
    const listed = await client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ['dsh_continue', 'dsh_delegate', 'dsh_health', 'dsh_parallel', 'dsh_parallel_worktree', 'dsh_status'],
    )
    const health = await client.callTool({ name: 'dsh_health', arguments: {} })
    assert.equal(health.isError, undefined)
    assert.equal(health.structuredContent.ok, true, JSON.stringify(health))
    for (const secret of secretValues) assert.equal(JSON.stringify(health).includes(secret), false)
    const auditsBeforeParallel = new Set((await readdir(auditDirectory)).filter((entry) => entry.endsWith('.json')))

    const startedAt = Date.now()
    const parallel = await client.callTool({
      name: 'dsh_parallel',
      arguments: {
        tasks: [
          { task: 'Inspect README.md and reply with exactly REAL_WORKSPACE_A_HEADING', cwd: workspaceA },
          { task: 'Inspect README.md and reply with exactly REAL_WORKSPACE_B_HEADING', cwd: workspaceB },
          { task: 'Inspect README.md and reply with exactly REAL_WORKSPACE_C_HEADING', cwd: workspaceC },
        ],
      },
    })
    const elapsedMs = Date.now() - startedAt
    assert.equal(parallel.isError, undefined, JSON.stringify(parallel))
    assert.equal(parallel.structuredContent.ok, true, JSON.stringify(parallel))
    assert.equal(parallel.structuredContent.results.length, 3)
    assert.deepEqual(parallel.structuredContent.results.map((worker) => worker.index), [0, 1, 2])
    assert.equal(parallel.structuredContent.results.every((worker) => worker.ok), true, JSON.stringify(parallel))
    assert.equal(new Set(parallel.structuredContent.results.map((worker) => worker.sessionId)).size, 3)
    assert.ok(parallel.structuredContent.results.every((worker) => worker.finalResponse.trim().length > 0))

    const newAuditNames = (await waitForAuditFiles(auditDirectory, auditsBeforeParallel.size + 3))
      .filter((name) => !auditsBeforeParallel.has(name))
    const parallelAudits = await Promise.all(newAuditNames.map(async (name) => (
      JSON.parse(await readFile(join(auditDirectory, name), 'utf8'))
    )))
    assert.equal(parallelAudits.length, 3)
    assert.equal(parallelAudits.every((audit) => audit.nonProtocolLines.length === 0), true)
    const intervals = parallelAudits.flatMap((audit) => audit.turnIntervals)
    assert.ok(intervals.length >= 3)
    assert.ok(Math.max(...intervals.map((interval) => interval.startAt)) < Math.min(...intervals.map((interval) => interval.endAt)))
    assert.ok(elapsedMs < 180_000)

    const continued = await client.callTool({
      name: 'dsh_continue',
      arguments: {
        sessionId: parallel.structuredContent.results[1].sessionId,
        task: 'Continue the same session and reply with the exact heading REAL_WORKSPACE_B_HEADING',
      },
    })
    assert.equal(continued.isError, undefined, JSON.stringify(continued))
    assert.equal(continued.structuredContent.ok, true, JSON.stringify(continued))
    assert.equal(continued.structuredContent.sessionId, parallel.structuredContent.results[1].sessionId)
    assert.match(continued.structuredContent.finalResponse, /REAL_WORKSPACE_B_HEADING/)
    for (const secret of secretValues) {
      assert.equal(JSON.stringify(parallel).includes(secret), false)
      assert.equal(JSON.stringify(continued).includes(secret), false)
    }
  } finally {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
    const audits = await waitForAuditCompletion(auditDirectory)
    await waitForProcessesToExit(audits.flatMap((audit) => [audit.probePid, audit.childPid]).filter(Boolean))
    const stderr = Buffer.concat(stderrChunks).toString('utf8')
    for (const secret of secretValues) assert.equal(stderr.includes(secret), false)
    await access(auditDirectory)
    await rm(root, { recursive: true, force: true })
  }
})

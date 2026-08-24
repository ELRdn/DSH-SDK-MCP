import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test } from 'node:test'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = join(projectRoot, 'dist', 'index.js')
const runtimeEntry = join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'lib', 'bin.js')
const runtimeProbe = join(projectRoot, 'scripts', 'parallel-runtime-probe.mjs')
const execFile = promisify(execFileCallback)

async function git(cwd, args) {
  const result = await execFile('git', args, { cwd, windowsHide: true, maxBuffer: 120_000 })
  return result.stdout.trim()
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase5-real-repo-'))
  await writeFile(join(root, 'README.md'), '# Phase 5 real integration smoke\n', 'utf8')
  await git(root, ['init', '--initial-branch=main'])
  await git(root, ['config', 'user.email', 'phase5-real@example.invalid'])
  await git(root, ['config', 'user.name', 'Phase 5 Real Smoke'])
  await git(root, ['add', 'README.md'])
  await git(root, ['commit', '-m', 'base'])
  return root
}

async function loadOpenCodeGoCredential() {
  const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
  const auth = JSON.parse(await readFile(authPath, 'utf8'))
  const key = auth?.['opencode-go']?.key
  assert.equal(typeof key, 'string', 'OpenCode Go credential is not configured')
  assert.ok(key.length > 0, 'OpenCode Go credential is empty')
  return key
}

async function waitForTurnAudits(directory, expectedNames, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const audits = await Promise.all(expectedNames.map(async (name) => {
      try {
        return JSON.parse(await readFile(join(directory, name), 'utf8'))
      } catch {
        return undefined
      }
    }))
    if (audits.every((audit) => audit !== undefined
      && Array.isArray(audit.turnIntervals)
      && audit.turnIntervals.length > 0
      && audit.turnIntervals.every((interval) => Number.isFinite(interval.startAt) && Number.isFinite(interval.endAt)))) {
      return audits
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250))
  }
  throw new Error('Timed out waiting for completed real DSH Phase 5 turn audits')
}

async function waitForAuditExit(directory, expectedNames, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const audits = await Promise.all(expectedNames.map(async (name) => (
      JSON.parse(await readFile(join(directory, name), 'utf8'))
    )))
    if (audits.every((audit) => audit.childExitCode === 0 && audit.childSignal === null)) return audits
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250))
  }
  throw new Error('Timed out waiting for real DSH Phase 5 child runtimes to exit')
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

async function waitForProcessesToExit(pids, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processAlive(pid))) return
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250))
  }
  assert.deepEqual(pids.filter(processAlive), [])
}

async function worktreeExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function taskFor(file, marker) {
  return `Create a new file named ${file} in the current workspace with exactly this one line and a trailing newline: ${marker}. Do not modify any other files. Then reply briefly that the file was created.`
}

test('opt-in real OpenCode Go Phase 5 review and integration success/conflict smoke', {
  skip: process.env.DSH_MCP_PHASE5_REAL_SMOKE !== '1',
}, async () => {
  const credential = await loadOpenCodeGoCredential()
  const repository = await createRepository()
  const auditDirectory = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase5-real-audits-'))
  const configuredCommand = process.env.DSH_MCP_RUNTIME_COMMAND?.trim() || process.execPath
  const configuredArgs = process.env.DSH_MCP_RUNTIME_ARGS === undefined
    ? [runtimeEntry]
    : JSON.parse(process.env.DSH_MCP_RUNTIME_ARGS)
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
    DSH_MCP_PROFILE: 'opencode-go',
    DSH_MCP_PROVIDER: 'opencode-go',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DSH_MCP_CORDIS_CONFIG: join(projectRoot, 'runtime', 'phase0.opencode-go.cordis.yml'),
    DSH_MCP_MAX_PARALLEL: '3',
    DSH_MCP_RUNTIME_IDLE_TTL_MS: '60000',
    DSH_MCP_RUNTIME_REQUEST_TIMEOUT_MS: '180000',
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PERMISSION_MODE: 'workspace-write' }),
    OPENCODE_API_KEY: credential,
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectRoot,
    env: serverEnvironment,
    stderr: 'pipe',
  })
  const stderrChunks = []
  transport.stderr?.on('data', (chunk) => stderrChunks.push(chunk))
  const client = new Client({ name: 'dsh-sdk-mcp-phase5-real-test', version: '0.5.0' })
  const callTool = (params) => client.callTool(params, undefined, { timeout: 240_000 })
  let workerPaths = []
  let successIntegrationPath
  let conflictIntegrationPath
  let auditNames = []
  let originalHead
  let originalStatus
  let originalIndex
  let originalBranch

  try {
    await client.connect(transport)
    const listed = await client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ['dsh_continue', 'dsh_delegate', 'dsh_health', 'dsh_integrate', 'dsh_parallel', 'dsh_parallel_worktree', 'dsh_status', 'dsh_worktree_review'],
    )

    let health = await callTool({ name: 'dsh_health', arguments: {} })
    if (health.structuredContent?.providerReady !== true && health.structuredContent?.error?.code === 'RUN_TIMEOUT') {
      health = await callTool({ name: 'dsh_health', arguments: {} })
    }
    assert.equal(health.isError, undefined)
    assert.equal(health.structuredContent.ok, true)
    assert.equal(health.structuredContent.runtimeReady, true)
    assert.equal(health.structuredContent.providerReady, true)
    assert.equal(JSON.stringify(health).includes(credential), false)

    originalHead = await git(repository, ['rev-parse', 'HEAD'])
    originalStatus = await git(repository, ['status', '--porcelain'])
    originalIndex = await git(repository, ['write-tree'])
    originalBranch = await git(repository, ['branch', '--show-current'])
    const auditBefore = new Set((await readdir(auditDirectory)).filter((entry) => entry.endsWith('.json')))
    const parallel = await callTool({
      name: 'dsh_parallel_worktree',
      arguments: {
        repo: repository,
        tasks: [
          { name: 'real-phase5-a', task: taskFor('conflict.txt', 'PHASE5_REAL_WORKER_A') },
          { name: 'real-phase5-b', task: taskFor('independent.txt', 'PHASE5_REAL_WORKER_B') },
          { name: 'real-phase5-c', task: taskFor('conflict.txt', 'PHASE5_REAL_WORKER_C') },
        ],
      },
    })
    assert.equal(parallel.isError, undefined, JSON.stringify(parallel))
    assert.equal(parallel.structuredContent.ok, true, JSON.stringify(parallel))
    assert.equal(parallel.structuredContent.results.length, 3)
    assert.deepEqual(parallel.structuredContent.results.map((worker) => worker.index), [0, 1, 2])
    assert.equal(new Set(parallel.structuredContent.results.map((worker) => worker.worktreePath)).size, 3)
    assert.equal(new Set(parallel.structuredContent.results.map((worker) => worker.baseCommit)).size, 1)
    assert.equal(parallel.structuredContent.results.every((worker) => worker.ok && worker.finalResponse.trim().length > 0), true)
    assert.equal(JSON.stringify(parallel).includes(credential), false)
    workerPaths = parallel.structuredContent.results.map((worker) => worker.worktreePath)

    const reviewed = await callTool({
      name: 'dsh_worktree_review',
      arguments: { sessionId: parallel.structuredContent.results[0].sessionId },
    })
    assert.equal(reviewed.isError, undefined, JSON.stringify(reviewed))
    assert.equal(reviewed.structuredContent.ok, true)
    assert.equal(reviewed.structuredContent.dirty, true)
    assert.equal(reviewed.structuredContent.changedFiles.includes('conflict.txt'), true)
    assert.equal(JSON.stringify(reviewed).includes(credential), false)

    for (const [index, worker] of parallel.structuredContent.results.entries()) {
      const expectedFile = index === 1 ? 'independent.txt' : 'conflict.txt'
      const expectedMarker = `PHASE5_REAL_WORKER_${String.fromCharCode(65 + index)}`
      assert.equal((await readFile(join(worker.worktreePath, expectedFile), 'utf8')).trim(), expectedMarker)
      assert.equal(await worktreeExists(join(repository, expectedFile)), false)
    }

    const success = await callTool({
      name: 'dsh_integrate',
      arguments: {
        repo: repository,
        workers: [
          { sessionId: parallel.structuredContent.results[0].sessionId },
          { sessionId: parallel.structuredContent.results[1].sessionId },
        ],
      },
    })
    assert.equal(success.isError, undefined, JSON.stringify(success))
    assert.equal(success.structuredContent.ok, true, JSON.stringify(success))
    assert.equal(success.structuredContent.status, 'applied')
    assert.deepEqual(success.structuredContent.appliedWorkers.map((worker) => worker.sessionId), [
      parallel.structuredContent.results[0].sessionId,
      parallel.structuredContent.results[1].sessionId,
    ])
    assert.equal(success.structuredContent.clean, true)
    successIntegrationPath = success.structuredContent.integrationWorktreePath
    assert.equal((await readFile(join(successIntegrationPath, 'conflict.txt'), 'utf8')).trim(), 'PHASE5_REAL_WORKER_A')
    assert.equal((await readFile(join(successIntegrationPath, 'independent.txt'), 'utf8')).trim(), 'PHASE5_REAL_WORKER_B')
    assert.equal(JSON.stringify(success).includes(credential), false)

    const conflict = await callTool({
      name: 'dsh_integrate',
      arguments: {
        repo: repository,
        workers: [
          { sessionId: parallel.structuredContent.results[0].sessionId },
          { sessionId: parallel.structuredContent.results[2].sessionId },
        ],
      },
    })
    assert.equal(conflict.isError, true, JSON.stringify(conflict))
    assert.equal(conflict.structuredContent.ok, false)
    assert.equal(conflict.structuredContent.status, 'conflict')
    assert.equal(conflict.structuredContent.error.code, 'INTEGRATION_CONFLICT')
    assert.deepEqual(conflict.structuredContent.appliedWorkers.map((worker) => worker.sessionId), [parallel.structuredContent.results[0].sessionId])
    assert.equal(conflict.structuredContent.conflictingWorker.sessionId, parallel.structuredContent.results[2].sessionId)
    assert.equal(conflict.structuredContent.pendingWorkers.some((worker) => worker.sessionId === parallel.structuredContent.results[2].sessionId), true)
    assert.equal(conflict.structuredContent.conflictingFiles.includes('conflict.txt'), true)
    assert.equal(conflict.structuredContent.integrationWorktreeDirty, true)
    conflictIntegrationPath = conflict.structuredContent.integrationWorktreePath
    const conflictText = await readFile(join(conflictIntegrationPath, 'conflict.txt'), 'utf8')
    assert.match(conflictText, /<<<<<<<|=======|>>>>>>>/)
    assert.equal(JSON.stringify(conflict).includes(credential), false)

    assert.equal(await git(repository, ['rev-parse', 'HEAD']), originalHead)
    assert.equal(await git(repository, ['status', '--porcelain']), originalStatus)
    assert.equal(await git(repository, ['write-tree']), originalIndex)
    assert.equal(await git(repository, ['branch', '--show-current']), originalBranch)
    assert.equal(await worktreeExists(join(repository, 'conflict.txt')), false)
    assert.equal(await worktreeExists(join(repository, 'independent.txt')), false)

    const auditNamesAfterParallel = (await readdir(auditDirectory))
      .filter((entry) => entry.endsWith('.json') && !auditBefore.has(entry))
    assert.equal(auditNamesAfterParallel.length, 3)
    auditNames = auditNamesAfterParallel
    const activeAudits = await waitForTurnAudits(auditDirectory, auditNames)
    assert.equal(activeAudits.every((audit) => audit.nonProtocolLines.length === 0), true)
    assert.equal(activeAudits.every((audit) => audit.stderrTail.every((line) => !line.includes(credential))), true)
  } finally {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
    if (auditNames.length > 0) {
      const audits = await waitForAuditExit(auditDirectory, auditNames)
      assert.equal(audits.every((audit) => audit.nonProtocolLines.length === 0), true)
      assert.equal(audits.every((audit) => audit.childExitCode === 0 && audit.childSignal === null), true)
      await waitForProcessesToExit(audits.flatMap((audit) => [audit.probePid, audit.childPid]).filter(Boolean))
      assert.equal(audits.some((audit) => audit.stderrTail.some((line) => line.includes(credential))), false)
    }
    if (successIntegrationPath !== undefined) assert.equal(await worktreeExists(successIntegrationPath), false)
    if (conflictIntegrationPath !== undefined) assert.equal(await worktreeExists(conflictIntegrationPath), true)
    for (const path of workerPaths) assert.equal(await worktreeExists(path), true)
    const stderr = Buffer.concat(stderrChunks).toString('utf8')
    assert.equal(stderr.includes(credential), false)
    const ownedPaths = [...workerPaths, successIntegrationPath, conflictIntegrationPath].filter((path) => typeof path === 'string')
    for (const path of ownedPaths) await rm(path, { recursive: true, force: true }).catch(() => {})
    await git(repository, ['worktree', 'prune']).catch(() => {})
    await rm(auditDirectory, { recursive: true, force: true })
    await rm(repository, { recursive: true, force: true })
  }
})

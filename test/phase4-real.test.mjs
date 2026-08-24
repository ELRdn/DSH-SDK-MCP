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
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase4-real-repo-'))
  await writeFile(join(root, 'README.md'), '# Phase 4 real worktree smoke\n', 'utf8')
  await git(root, ['init', '--initial-branch=main'])
  await git(root, ['config', 'user.email', 'phase4-real@example.invalid'])
  await git(root, ['config', 'user.name', 'Phase 4 Real Smoke'])
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

async function waitForTurnAudits(directory, expectedNames, timeoutMs = 180_000) {
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
  throw new Error('Timed out waiting for completed real DSH turn audits')
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
  throw new Error('Timed out waiting for real DSH child runtimes to exit')
}

async function waitForProcessesToExit(pids, timeoutMs = 30_000) {
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
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250))
  }
  assert.deepEqual(pids.filter(alive), [])
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

test('opt-in real OpenCode Go Phase 4 worktree smoke', {
  skip: process.env.DSH_MCP_PHASE4_REAL_SMOKE !== '1',
}, async () => {
  const credential = await loadOpenCodeGoCredential()
  const repository = await createRepository()
  const auditDirectory = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase4-real-audits-'))
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
  const client = new Client({ name: 'dsh-sdk-mcp-phase4-real-test', version: '0.4.0' })
  let createdWorktrees = []
  let auditNames = []
  let cleanWorktreePath

  try {
    await client.connect(transport)
    const listed = await client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ['dsh_continue', 'dsh_delegate', 'dsh_health', 'dsh_integrate', 'dsh_parallel', 'dsh_parallel_worktree', 'dsh_status', 'dsh_worktree_review'],
    )

    let health = await client.callTool({ name: 'dsh_health', arguments: {} })
    if (health.structuredContent?.providerReady !== true && health.structuredContent?.error?.code === 'RUN_TIMEOUT') {
      health = await client.callTool({ name: 'dsh_health', arguments: {} })
    }
    assert.equal(health.isError, undefined)
    assert.equal(health.structuredContent.ok, true)
    assert.equal(health.structuredContent.runtimeReady, true)
    assert.equal(health.structuredContent.providerReady, true)
    assert.equal(JSON.stringify(health).includes(credential), false)

    const auditBefore = new Set((await readdir(auditDirectory)).filter((entry) => entry.endsWith('.json')))
    const expectedFiles = ['worker-a.txt', 'worker-b.txt', 'worker-c.txt']
    const parallel = await client.callTool({
      name: 'dsh_parallel_worktree',
      arguments: {
        repo: repository,
        tasks: [
          { name: 'real-worker-a', task: taskFor(expectedFiles[0], 'PHASE4_REAL_WORKER_A') },
          { name: 'real-worker-b', task: taskFor(expectedFiles[1], 'PHASE4_REAL_WORKER_B') },
          { name: 'real-worker-c', task: taskFor(expectedFiles[2], 'PHASE4_REAL_WORKER_C') },
        ],
      },
    })
    assert.equal(parallel.isError, undefined)
    assert.equal(parallel.structuredContent.ok, true)
    assert.equal(parallel.structuredContent.results.length, 3)
    assert.deepEqual(parallel.structuredContent.results.map((worker) => worker.index), [0, 1, 2])
    assert.equal(new Set(parallel.structuredContent.results.map((worker) => worker.worktreePath)).size, 3)
    assert.equal(new Set(parallel.structuredContent.results.map((worker) => worker.baseCommit)).size, 1)
    assert.equal(parallel.structuredContent.results.every((worker) => worker.ok && worker.finalResponse.trim().length > 0), true)
    assert.equal(JSON.stringify(parallel).includes(credential), false)
    createdWorktrees = parallel.structuredContent.results.map((worker) => worker.worktreePath)

    for (let index = 0; index < expectedFiles.length; index += 1) {
      const worker = parallel.structuredContent.results[index]
      assert.match(worker.changedFiles.join('\n'), new RegExp(`${expectedFiles[index].replace('.', '\\.')}$`))
      assert.equal((await readFile(join(worker.worktreePath, expectedFiles[index]), 'utf8')).trim(), `PHASE4_REAL_WORKER_${String.fromCharCode(65 + index)}`)
      for (let otherIndex = 0; otherIndex < expectedFiles.length; otherIndex += 1) {
        if (otherIndex === index) continue
        assert.equal(await worktreeExists(join(parallel.structuredContent.results[otherIndex].worktreePath, expectedFiles[index])), false)
      }
    }
    assert.deepEqual(await git(repository, ['status', '--porcelain']), '')
    for (const file of expectedFiles) assert.equal(await worktreeExists(join(repository, file)), false)

    const auditNamesAfterParallel = (await readdir(auditDirectory))
      .filter((entry) => entry.endsWith('.json') && !auditBefore.has(entry))
    assert.equal(auditNamesAfterParallel.length, 3)
    auditNames = auditNamesAfterParallel
    const activeAudits = await waitForTurnAudits(auditDirectory, auditNames)
    assert.equal(activeAudits.every((audit) => audit.nonProtocolLines.length === 0), true)
    const intervals = activeAudits.flatMap((audit) => audit.turnIntervals)
    assert.ok(intervals.length >= 3)
    assert.ok(Math.max(...intervals.map((interval) => interval.startAt)) < Math.min(...intervals.map((interval) => interval.endAt)))

    const continued = await client.callTool({
      name: 'dsh_continue',
      arguments: {
        sessionId: parallel.structuredContent.results[0].sessionId,
        task: taskFor('continued.txt', 'PHASE4_REAL_CONTINUED'),
      },
    })
    assert.equal(continued.isError, undefined)
    assert.equal(continued.structuredContent.ok, true)
    assert.equal(continued.structuredContent.sessionId, parallel.structuredContent.results[0].sessionId)
    assert.equal((await readFile(join(parallel.structuredContent.results[0].worktreePath, 'continued.txt'), 'utf8')).trim(), 'PHASE4_REAL_CONTINUED')
    assert.equal(JSON.stringify(continued).includes(credential), false)

    const auditBeforeClean = new Set((await readdir(auditDirectory)).filter((entry) => entry.endsWith('.json')))
    const clean = await client.callTool({
      name: 'dsh_parallel_worktree',
      arguments: {
        repo: repository,
        tasks: [{ name: 'real-clean-worker', task: 'Inspect the repository and reply with exactly PHASE4_REAL_CLEAN_WORKER. Do not create or modify files.' }],
      },
    })
    assert.equal(clean.isError, undefined)
    assert.equal(clean.structuredContent.ok, true)
    assert.equal(clean.structuredContent.results.length, 1)
    assert.deepEqual(clean.structuredContent.results[0].changedFiles, [])
    cleanWorktreePath = clean.structuredContent.results[0].worktreePath
    createdWorktrees.push(cleanWorktreePath)
    assert.equal(JSON.stringify(clean).includes(credential), false)
    const cleanAuditNames = (await readdir(auditDirectory)).filter((entry) => entry.endsWith('.json') && !auditBeforeClean.has(entry))
    assert.equal(cleanAuditNames.length, 1)
    auditNames.push(cleanAuditNames[0])
    const allActiveAudits = await waitForTurnAudits(auditDirectory, auditNames)
    assert.equal(allActiveAudits.every((audit) => audit.nonProtocolLines.length === 0), true)
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
    if (cleanWorktreePath !== undefined) assert.equal(await worktreeExists(cleanWorktreePath), false)
    for (const path of createdWorktrees) {
      if (path !== cleanWorktreePath) assert.equal(await worktreeExists(path), true)
    }
    const stderr = Buffer.concat(stderrChunks).toString('utf8')
    assert.equal(stderr.includes(credential), false)
    for (const path of createdWorktrees) await rm(path, { recursive: true, force: true }).catch(() => {})
    await git(repository, ['worktree', 'prune']).catch(() => {})
    await rm(auditDirectory, { recursive: true, force: true })
    await rm(repository, { recursive: true, force: true })
  }
})

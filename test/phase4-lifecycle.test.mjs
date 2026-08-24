import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test } from 'node:test'

const execFile = promisify(execFileCallback)
const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const serverEntry = join(projectRoot, 'dist', 'index.js')
const fakeRuntime = join(here, 'fake-runtime.mjs')

function phase4Environment(overrides = {}) {
  const mode = overrides.DSH_PHASE4_FAKE_MODE ?? 'phase4-write-slow'
  return {
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, mode]),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DEEPSEEK_API_KEY: 'sk-phase4-lifecycle-secret',
    ...overrides,
  }
}

async function connectClient(overrides = {}) {
  const environment = phase4Environment(overrides)
  delete environment.DSH_PHASE4_FAKE_MODE
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectRoot,
    env: environment,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'dsh-sdk-mcp-phase4-lifecycle-test', version: '0.4.0' })
  await client.connect(transport)
  return { client, transport }
}

async function closeClient(client, transport) {
  await client.close().catch(() => {})
  await transport.close().catch(() => {})
}

async function git(cwd, args) {
  const result = await execFile('git', args, { cwd, windowsHide: true })
  return result.stdout.trim()
}

async function createRepository() {
  const repository = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase4-lifecycle-repo-'))
  await git(repository, ['init', '--initial-branch=main'])
  await git(repository, ['config', 'user.email', 'phase4@example.invalid'])
  await git(repository, ['config', 'user.name', 'Phase 4 Test'])
  await git(repository, ['commit', '--allow-empty', '-m', 'base'])
  return repository
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 40))
  }
  throw new Error('Timed out waiting for Phase 4 lifecycle state')
}

async function cleanupCreatedWorktree(repository, result) {
  if (!result?.worktreePath || !(await exists(result.worktreePath))) return
  for (const file of result.changedFiles ?? []) {
    await rm(join(result.worktreePath, file), { force: true }).catch(() => {})
  }
  await git(repository, ['worktree', 'remove', result.worktreePath]).catch(async () => {
    await git(repository, ['worktree', 'remove', '--force', result.worktreePath]).catch(() => {})
  })
  if (result.branch) await git(repository, ['branch', '-D', '--', result.branch]).catch(() => {})
}

test('worktree sessions continue in the same worktree and expose coarse status', async () => {
  const repository = await createRepository()
  const { client, transport } = await connectClient()
  let result
  try {
    const first = await client.callTool({
      name: 'dsh_parallel_worktree',
      arguments: {
        repo: repository,
        tasks: [{ task: 'WRITE_FILE=continuation.txt:first' }],
      },
    })
    result = first.structuredContent.results[0]
    assert.equal(result.ok, true)
    assert.equal(result.cleanupState, 'active')
    assert.equal((await readFile(join(result.worktreePath, 'continuation.txt'), 'utf8')), 'first')
    const status = await client.callTool({
      name: 'dsh_status',
      arguments: { sessionId: result.sessionId },
    })
    assert.equal(status.structuredContent.status, 'idle')
    assert.equal(status.structuredContent.cwd, result.worktreePath)
    const continued = await client.callTool({
      name: 'dsh_continue',
      arguments: { sessionId: result.sessionId, task: 'WRITE_FILE=continuation.txt:second' },
    })
    assert.equal(continued.structuredContent.ok, true, JSON.stringify(continued))
    assert.equal(continued.structuredContent.sessionId, result.sessionId)
    assert.equal((await readFile(join(result.worktreePath, 'continuation.txt'), 'utf8')), 'second')
  } finally {
    await closeClient(client, transport)
    await cleanupCreatedWorktree(repository, result)
    await rm(repository, { recursive: true, force: true })
  }
})

test('clean idle worktrees are removed after runtime TTL', async () => {
  const repository = await createRepository()
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_IDLE_TTL_MS: '120',
  })
  let result
  try {
    const response = await client.callTool({
      name: 'dsh_parallel_worktree',
      arguments: { repo: repository, tasks: [{ task: 'do not write files' }] },
    })
    result = response.structuredContent.results[0]
    assert.equal(result.ok, true)
    await waitFor(async () => !(await exists(result.worktreePath)))
    assert.doesNotMatch(await git(repository, ['worktree', 'list', '--porcelain']), new RegExp(result.worktreeId))
  } finally {
    await closeClient(client, transport)
    await cleanupCreatedWorktree(repository, result)
    await rm(repository, { recursive: true, force: true })
  }
})

test('dirty idle worktrees survive runtime TTL and remain inspectable', async () => {
  const repository = await createRepository()
  const { client, transport } = await connectClient({
    DSH_MCP_RUNTIME_IDLE_TTL_MS: '120',
  })
  let result
  try {
    const response = await client.callTool({
      name: 'dsh_parallel_worktree',
      arguments: { repo: repository, tasks: [{ task: 'WRITE_FILE=dirty.txt:keep-me' }] },
    })
    result = response.structuredContent.results[0]
    await waitFor(async () => (await exists(result.worktreePath)) && (await git(result.worktreePath, ['status', '--porcelain'])).length > 0)
    const status = await client.callTool({
      name: 'dsh_status',
      arguments: { sessionId: result.sessionId },
    })
    assert.equal(status.structuredContent.status, 'expired')
    assert.equal(await exists(join(result.worktreePath, 'dirty.txt')), true)
    assert.match(await git(repository, ['worktree', 'list', '--porcelain']), new RegExp(result.worktreeId))
  } finally {
    await closeClient(client, transport)
    await cleanupCreatedWorktree(repository, result)
    await rm(repository, { recursive: true, force: true })
  }
})

test('invalid baseRef is structured and does not create a worktree', async () => {
  const repository = await createRepository()
  const { client, transport } = await connectClient()
  try {
    const response = await client.callTool({
      name: 'dsh_parallel_worktree',
      arguments: { repo: repository, baseRef: '--bad-ref', tasks: [{ task: 'do not write files' }] },
    })
    assert.equal(response.isError, true)
    assert.equal(response.structuredContent.error.code, 'INVALID_BASE_REF')
    assert.equal((await git(repository, ['worktree', 'list', '--porcelain'])).includes('dsh-wt-'), false)
  } finally {
    await closeClient(client, transport)
    await rm(repository, { recursive: true, force: true })
  }
})

test('shutdown does not remove a user-owned worktree', async () => {
  const repository = await createRepository()
  const externalRoot = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase4-user-worktree-'))
  const externalWorktree = join(externalRoot, 'user-owned')
  await git(repository, ['worktree', 'add', '-b', 'user-owned-phase4', externalWorktree, 'HEAD'])
  const { client, transport } = await connectClient()
  try {
    await closeClient(client, transport)
    assert.equal(await exists(externalWorktree), true)
    assert.match(await git(repository, ['worktree', 'list', '--porcelain']), /user-owned-phase4/)
  } finally {
    await git(repository, ['worktree', 'remove', externalWorktree]).catch(() => {})
    await git(repository, ['branch', '-D', '--', 'user-owned-phase4']).catch(() => {})
    await rm(externalRoot, { recursive: true, force: true })
    await rm(repository, { recursive: true, force: true })
  }
})

test('worktree batch preserves partial structured failure without canceling siblings', async () => {
  const repository = await createRepository()
  const { client, transport } = await connectClient({
    DSH_PHASE4_FAKE_MODE: 'parallel-mixed',
  })
  try {
    const response = await client.callTool({
      name: 'dsh_parallel_worktree',
      arguments: {
        repo: repository,
        tasks: [{ task: 'FAIL_WORKER' }, { task: 'normal sibling' }],
      },
    })
    assert.equal(response.structuredContent.ok, true)
    assert.equal(response.structuredContent.results[0].ok, false)
    assert.equal(response.structuredContent.results[0].error.code, 'QUOTA')
    assert.equal(response.structuredContent.results[1].ok, true)
    assert.notEqual(response.structuredContent.results[0].worktreeId, response.structuredContent.results[1].worktreeId)
  } finally {
    await closeClient(client, transport)
    await rm(repository, { recursive: true, force: true })
  }
})

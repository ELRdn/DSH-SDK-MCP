import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test } from 'node:test'

const execFile = promisify(execFileCallback)
const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const serverEntry = join(projectRoot, 'dist', 'index.js')
const fakeRuntime = join(here, 'fake-runtime.mjs')

function environment(overrides = {}) {
  return {
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'phase4-write']),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DEEPSEEK_API_KEY: 'sk-phase5-test-secret',
    ...overrides,
  }
}

async function git(cwd, args) {
  const result = await execFile('git', args, { cwd, windowsHide: true, maxBuffer: 120_000 })
  return result.stdout.trim()
}

async function createRepository({ ignoredSecrets = false } = {}) {
  const repository = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase5-repo-'))
  await writeFile(join(repository, 'README.md'), '# phase5 base\n', 'utf8')
  if (ignoredSecrets) await writeFile(join(repository, '.gitignore'), '.env*\n', 'utf8')
  await git(repository, ['init', '--initial-branch=main'])
  await git(repository, ['config', 'user.email', 'phase5@example.invalid'])
  await git(repository, ['config', 'user.name', 'Phase 5 Test'])
  await git(repository, ['add', '.'])
  await git(repository, ['commit', '-m', 'base'])
  return { repository, head: await git(repository, ['rev-parse', 'HEAD']) }
}

async function connectClient(overrides = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectRoot,
    env: environment(overrides),
    stderr: 'pipe',
  })
  const stderrChunks = []
  transport.stderr?.on('data', (chunk) => stderrChunks.push(chunk))
  const client = new Client({ name: 'dsh-sdk-mcp-phase5-test', version: '0.5.0' })
  await client.connect(transport)
  return { client, transport, stderrChunks }
}

async function closeClient(client, transport) {
  await client.close().catch(() => {})
  await transport.close().catch(() => {})
}

async function disposePaths(repository, paths) {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true }).catch(() => {})))
  await git(repository, ['worktree', 'prune']).catch(() => {})
  await rm(repository, { recursive: true, force: true })
}

async function createWorkers(client, repository, tasks) {
  const result = await client.callTool({
    name: 'dsh_parallel_worktree',
    arguments: { repo: repository, tasks },
  })
  assert.equal(result.isError, undefined, JSON.stringify(result))
  assert.equal(result.structuredContent.ok, true, JSON.stringify(result))
  return result.structuredContent.results
}

test('Phase 5 tools/list exposes exactly the two integration tools in addition to Phase 4', async () => {
  const { client, transport } = await connectClient()
  try {
    const listed = await client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ['dsh_continue', 'dsh_delegate', 'dsh_health', 'dsh_integrate', 'dsh_parallel', 'dsh_parallel_worktree', 'dsh_status', 'dsh_worktree_review'],
    )
  } finally {
    await closeClient(client, transport)
  }
})

test('dsh_worktree_review derives metadata from Git rather than worker narration', async () => {
  const { repository } = await createRepository()
  const { client, transport } = await connectClient()
  let paths = []
  try {
    const [worker] = await createWorkers(client, repository, [{ task: 'WRITE_FILE=README.md:actual-content', name: 'narrated-name' }])
    paths = [worker.worktreePath]
    const review = await client.callTool({
      name: 'dsh_worktree_review',
      arguments: { sessionId: worker.sessionId },
    })
    assert.equal(review.isError, undefined, JSON.stringify(review))
    assert.equal(review.structuredContent.ok, true)
    assert.equal(review.structuredContent.worktreeId, worker.worktreeId)
    assert.equal(review.structuredContent.sessionId, worker.sessionId)
    assert.equal(review.structuredContent.worktreePath, worker.worktreePath)
    assert.equal(review.structuredContent.changedFiles.includes('README.md'), true)
    assert.equal(review.structuredContent.untrackedCount, 0)
    assert.equal(review.structuredContent.stagedCount, 0)
    assert.equal(review.structuredContent.unstagedCount, 1)
    assert.equal(review.structuredContent.additions, 1)
    assert.equal(review.structuredContent.deletions, 1)
    assert.equal(review.structuredContent.gitStatusSummary.includes('README.md'), true)
  } finally {
    await closeClient(client, transport)
    await disposePaths(repository, paths)
  }
})

test('dsh_integrate applies dirty worker snapshots in deterministic input order and protects the original tree', async () => {
  const { repository, head } = await createRepository()
  const { client, transport } = await connectClient()
  let paths = []
  let integrationPath = ''
  try {
    const workers = await createWorkers(client, repository, [
      { task: 'WRITE_FILE=feature-a.txt:alpha', name: 'worker-a' },
      { task: 'WRITE_FILE=feature-b.txt:bravo', name: 'worker-b' },
    ])
    paths = workers.map((worker) => worker.worktreePath)
    const integrated = await client.callTool({
      name: 'dsh_integrate',
      arguments: { repo: repository, workers: [{ sessionId: workers[0].sessionId }, { sessionId: workers[1].sessionId }] },
    })
    assert.equal(integrated.isError, undefined, JSON.stringify(integrated))
    assert.equal(integrated.structuredContent.ok, true, JSON.stringify(integrated))
    assert.equal(integrated.structuredContent.status, 'applied')
    assert.deepEqual(integrated.structuredContent.appliedWorkers.map((worker) => worker.sessionId), workers.map((worker) => worker.sessionId))
    assert.equal(integrated.structuredContent.snapshotMetadata.length, 2)
    assert.equal(integrated.structuredContent.changedFiles.includes('feature-a.txt'), true)
    assert.equal(integrated.structuredContent.changedFiles.includes('feature-b.txt'), true)
    assert.equal(integrated.structuredContent.clean, true)
    assert.equal(await readFile(join(integrated.structuredContent.integrationWorktreePath, 'feature-a.txt'), 'utf8'), 'alpha')
    assert.equal(await readFile(join(integrated.structuredContent.integrationWorktreePath, 'feature-b.txt'), 'utf8'), 'bravo')
    assert.equal(await git(repository, ['rev-parse', 'HEAD']), head)
    assert.equal(await git(repository, ['status', '--porcelain']), '')
    assert.equal(await readFile(join(workers[0].worktreePath, 'feature-a.txt'), 'utf8'), 'alpha')
    assert.equal(await readFile(join(workers[1].worktreePath, 'feature-b.txt'), 'utf8'), 'bravo')
    assert.equal(await access(workers[0].worktreePath).then(() => true), true)
    assert.equal(await access(workers[1].worktreePath).then(() => true), true)
    integrationPath = integrated.structuredContent.integrationWorktreePath
    paths.push(integrationPath)
  } finally {
    await closeClient(client, transport)
    if (integrationPath) assert.equal(await access(integrationPath).then(() => true).catch(() => false), false)
    assert.equal(await access(paths[0]).then(() => true).catch(() => false), true)
    assert.equal(await access(paths[1]).then(() => true).catch(() => false), true)
    await disposePaths(repository, paths)
  }
})

test('dsh_integrate returns structured conflict metadata without automatic resolution', async () => {
  const { repository, head } = await createRepository()
  const { client, transport } = await connectClient()
  let paths = []
  let integrationPath = ''
  try {
    const workers = await createWorkers(client, repository, [
      { task: 'WRITE_FILE=conflict.txt:from-a', name: 'worker-a' },
      { task: 'WRITE_FILE=conflict.txt:from-c', name: 'worker-c' },
      { task: 'WRITE_FILE=pending.txt:from-pending', name: 'worker-pending' },
    ])
    paths = workers.map((worker) => worker.worktreePath)
    const integrated = await client.callTool({
      name: 'dsh_integrate',
      arguments: { repo: repository, workers: [{ sessionId: workers[0].sessionId }, { sessionId: workers[1].sessionId }, { sessionId: workers[2].sessionId }] },
    })
    assert.equal(integrated.isError, true)
    assert.equal(integrated.structuredContent.ok, false)
    assert.equal(integrated.structuredContent.status, 'conflict')
    assert.equal(integrated.structuredContent.error.code, 'INTEGRATION_CONFLICT')
    assert.equal(integrated.structuredContent.conflictingWorker.sessionId, workers[1].sessionId)
    assert.equal(integrated.structuredContent.conflictingFiles.includes('conflict.txt'), true)
    assert.deepEqual(integrated.structuredContent.appliedWorkers.map((worker) => worker.sessionId), [workers[0].sessionId])
    assert.deepEqual(integrated.structuredContent.pendingWorkers.map((worker) => worker.sessionId), [workers[1].sessionId, workers[2].sessionId])
    assert.deepEqual(integrated.structuredContent.pendingWorkers.map((worker) => worker.status), ['conflict', 'pending'])
    assert.equal(integrated.structuredContent.integrationWorktreeDirty, true)
    assert.ok(integrated.structuredContent.conflictMarkers.length > 0)
    assert.equal(await git(repository, ['rev-parse', 'HEAD']), head)
    assert.equal(await git(repository, ['status', '--porcelain']), '')
    integrationPath = integrated.structuredContent.integrationWorktreePath
    paths.push(integrationPath)
  } finally {
    await closeClient(client, transport)
    if (integrationPath) assert.equal(await access(integrationPath).then(() => true).catch(() => false), true)
    await disposePaths(repository, paths)
  }
})

test('dsh_integrate excludes ignored secret files while preserving intended untracked changes', async () => {
  const { repository } = await createRepository({ ignoredSecrets: true })
  const secret = 'phase5-ignore-secret-value'
  const { client, transport, stderrChunks } = await connectClient()
  let paths = []
  try {
    const [worker] = await createWorkers(client, repository, [{ task: 'WRITE_FILE=intended.txt:keep-me', name: 'sk-phase5-test-secret' }])
    paths = [worker.worktreePath]
    await writeFile(join(worker.worktreePath, '.env.secret'), secret, 'utf8')
    const integrated = await client.callTool({
      name: 'dsh_integrate',
      arguments: { repo: repository, workers: [{ sessionId: worker.sessionId }] },
    })
    assert.equal(integrated.structuredContent.ok, true, JSON.stringify(integrated))
    assert.equal(await readFile(join(integrated.structuredContent.integrationWorktreePath, 'intended.txt'), 'utf8'), 'keep-me')
    assert.equal(await access(join(integrated.structuredContent.integrationWorktreePath, '.env.secret')).then(() => true).catch(() => false), false)
    assert.equal(JSON.stringify(integrated).includes(secret), false)
    assert.equal(Buffer.concat(stderrChunks).toString('utf8').includes(secret), false)
    paths.push(integrated.structuredContent.integrationWorktreePath)
  } finally {
    await closeClient(client, transport)
    await disposePaths(repository, paths)
  }
})

test('review and integrate reject stale worker ids and cross-repository workers safely', async () => {
  const first = await createRepository()
  const second = await createRepository()
  const { client, transport } = await connectClient()
  let paths = []
  try {
    const [firstWorker] = await createWorkers(client, first.repository, [{ task: 'WRITE_FILE=first.txt:one' }])
    const [secondWorker] = await createWorkers(client, second.repository, [{ task: 'WRITE_FILE=second.txt:two' }])
    paths = [firstWorker.worktreePath, secondWorker.worktreePath]
    const stale = await client.callTool({ name: 'dsh_worktree_review', arguments: { sessionId: 'missing-session' } })
    assert.equal(stale.isError, true)
    assert.equal(stale.structuredContent.error.code, 'WORKER_NOT_FOUND')
    const mixed = await client.callTool({
      name: 'dsh_integrate',
      arguments: { repo: first.repository, workers: [{ sessionId: firstWorker.sessionId }, { sessionId: secondWorker.sessionId }] },
    })
    assert.equal(mixed.isError, true)
    assert.equal(mixed.structuredContent.error.code, 'WORKER_REPOSITORY_MISMATCH')
  } finally {
    await closeClient(client, transport)
    await disposePaths(first.repository, [paths[0]].filter(Boolean))
    await disposePaths(second.repository, [paths[1]].filter(Boolean))
  }
})

test('review and integration diff metadata stay bounded', async () => {
  const { repository } = await createRepository()
  const { client, transport } = await connectClient()
  let paths = []
  try {
    const large = 'x'.repeat(120_000)
    const [worker] = await createWorkers(client, repository, [{ task: `WRITE_FILE=large.txt:${large}` }])
    paths = [worker.worktreePath]
    const review = await client.callTool({ name: 'dsh_worktree_review', arguments: { worktreeId: worker.worktreeId } })
    assert.equal(review.structuredContent.ok, true)
    assert.equal(review.structuredContent.diffSummary.length <= 50_000, true)
    const integrated = await client.callTool({ name: 'dsh_integrate', arguments: { repo: repository, workers: [{ sessionId: worker.sessionId }] } })
    assert.equal(JSON.stringify(integrated).length <= 300_000, true)
    assert.equal(integrated.structuredContent.responseTruncated, false)
    assert.ok(integrated.structuredContent.responseLength > 0)
    assert.equal(integrated.structuredContent.diffSummary.length <= 50_000, true)
    paths.push(integrated.structuredContent.integrationWorktreePath)
  } finally {
    await closeClient(client, transport)
    await disposePaths(repository, paths)
  }
})

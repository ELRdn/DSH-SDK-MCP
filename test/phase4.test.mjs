import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test } from 'node:test'

const execFile = promisify(execFileCallback)
const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const serverEntry = join(projectRoot, 'dist', 'index.js')

function phase4Environment(overrides = {}) {
  return {
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([join(here, 'fake-runtime.mjs'), 'phase4-write-slow']),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DEEPSEEK_API_KEY: 'sk-phase4-test-secret',
    ...overrides,
  }
}

async function connectClient(overrides = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectRoot,
    env: phase4Environment(overrides),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'dsh-sdk-mcp-phase4-test', version: '0.4.0' })
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
  const repository = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase4-repo-'))
  await git(repository, ['init', '--initial-branch=main'])
  await git(repository, ['config', 'user.email', 'phase4@example.invalid'])
  await git(repository, ['config', 'user.name', 'Phase 4 Test'])
  await git(repository, ['commit', '--allow-empty', '-m', 'base'])
  const baseCommit = await git(repository, ['rev-parse', 'HEAD'])
  return { repository, baseCommit }
}

test('tools/list exposes the Phase 4 worktree workflow as one additional public tool', async () => {
  const { client, transport } = await connectClient()
  try {
    const listed = await client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ['dsh_continue', 'dsh_delegate', 'dsh_health', 'dsh_parallel', 'dsh_parallel_worktree', 'dsh_status'],
    )
  } finally {
    await closeClient(client, transport)
  }
})

test('dsh_parallel_worktree rejects a non-absolute repository before Git operations', async () => {
  const { client, transport } = await connectClient()
  try {
    const result = await client.callTool({
      name: 'dsh_parallel_worktree',
      arguments: {
        repo: 'relative/repository',
        tasks: [{ task: 'WRITE_FILE=worker.txt:content' }],
      },
    })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error.code, 'INVALID_REPOSITORY')
  } finally {
    await closeClient(client, transport)
  }
})

test('dsh_parallel_worktree creates distinct worktrees from one base commit and preserves isolated changes', async () => {
  const { repository, baseCommit } = await createRepository()
  const { client, transport } = await connectClient()
  try {
    const result = await client.callTool({
      name: 'dsh_parallel_worktree',
      arguments: {
        repo: repository,
        tasks: [
          { name: 'worker-a', task: 'WRITE_FILE=worker-a.txt:alpha' },
          { name: 'worker-b', task: 'WRITE_FILE=worker-b.txt:bravo' },
        ],
      },
    })
    assert.equal(result.structuredContent.ok, true, JSON.stringify(result))
    assert.equal(result.structuredContent.results.length, 2)
    const [workerA, workerB] = result.structuredContent.results
    assert.notEqual(workerA.worktreePath, workerB.worktreePath)
    assert.equal(isAbsolute(workerA.worktreePath), true)
    assert.equal(isAbsolute(workerB.worktreePath), true)
    assert.equal(workerA.baseCommit, baseCommit)
    assert.equal(workerB.baseCommit, baseCommit)
    assert.equal(workerA.changedFiles.includes('worker-a.txt'), true)
    assert.equal(workerB.changedFiles.includes('worker-b.txt'), true)
    assert.equal(workerA.changedFiles.includes('worker-b.txt'), false)
    assert.equal(workerB.changedFiles.includes('worker-a.txt'), false)
    assert.equal(await git(repository, ['status', '--porcelain']), '')
  } finally {
    await closeClient(client, transport)
    await rm(repository, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const serverEntry = join(projectRoot, 'dist', 'index.js')
const fakeRuntime = join(here, 'fake-runtime.mjs')
const execFile = promisify(execFileCallback)

function environment(overrides = {}) {
  const mode = overrides.DSH_PHASE4_FAKE_MODE ?? 'parallel-slow'
  return {
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, mode]),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DEEPSEEK_API_KEY: 'sk-phase4-cap-secret',
    ...overrides,
  }
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
  transport.stderr?.on('data', (chunk) => stderrChunks.push(chunk.toString('utf8')))
  const client = new Client({ name: 'dsh-sdk-mcp-phase4-cap-test', version: '0.4.0' })
  await client.connect(transport)
  return { client, transport, stderrChunks }
}

async function closeClient(client, transport) {
  await client.close().catch(() => {})
  await transport.close().catch(() => {})
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase4-cap-repo-'))
  // The repository only needs a valid HEAD; the phase4 lifecycle tests cover detailed Git setup.
  await execFile('git', ['init', '--initial-branch=main'], { cwd: root, windowsHide: true })
  await execFile('git', ['config', 'user.email', 'phase4@example.invalid'], { cwd: root, windowsHide: true })
  await execFile('git', ['config', 'user.name', 'Phase 4 Test'], { cwd: root, windowsHide: true })
  await execFile('git', ['commit', '--allow-empty', '-m', 'base'], { cwd: root, windowsHide: true })
  return root
}

async function waitForAudits(directory, count, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.json'))
    if (entries.length >= count) return entries
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 40))
  }
  throw new Error('Timed out waiting for Phase 4 audit files')
}

async function waitForAuditsComplete(directory, count, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.json'))
    if (entries.length >= count) {
      const audits = await Promise.all(entries.slice(0, count).map(async (name) => (
        JSON.parse(await readFile(join(directory, name), 'utf8'))
      )))
      if (audits.every((audit) => Number.isFinite(audit.startAt) && Number.isFinite(audit.endAt))) return audits
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 40))
  }
  throw new Error('Timed out waiting for completed Phase 4 audit files')
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

test('worktree aggregate responses are bounded with truncation metadata', async () => {
  const repository = await createRepository()
  const { client, transport } = await connectClient({ DSH_PHASE4_FAKE_MODE: 'parallel-huge' })
  try {
    const response = await client.callTool({
      name: 'dsh_parallel_worktree',
      arguments: {
        repo: repository,
        tasks: [{ task: 'one' }, { task: 'two' }, { task: 'three' }],
      },
    })
    assert.equal(response.structuredContent.aggregateResponseTruncated, true)
    assert.equal(JSON.stringify(response.structuredContent).length <= 300_000, true)
    assert.equal(response.structuredContent.results.every((worker) => worker.finalResponseLength >= 120_000 && worker.finalResponseTruncated), true)
  } finally {
    await closeClient(client, transport)
    await rm(repository, { recursive: true, force: true })
  }
})

test('worktree workers overlap while respecting the existing global cap', async () => {
  const repository = await createRepository()
  const auditDirectory = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase4-cap-audit-'))
  const { client, transport } = await connectClient({
    DSH_MCP_MAX_PARALLEL: '2',
    DSH_PHASE3_FAKE_AUDIT_DIR: auditDirectory,
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ DSH_PHASE3_FAKE_AUDIT_DIR: auditDirectory }),
  })
  try {
    const response = await client.callTool({
      name: 'dsh_parallel_worktree',
      arguments: {
        repo: repository,
        tasks: [{ task: 'one' }, { task: 'two' }, { task: 'three' }],
      },
    })
    assert.equal(response.structuredContent.results.every((worker) => worker.ok), true)
    const audits = await waitForAuditsComplete(auditDirectory, 3)
    const intervals = audits.filter((audit) => audit.startAt && audit.endAt).map((audit) => audit)
    assert.equal(maximumOverlap(intervals) <= 2, true)
    assert.equal(maximumOverlap(intervals) >= 2, true)
  } finally {
    await closeClient(client, transport)
    await rm(auditDirectory, { recursive: true, force: true })
    await rm(repository, { recursive: true, force: true })
  }
})

test('worktree results and stderr-derived diagnostics redact secrets', async () => {
  const repository = await createRepository()
  const secret = 'phase4-redaction-secret-value'
  const { client, transport, stderrChunks } = await connectClient({
    DSH_PHASE4_FAKE_MODE: 'secret-tool-fields',
    DSH_PHASE0_FAKE_SECRET: secret,
    DSH_MCP_RUNTIME_ENV_JSON: JSON.stringify({ WORKTREE_SECRET: secret }),
  })
  try {
    const response = await client.callTool({
      name: 'dsh_parallel_worktree',
      arguments: { repo: repository, tasks: [{ name: secret, task: 'safe task' }] },
    })
    assert.equal(JSON.stringify(response).includes(secret), false)
    assert.equal(stderrChunks.join('').includes(secret), false)
  } finally {
    await closeClient(client, transport)
    await rm(repository, { recursive: true, force: true })
  }
})

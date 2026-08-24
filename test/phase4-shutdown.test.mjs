import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const execFile = promisify(execFileCallback)
const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const serverEntry = join(projectRoot, 'dist', 'index.js')
const fakeRuntime = join(here, 'fake-runtime.mjs')

async function git(cwd, args) {
  const result = await execFile('git', args, { cwd, windowsHide: true })
  return result.stdout.trim()
}

async function createRepository() {
  const repository = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase4-shutdown-repo-'))
  await git(repository, ['init', '--initial-branch=main'])
  await git(repository, ['config', 'user.email', 'phase4@example.invalid'])
  await git(repository, ['config', 'user.name', 'Phase 4 Test'])
  await git(repository, ['commit', '--allow-empty', '-m', 'base'])
  return repository
}

async function waitForPid(directory, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.pid'))
    if (entries.length > 0) return
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 40))
  }
  throw new Error('Timed out waiting for a Phase 4 DSH runtime')
}

async function waitForEmpty(directory, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.pid'))
    if (entries.length === 0) return
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 40))
  }
  throw new Error('Timed out waiting for Phase 4 runtime cleanup')
}

function environment(pidDirectory) {
  return {
    ...process.env,
    DSH_MCP_RUNTIME_COMMAND: process.execPath,
    DSH_MCP_RUNTIME_ARGS: JSON.stringify([fakeRuntime, 'phase4-write-slow']),
    DSH_MCP_PROFILE: 'deepseek-official',
    DSH_MCP_PROVIDER: 'deepseek-official',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DEEPSEEK_API_KEY: 'sk-phase4-shutdown-secret',
    DSH_PHASE3_FAKE_PID_DIR: pidDirectory,
    DSH_PHASE3_FAKE_DELAY_MS: '5000',
  }
}

test('stdin EOF during an active worktree worker leaves zero runtime orphans and no created worktree', async () => {
  const repository = await createRepository()
  const pidDirectory = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase4-shutdown-pids-'))
  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: environment(pidDirectory),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'phase4-shutdown', version: '0.4.0' } } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_parallel_worktree', arguments: { repo: repository, tasks: [{ task: 'slow task' }] } } })}\n`)
    await waitForPid(pidDirectory)
    child.stdin.end()
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit)
      child.once('exit', (code) => resolveExit(code))
    })
    assert.equal(exitCode, 0, stdout)
    await waitForEmpty(pidDirectory)
    assert.equal((await git(repository, ['worktree', 'list', '--porcelain'])).includes('dsh-wt-'), false)
  } finally {
    child.kill()
    await rm(pidDirectory, { recursive: true, force: true })
    await rm(repository, { recursive: true, force: true })
  }
})

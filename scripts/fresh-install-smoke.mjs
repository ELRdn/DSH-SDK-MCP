#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = 'dsh-sdk-mcp'
const expectedTools = [
  'dsh_continue',
  'dsh_delegate',
  'dsh_health',
  'dsh_integrate',
  'dsh_parallel',
  'dsh_parallel_worktree',
  'dsh_status',
  'dsh_worktree_review',
]
const npmCommand = process.platform === 'win32' ? 'cmd.exe' : 'npm'

function npmArgs(args) {
  if (process.platform !== 'win32') return args
  const commandLine = ['npm', ...args.map((value) => (
    value === 'pack' || value === 'install' || value === 'init' || value.startsWith('-') || !value.includes(' ')
      ? value
      : '"' + value.replaceAll('"', '""') + '"'
  ))].join(' ')
  return ['/d', '/s', '/c', commandLine]
}

function secretValues(environment) {
  const values = Object.entries(environment)
    .filter(([key, value]) => typeof value === 'string'
      && value.length > 0
      && /(key|token|secret|password|authorization)/i.test(key))
    .map(([, value]) => value)
  const rawOverrides = environment.DSH_MCP_RUNTIME_ENV_JSON
  if (rawOverrides !== undefined) {
    try {
      const parsed = JSON.parse(rawOverrides)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const value of Object.values(parsed)) {
          if (typeof value === 'string' && value.length > 0) values.push(value)
        }
      }
    } catch {}
  }
  return [...new Set(values)]
}

function safeEnvironment(source) {
  const environment = { ...source }
  for (const key of Object.keys(environment)) {
    if (/^DSH_MCP_/i.test(key)
      || /^(DEEPSEEK_API_KEY|OPENCODE(?:_GO)?_API_KEY)$/i.test(key)
      || /(TOKEN|SECRET|PASSWORD|AUTHORIZATION)/i.test(key)) {
      delete environment[key]
    }
  }
  return environment
}

function assertNoSecrets(value, values, label) {
  for (const secret of values) {
    if (secret.length > 0 && value.includes(secret)) {
      throw new Error(label + ' contained a configured secret')
    }
  }
}

async function runNpm(args, options) {
  return execFile(npmCommand, npmArgs(args), options)
}

function runProcess(command, args, options = {}) {
  const { timeoutMs = 120_000, shell = false } = options
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill()
      rejectResult(new Error(String(command) + ' timed out'))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectResult(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolveResult({ child, code, signal, stdout, stderr })
    })
  })
}

function parsePackReport(stdout) {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('npm pack did not return a JSON report')
  const parsed = JSON.parse(stdout.slice(start, end + 1))
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('unexpected npm pack report')
  return parsed[0]
}

async function packInto(directory, environment) {
  const pack = await runNpm(
    ['pack', '--json', '--ignore-scripts'],
    { cwd: projectRoot, env: environment, windowsHide: true, maxBuffer: 2_000_000, timeout: 120_000 },
  )
  const filename = parsePackReport(pack.stdout).filename
  const source = join(projectRoot, filename)
  const target = join(directory, filename)
  await copyFile(source, target)
  await rm(source, { force: true })
  return target
}

function makeReader(stream) {
  let buffer = ''
  let ended = false
  const queue = []
  const waiters = []
  const invalidLines = []
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line.trim() === '') continue
      try {
        const message = JSON.parse(line)
        const waiter = waiters.shift()
        if (waiter) waiter(message)
        else queue.push(message)
      } catch {
        invalidLines.push(line)
      }
    }
  })
  stream.on('end', () => {
    ended = true
    while (waiters.length > 0) waiters.shift()(undefined)
  })
  return {
    invalidLines,
    next(timeoutMs = 30_000) {
      if (queue.length > 0) return Promise.resolve(queue.shift())
      if (ended) return Promise.reject(new Error('MCP stdout closed'))
      return new Promise((resolveNext, rejectNext) => {
        const timer = setTimeout(() => rejectNext(new Error('MCP response timeout')), timeoutMs)
        waiters.push((message) => {
          clearTimeout(timer)
          if (message === undefined) rejectNext(new Error('MCP stdout closed'))
          else resolveNext(message)
        })
      })
    },
  }
}

function startServer(cli, environment, cwd) {
  const child = spawn(process.execPath, [cli], {
    cwd,
    env: environment,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = makeReader(child.stdout)
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return { child, reader, stderr: () => stderr }
}

async function waitForClose(child, timeoutMs = 30_000) {
  if (child.exitCode !== null) return child.exitCode
  return new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => rejectClose(new Error('MCP server EOF shutdown timeout')), timeoutMs)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolveClose(code)
    })
  })
}

async function request(server, id, method, params) {
  server.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  const response = await server.reader.next()
  assert.equal(response?.id, id, 'MCP response id mismatch')
  assert.equal(response?.error, undefined, method + ' returned a JSON-RPC error')
  return response.result
}

function startMcp(cli, environment, cwd) {
  const child = spawn(process.execPath, [cli], {
    cwd,
    env: environment,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = makeReader(child.stdout)
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return { child, reader, stderr: () => stderr }
}

async function keylessSmoke(installRoot, installedRoot, environment, secrets) {
  const cli = join(installedRoot, 'dist', 'cli.js')
  const doctor = await runProcess(process.execPath, [cli, 'doctor', '--json'], {
    cwd: installRoot,
    env: environment,
    timeoutMs: 30_000,
  })
  assert.equal(doctor.code, 0)
  assertNoSecrets(doctor.stdout + doctor.stderr, secrets, 'doctor')
  const report = JSON.parse(doctor.stdout)
  assert.equal(report.packageVersion, '0.6.0-rc.1')
  assert.equal(report.status, 'needs-configuration')
  assert.equal(report.dsh.externalRuntimeRequired, true)
  assert.equal(report.sandbox, 'inconclusive')

  const bin = join(installRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh-sdk-mcp.cmd' : 'dsh-sdk-mcp')
  const version = await runProcess(bin, ['--version'], {
    cwd: installRoot,
    env: environment,
    shell: process.platform === 'win32',
    timeoutMs: 30_000,
  })
  assert.equal(version.code, 0)
  assert.equal(version.stdout.trim(), '0.6.0-rc.1')
  assertNoSecrets(version.stdout + version.stderr, secrets, 'version')

  const server = startMcp(cli, environment, installRoot)
  try {
    const initialize = await request(server, 1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'dsh-sdk-mcp-fresh-install-smoke', version: '0.6.0-rc.1' },
    })
    assert.equal(initialize.protocolVersion, '2025-11-25')
    server.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const listed = await request(server, 2, 'tools/list', {})
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), expectedTools)
    const health = await request(server, 3, 'tools/call', { name: 'dsh_health', arguments: {} })
    assert.equal(typeof health.structuredContent?.runtimeConfigured, 'boolean')
    assertNoSecrets(JSON.stringify(health), secrets, 'health')
    server.child.stdin.end()
    const exitCode = await waitForClose(server.child)
    assert.equal(exitCode, 0)
    assert.equal(server.reader.invalidLines.length, 0)
    assertNoSecrets(server.stderr(), secrets, 'MCP stderr')
    return { toolCount: listed.tools.length, stdoutPurity: true, exitCode }
  } catch (error) {
    server.child.kill()
    await waitForClose(server.child).catch(() => undefined)
    throw error
  }
}

async function optionalRealSmoke(installRoot, installedRoot, environment, secrets) {
  const runtimeCommand = environment.DSH_MCP_RUNTIME_COMMAND?.trim()
  const runtimeArgs = environment.DSH_MCP_RUNTIME_ARGS?.trim()
  if (!runtimeCommand || !runtimeArgs) {
    throw new Error('DSH_MCP_FRESH_REAL_SMOKE=1 requires runtime command and args')
  }
  const projectKey = projectRoot.toLowerCase().replaceAll('\\', '/')
  const cordis = environment.DSH_MCP_CORDIS_CONFIG?.trim()
    || join(installedRoot, 'runtime', 'phase0.opencode-go.cordis.yml')
  if (runtimeCommand.toLowerCase().includes(projectKey)
    || runtimeArgs.toLowerCase().includes(projectKey)
    || cordis.toLowerCase().includes(projectKey)) {
    throw new Error('fresh real smoke must not use the source checkout')
  }
  const realEnv = {
    ...environment,
    DSH_MCP_PROFILE: 'opencode-go',
    DSH_MCP_PROVIDER: 'opencode-go',
    DSH_MCP_MODEL: 'deepseek-v4-flash',
    DSH_MCP_CORDIS_CONFIG: cordis,
    DSH_MCP_RUNTIME_CWD: installRoot,
  }
  const server = startMcp(join(installedRoot, 'dist', 'cli.js'), realEnv, installRoot)
  try {
    await request(server, 1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'dsh-sdk-mcp-fresh-real-smoke', version: '0.6.0-rc.1' },
    })
    server.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const listed = await request(server, 2, 'tools/list', {})
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), expectedTools)
    const health = await request(server, 3, 'tools/call', { name: 'dsh_health', arguments: {} })
    assert.equal(health.structuredContent?.providerReady, true)
    const delegate = await request(server, 4, 'tools/call', {
      name: 'dsh_delegate',
      arguments: { task: 'Reply with one short non-empty sentence proving the fresh package path.', cwd: installRoot },
    })
    assert.equal(delegate.structuredContent?.ok, true)
    assert.ok(String(delegate.structuredContent?.finalResponse ?? '').length > 0)
    assertNoSecrets(JSON.stringify({ health, delegate }), secrets, 'fresh real MCP')
    server.child.stdin.end()
    const exitCode = await waitForClose(server.child, 90_000)
    assert.equal(exitCode, 0)
    assert.equal(server.reader.invalidLines.length, 0)
    assertNoSecrets(server.stderr(), secrets, 'fresh real stderr')
    return { toolCount: listed.tools.length, nonEmptyResponse: true, stdoutPurity: true, exitCode }
  } catch (error) {
    server.child.kill()
    await waitForClose(server.child, 90_000).catch(() => undefined)
    throw error
  }
}

async function main() {
  const secrets = secretValues(process.env)
  const safeEnv = safeEnvironment(process.env)
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-release-'))
  const packDir = join(root, 'pack')
  const installDir = join(root, 'install')
  await mkdir(packDir)
  await mkdir(installDir)
  try {
    const packed = await packInto(packDir, safeEnv)
    const filename = basename(packed)
    const localTarball = join(installDir, filename)
    await copyFile(packed, localTarball)
    await rm(packed, { force: true })
    await runNpm(['init', '--yes'], {
      cwd: installDir,
      env: safeEnv,
      windowsHide: true,
      maxBuffer: 1_000_000,
      timeout: 60_000,
    })
    await runNpm(
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', './' + filename],
      { cwd: installDir, env: safeEnv, windowsHide: true, maxBuffer: 4_000_000, timeout: 180_000 },
    )
    const installedRoot = join(installDir, 'node_modules', packageName)
    const installedPackage = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
    assert.equal(installedPackage.version, '0.6.0-rc.1')
    const keyless = await keylessSmoke(installDir, installedRoot, safeEnv, secrets)
    const result = {
      ok: true,
      package: packageName,
      version: installedPackage.version,
      freshInstall: true,
      runtimePolicy: 'external-runtime-required',
      keyless,
      real: process.env.DSH_MCP_FRESH_REAL_SMOKE === '1' ? 'running' : { status: 'opt-in-skipped' },
    }
    if (process.env.DSH_MCP_FRESH_REAL_SMOKE === '1') {
      result.real = await optionalRealSmoke(installDir, installedRoot, process.env, secrets)
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write('[fresh-install-smoke] ' + (error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
})

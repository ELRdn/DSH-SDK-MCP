import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectRoot, 'dist', 'cli.js')

function keylessEnvironment() {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (/^DSH_MCP_/i.test(key)
      || /^(DEEPSEEK_API_KEY|OPENCODE(?:_GO)?_API_KEY)$/i.test(key)
      || /(TOKEN|SECRET|PASSWORD|AUTHORIZATION)/i.test(key)) {
      delete environment[key]
    }
  }
  return environment
}

function runNode(args) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: keylessEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectResult)
    child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }))
  })
}

test('release CLI reports the pinned version and non-secret doctor state', async () => {
  const version = await runNode([cli, '--version'])
  assert.equal(version.code, 0)
  assert.equal(version.stdout.trim(), '0.6.0-rc.2')
  assert.equal(version.stderr, '')

  const doctor = await runNode([cli, 'doctor', '--json'])
  assert.equal(doctor.code, 0)
  const report = JSON.parse(doctor.stdout)
  assert.equal(report.packageVersion, '0.6.0-rc.2')
  assert.equal(report.mcp.sdkVersion, '1.30.0')
  assert.equal(report.mcp.protocolRevision, '2025-11-25')
  assert.equal(report.dsh.externalRuntimeRequired, false)
  assert.equal(report.dsh.runtimeMode, 'bundled-sdk')
  assert.equal(report.dsh.bundledRuntimeAvailable, true)
  assert.equal(report.sandbox, 'inconclusive')
  assert.equal(report.status, 'needs-configuration')
  assert.equal(JSON.stringify(report).includes('sk-'), false)
  assert.equal(doctor.stderr.includes('sk-'), false)
})

test('release package metadata has one executable and the explicit publish allowlist', async () => {
  const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  assert.equal(packageJson.private, undefined)
  assert.deepEqual(packageJson.bin, { 'dsh-sdk-mcp': './dist/cli.js' })
  assert.deepEqual(packageJson.files, [
    'dist',
    'runtime',
    'README.md',
    'COMPATIBILITY.md',
    'SECURITY.md',
    'LICENSE',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
  ])
  assert.equal(packageJson.dependencies['@deepseek-ai/dsh-sdk-jsonrpc-demo'], undefined)
  assert.equal(packageJson.dependencies['@deepseek-ai/dsh'], '0.1.2-rc.1')
})

test('package audit remains keyless and passes', {
  skip: process.env.DSH_MCP_RELEASE_TESTS !== '1',
}, async () => {
  const audit = await runNode([join(projectRoot, 'scripts', 'package-audit.mjs')])
  assert.equal(audit.code, 0, audit.stderr)
  const report = JSON.parse(audit.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.version, '0.6.0-rc.2')
  assert.equal(report.runtimePolicy, 'bundled-sdk-profile')
  assert.ok(report.fileCount > 0)
})

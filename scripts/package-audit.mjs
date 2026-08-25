#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requiredFiles = [
  'package.json',
  'README.md',
  'COMPATIBILITY.md',
  'SECURITY.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'dist/cli.js',
  'dist/index.js',
  'runtime/phase0.cordis.yml',
  'runtime/phase0.opencode-go.cordis.yml',
]

const forbiddenPathPatterns = [
  /(^|\/)\.env(?:$|\.)/i,
  /(^|\/)(?:credentials?|secrets?|tokens?)(?:\/|$)/i,
  /(^|\/)(?:node_modules|\.pnpm|test|tests|\.github|coverage|artifacts?)(?:\/|$)/i,
  /(^|\/)(?:tmp|temp|worktrees?|sessions?|logs?)(?:\/|$)/i,
  /(?:^|\/)(?:\.bak|\.orig|\.rej)$/i,
  /(?:^|\/)(?:patch-probe|package\.phase6|package-phase6)/i,
  /(?:^|[^d])\.(?:ts|tsx)$/i,
  /^(?:[A-Za-z]:[\\/]|\/)/,
]

function npmInvocation(args) {
  if (process.platform !== 'win32') return { command: 'npm', args }
  const commandLine = ['npm', ...args.map((value) => (
    value === 'pack' || value.startsWith('-')
      ? value
      : '"' + value.replaceAll('"', '""') + '"'
  ))].join(' ')
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', commandLine] }
}

function parsePackReport(stdout) {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('npm pack did not return a JSON report')
  const parsed = JSON.parse(stdout.slice(start, end + 1))
  if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0]?.files)) {
    throw new Error('npm pack returned an unexpected report shape')
  }
  return parsed[0]
}

function filePath(entry) {
  if (typeof entry === 'string') return entry.replaceAll('\\', '/')
  if (entry !== null && typeof entry === 'object') {
    const value = entry.path ?? entry.filename
    if (typeof value === 'string') return value.replaceAll('\\', '/')
  }
  return ''
}

async function main() {
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'))
  const npm = npmInvocation(['pack', '--dry-run', '--json', '--ignore-scripts'])
  const { stdout } = await execFile(
    npm.command,
    npm.args,
    { cwd: projectRoot, windowsHide: true, maxBuffer: 2_000_000, timeout: 60_000 },
  )
  const report = parsePackReport(stdout)
  const files = report.files.map(filePath).filter(Boolean).sort()
  const fileSet = new Set(files)
  const missing = requiredFiles.filter((file) => !fileSet.has(file))
  const forbidden = files.filter((file) => forbiddenPathPatterns.some((pattern) => pattern.test(file)))
  const violations = []
  if (packageJson.private === true) violations.push('package.json must not be private')
  if (packageJson.bin?.['dsh-sdk-mcp'] !== './dist/cli.js') {
    violations.push('the dsh-sdk-mcp bin must target dist/cli.js')
  }
  if (packageJson.dependencies?.['@deepseek-ai/dsh-sdk-jsonrpc-demo'] !== undefined) {
    violations.push('the external DSH runtime must not be a production dependency')
  }
  if (missing.length > 0) violations.push('missing required files: ' + missing.join(', '))
  if (forbidden.length > 0) violations.push('forbidden package paths: ' + forbidden.join(', '))
  if (violations.length > 0) throw new Error(violations.join('; '))

  process.stdout.write(JSON.stringify({
    ok: true,
    package: report.name,
    version: report.version,
    fileCount: files.length,
    unpackedSize: report.unpackedSize,
    packageSize: report.size,
    files,
    runtimePolicy: 'external-runtime-required',
  }) + '\n')
}

main().catch((error) => {
  process.stderr.write('[package-audit] ' + (error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
})

#!/usr/bin/env node

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadPhase0Options, secretValuesFromEnvironment } from './config.js'
import { collectDoctor, formatDoctorReport } from './doctor.js'
import { runMcpServer } from './mcp-server.js'
import { packageVersionFromRoot, safeError } from './report.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function packageVersion(): Promise<string> {
  try {
    return packageVersionFromRoot(projectRoot)
  } catch {
    return 'unknown'
  }
}

function usage(): string {
  return [
    'Usage:',
    '  dsh-sdk-mcp                 Start the MCP stdio server',
    '  dsh-sdk-mcp --version       Print the package version',
    '  dsh-sdk-mcp doctor [--json] Run configuration diagnostics without probing the provider',
  ].join('\n') + '\n'
}

const [command, ...arguments_] = process.argv.slice(2)

try {
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${await packageVersion()}\n`)
  } else if (command === '--help' || command === '-h') {
    process.stdout.write(usage())
  } else if (command === 'doctor') {
    const report = await collectDoctor(process.env, projectRoot)
    if (arguments_.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else process.stdout.write(formatDoctorReport(report))
  } else if (command !== undefined) {
    process.stderr.write(`Unknown command: ${command}\n${usage()}`)
    process.exitCode = 1
  } else {
    await runMcpServer()
  }
} catch (error) {
  process.stderr.write(
    `[dsh-sdk-mcp] ${safeError(error, secretValuesFromEnvironment(process.env)).message}\n`,
  )
  process.exitCode = 1
}

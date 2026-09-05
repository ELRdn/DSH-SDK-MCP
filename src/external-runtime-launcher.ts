#!/usr/bin/env node

import { spawn } from 'node:child_process'

const command = process.env.DSH_MCP_EXTERNAL_RUNTIME_COMMAND
const rawArgs = process.env.DSH_MCP_EXTERNAL_RUNTIME_ARGS_JSON
const cwd = process.env.DSH_MCP_EXTERNAL_RUNTIME_CWD

if (command === undefined || command.trim() === '') {
  process.stderr.write('[dsh-sdk-mcp runtime launcher] external runtime command is missing\n')
  process.exit(1)
}

let args: string[]
try {
  const parsed = JSON.parse(rawArgs ?? '[]') as unknown
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error('arguments are not a string array')
  }
  args = parsed
} catch {
  process.stderr.write('[dsh-sdk-mcp runtime launcher] external runtime arguments are invalid\n')
  process.exit(1)
}

const environment = { ...process.env }
delete environment.DSH_MCP_EXTERNAL_RUNTIME_COMMAND
delete environment.DSH_MCP_EXTERNAL_RUNTIME_ARGS_JSON
delete environment.DSH_MCP_EXTERNAL_RUNTIME_CWD

const child = spawn(command, args, {
  cwd: cwd === undefined || cwd === '' ? undefined : cwd,
  env: environment,
  shell: false,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
})

process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)

let startupFailed = false
child.once('error', (error) => {
  startupFailed = true
  process.stderr.write(`[dsh-sdk-mcp runtime launcher] external runtime failed to start: ${error.message}\n`)
  process.stdin.unpipe(child.stdin)
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}

child.once('close', (code, signal) => {
  if (startupFailed) process.exitCode = 1
  else if (code !== null) process.exitCode = code
  else process.exitCode = signal === null ? 1 : 128
})

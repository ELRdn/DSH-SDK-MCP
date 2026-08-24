import { spawn } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [command, rawArgs, auditDirectory, childCwd] = process.argv.slice(2)

if (!command || rawArgs === undefined || !auditDirectory || !childCwd) {
  process.stderr.write('parallel-runtime-probe requires command, JSON args, audit directory, and child cwd\n')
  process.exit(64)
}

let args
try {
  args = JSON.parse(rawArgs)
} catch (error) {
  process.stderr.write(`parallel-runtime-probe args are not valid JSON: ${error.message}\n`)
  process.exit(64)
}

if (!Array.isArray(args) || !args.every((value) => typeof value === 'string')) {
  process.stderr.write('parallel-runtime-probe args must be a JSON array of strings\n')
  process.exit(64)
}

mkdirSync(auditDirectory, { recursive: true })
const auditPath = join(auditDirectory, `${process.pid}.json`)
const state = {
  probePid: process.pid,
  childPid: null,
  childExitCode: null,
  childSignal: null,
  stdoutBytes: 0,
  protocolLines: 0,
  nonProtocolLines: [],
  stderrBytes: 0,
  stderrTail: [],
  turnIntervals: [],
}

let stdoutRemainder = ''
let currentTurnStart = null

function writeAudit() {
  const tempAuditPath = `${auditPath}.tmp-${process.pid}`
  writeFileSync(tempAuditPath, `${JSON.stringify(state)}\n`, 'utf8')
  renameSync(tempAuditPath, auditPath)
}

function observeProtocol(message) {
  if (message?.method === 'session.event') {
    const type = message.params?.event?.type
    if (type === 'agent/inbox/spliced' && currentTurnStart === null) {
      currentTurnStart = Date.now()
    }
  }
  if (message?.method === 'session.status' && message.params?.status === 'idle' && currentTurnStart !== null) {
    state.turnIntervals.push({ startAt: currentTurnStart, endAt: Date.now() })
    currentTurnStart = null
  }
  writeAudit()
}

function recordStdout(chunk) {
  const text = chunk.toString('utf8')
  state.stdoutBytes += Buffer.byteLength(text)
  stdoutRemainder += text
  let newlineIndex = stdoutRemainder.indexOf('\n')
  while (newlineIndex >= 0) {
    const line = stdoutRemainder.slice(0, newlineIndex).replace(/\r$/, '')
    stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1)
    if (line.trim() === '') {
      state.nonProtocolLines.push('')
    } else {
      try {
        const message = JSON.parse(line)
        state.protocolLines += 1
        observeProtocol(message)
      } catch {
        state.nonProtocolLines.push(line.slice(0, 400))
      }
    }
    newlineIndex = stdoutRemainder.indexOf('\n')
  }
  writeAudit()
  process.stdout.write(chunk)
}

function recordStderr(chunk) {
  const text = chunk.toString('utf8')
  state.stderrBytes += Buffer.byteLength(text)
  state.stderrTail.push(...text.split(/\r?\n/).filter(Boolean))
  if (state.stderrTail.length > 64) state.stderrTail = state.stderrTail.slice(-64)
  writeAudit()
  process.stderr.write(chunk)
}

function finishAudit() {
  if (stdoutRemainder.length > 0) {
    try {
      JSON.parse(stdoutRemainder)
      state.protocolLines += 1
    } catch {
      state.nonProtocolLines.push(stdoutRemainder.slice(0, 400))
    }
  }
  writeAudit()
}

let child
try {
  child = spawn(command, args, {
    cwd: childCwd,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  state.childPid = child.pid ?? null
  writeAudit()
} catch (error) {
  state.error = error.message
  finishAudit()
  process.exit(1)
}

process.stdin.pipe(child.stdin)
child.stdin.on('error', () => {})
child.stdout.on('data', recordStdout)
child.stderr.on('data', recordStderr)
child.on('error', (error) => {
  state.error = error.message
  writeAudit()
})
child.on('close', (code, signal) => {
  state.childExitCode = code
  state.childSignal = signal
  finishAudit()
  process.exitCode = code ?? 1
})

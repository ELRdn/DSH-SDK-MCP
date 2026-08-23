import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'normal'
const pidFile = process.env.DSH_PHASE0_FAKE_PID_FILE

if (pidFile) writeFileSync(pidFile, `${process.pid}\n`, 'utf8')

function cleanup() {
  if (pidFile && existsSync(pidFile)) unlinkSync(pidFile)
}

process.on('exit', cleanup)

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function response(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function event(sessionId, payload) {
  send({
    jsonrpc: '2.0',
    method: 'session.event',
    params: { sessionId, event: payload },
  })
}

if (mode === 'crash-before-init') {
  process.stderr.write('fake runtime crashed before initialize\n')
  process.exit(17)
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let malformedSent = false

input.on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    process.stderr.write('fake runtime received malformed input\n')
    return
  }

  if (mode === 'malformed-json' && !malformedSent) {
    malformedSent = true
    process.stdout.write('this is not JSON-RPC\n')
    setTimeout(() => process.exit(19), 10).unref()
    return
  }

  if (mode === 'timeout') return

  if (request.method === 'initialize') {
    if (mode === 'provider-mismatch') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32001, message: 'provider/model route unavailable' },
      })
      return
    }
    response(request.id, { serverInfo: { name: 'fake-runtime', version: '0.0.0-test' } })
    return
  }

  if (request.method === 'session/prompt') {
    const sessionId = request.params.sessionId
    if (mode === 'missing-credential') {
      const messageId = `fake-message-${Date.now()}`
      response(request.id, { messageId })
      event(sessionId, { type: 'agent/inbox/spliced', data: { inserted: [{ id: messageId }] } })
      event(sessionId, { type: 'turn/start', data: { turn: 0 } })
      event(sessionId, { type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: {} } })
      event(sessionId, { type: 'turn/end', data: { turn: 0, reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'credential unavailable for provider route' } } } })
      send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'running' } })
      send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } })
      return
    }
    const content = request.params.contentBlocks?.[0]?.text ?? ''
    const messageId = `fake-message-${Date.now()}-${Math.random()}`
    response(request.id, { messageId })
    event(sessionId, {
      type: 'agent/inbox/spliced',
      data: { inserted: [{ id: messageId }] },
    })
    event(sessionId, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: content }] } },
    })
    event(sessionId, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: `FAKE_RESPONSE:${content}` }] } },
    })
    send({
      jsonrpc: '2.0',
      method: 'session.status',
      params: { sessionId, status: 'idle' },
    })
    return
  }

  if (request.method === 'shutdown') {
    response(request.id, {})
    setTimeout(() => input.close(), 10).unref()
  }
})

input.on('close', () => {
  setTimeout(() => process.exit(0), 10).unref()
})

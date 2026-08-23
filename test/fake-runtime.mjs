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

if (
  mode === 'crash-before-init'
  || mode === 'crash-quota'
  || mode === 'crash-secret'
  || mode === 'crash-huge-stderr'
) {
  process.stderr.write(mode === 'crash-quota'
    ? 'runtime transport closed after quota diagnostic\n'
    : mode === 'crash-secret'
      ? `fake runtime failed with ${process.env.DSH_PHASE0_FAKE_SECRET ?? 'unknown-secret'}\n`
      : mode === 'crash-huge-stderr'
        ? `${'x'.repeat(10_000)}\n`
      : 'fake runtime crashed before initialize\n')
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
    response(request.id, {
      serverInfo: {
        name: mode === 'huge-server-info' ? 'n'.repeat(10_000) : 'fake-runtime',
        version: mode === 'huge-server-info' ? 'v'.repeat(10_000) : '0.0.0-test',
      },
    })
    return
  }

  if (request.method === 'session/prompt') {
    const sessionId = request.params.sessionId
    if (mode === 'crash-mid-run') {
      process.stderr.write('fake runtime crashed after initialize during prompt\n')
      process.exit(23)
    }
    if (mode === 'accept-hang') {
      const messageId = `fake-message-${Date.now()}`
      response(request.id, { messageId })
      event(sessionId, { type: 'agent/inbox/spliced', data: { inserted: [{ id: messageId }] } })
      return
    }
    if (mode === 'prompt-rpc-error') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32042, message: 'provider request rejected by the runtime' },
      })
      return
    }
    if (mode === 'secret-diagnostic') {
      const messageId = `fake-message-${Date.now()}`
      const secret = process.env.DSH_PHASE0_FAKE_SECRET ?? 'unknown-secret'
      response(request.id, { messageId })
      event(sessionId, { type: 'agent/inbox/spliced', data: { inserted: [{ id: messageId }] } })
      event(sessionId, {
        type: 'turn/end',
        data: { turn: 0, reason: { kind: 'error', error: { code: secret, message: secret } } },
      })
      send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } })
      return
    }
    if (mode === 'missing-credential' || mode === 'quota' || mode === 'rate-limit') {
      const failureCode = mode === 'quota'
        ? 'QUOTA'
        : mode === 'rate-limit'
          ? 'RATE_LIMIT'
          : 'MISSING_CREDENTIAL'
      const failureMessage = mode === 'quota'
        ? 'provider quota exhausted for configured route'
        : mode === 'rate-limit'
          ? 'provider rate limit reached for configured route'
          : 'credential unavailable for provider route'
      const messageId = `fake-message-${Date.now()}`
      response(request.id, { messageId })
      event(sessionId, { type: 'agent/inbox/spliced', data: { inserted: [{ id: messageId }] } })
      event(sessionId, { type: 'turn/start', data: { turn: 0 } })
      event(sessionId, { type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: {} } })
      event(sessionId, { type: 'turn/end', data: { turn: 0, reason: { kind: 'error', error: { code: failureCode, message: failureMessage } } } })
      send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'running' } })
      send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } })
      return
    }
    const content = mode === 'health-no-marker'
      ? 'provider refused the health probe'
      : mode === 'health-superstring'
        ? 'DSH_MCP_HEALTH_OKAY'
      : request.params.contentBlocks?.[0]?.text ?? ''
    const messageId = `fake-message-${Date.now()}-${Math.random()}`
    response(request.id, { messageId })
    const emitResponse = () => {
      event(sessionId, {
        type: 'agent/inbox/spliced',
        data: { inserted: [{ id: messageId }] },
      })
      if (mode === 'secret-tool-fields') {
        const secret = process.env.DSH_PHASE0_FAKE_SECRET ?? 'unknown-secret'
        event(sessionId, {
          type: 'tool/call',
          data: { callId: secret, name: secret },
        })
        event(sessionId, {
          type: 'tool/result',
          data: { message: { source: { callId: secret } } },
        })
        event(sessionId, {
          type: 'tool/call',
          data: { callId: 'safe-call', name: 'read' },
        })
        event(sessionId, {
          type: 'tool/result',
          data: { message: { source: { callId: 'safe-call' } } },
        })
      }
      event(sessionId, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: content }] } },
      })
      event(sessionId, {
        type: 'assistant/message',
        data: {
          message: {
            content: [{
              type: 'text',
              text: content.includes('DSH_MCP_HEALTH_OK') && mode !== 'health-superstring'
                ? 'DSH_MCP_HEALTH_OK'
                : `FAKE_RESPONSE:${content}`,
            }],
          },
        },
      })
      send({
        jsonrpc: '2.0',
        method: 'session.status',
        params: { sessionId, status: 'idle' },
      })
    }
    if (mode === 'slow') setTimeout(emitResponse, 300).unref()
    else emitResponse()
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

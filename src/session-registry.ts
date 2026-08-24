export const SESSION_STATES = ['running', 'idle', 'expired'] as const
export type SessionState = typeof SESSION_STATES[number]
export type SessionStatus = SessionState | 'missing'

export interface SessionRecord {
  readonly sessionId: string
  readonly runtimeKey: string
  readonly cwd: string
  readonly createdAt: number
  state: SessionState
  lastActivityAt: number
  completedTurns: number
}

export interface SessionStatusSnapshot {
  sessionId: string
  status: SessionStatus
  cwd?: string
  runtimeKey?: string
}

/**
 * Owns logical delegated sessions independently from the SDK runtime object.
 * It deliberately exposes only coarse lifecycle state; prompt-level progress
 * is not a stable contract of this MCP bridge.
 */
export class SessionRegistry {
  private readonly records = new Map<string, SessionRecord>()

  create(sessionId: string, runtimeKey: string, cwd: string, now = Date.now()): SessionRecord {
    if (this.records.has(sessionId)) {
      throw new Error('SESSION_ID_COLLISION')
    }
    const record: SessionRecord = {
      sessionId,
      runtimeKey,
      cwd,
      createdAt: now,
      state: 'running',
      lastActivityAt: now,
      completedTurns: 0,
    }
    this.records.set(sessionId, record)
    return record
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId)
  }

  markRunning(sessionId: string, now = Date.now()): boolean {
    const record = this.records.get(sessionId)
    if (record === undefined || record.state === 'expired') return false
    record.state = 'running'
    record.lastActivityAt = now
    return true
  }

  markIdle(sessionId: string, now = Date.now()): boolean {
    const record = this.records.get(sessionId)
    if (record === undefined || record.state === 'expired') return false
    record.state = 'idle'
    record.lastActivityAt = now
    record.completedTurns += 1
    return true
  }

  markExpired(sessionId: string, now = Date.now()): boolean {
    const record = this.records.get(sessionId)
    if (record === undefined) return false
    record.state = 'expired'
    record.lastActivityAt = now
    return true
  }

  expireRuntime(runtimeKey: string, now = Date.now()): string[] {
    const expired: string[] = []
    for (const record of this.records.values()) {
      if (record.runtimeKey !== runtimeKey || record.state === 'expired') continue
      record.state = 'expired'
      record.lastActivityAt = now
      expired.push(record.sessionId)
    }
    return expired
  }

  status(sessionId: string): SessionStatusSnapshot {
    const record = this.records.get(sessionId)
    if (record === undefined) return { sessionId, status: 'missing' }
    return {
      sessionId: record.sessionId,
      status: record.state,
      cwd: record.cwd,
      runtimeKey: record.runtimeKey,
    }
  }
}

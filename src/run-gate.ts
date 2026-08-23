export class RuntimeBusyError extends Error {
  readonly code = 'RUNTIME_BUSY'

  constructor() {
    super('The runtime already has an active root run')
    this.name = 'RuntimeBusyError'
  }
}

/** One active root run per runtime; never queues a second run. */
export class RuntimeRunGate {
  private active = false
  private readonly idleWaiters = new Set<() => void>()

  get isActive(): boolean {
    return this.active
  }

  waitForIdle(): Promise<void> {
    if (!this.active) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.active) throw new RuntimeBusyError()
    this.active = true
    try {
      return await task()
    } finally {
      this.active = false
      for (const resolve of this.idleWaiters) resolve()
      this.idleWaiters.clear()
    }
  }
}

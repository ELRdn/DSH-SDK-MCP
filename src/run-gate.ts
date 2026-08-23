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

  get isActive(): boolean {
    return this.active
  }

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.active) throw new RuntimeBusyError()
    this.active = true
    try {
      return await task()
    } finally {
      this.active = false
    }
  }
}

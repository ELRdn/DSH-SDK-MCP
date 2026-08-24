export class ParallelSemaphoreClosedError extends Error {
  readonly code = 'BRIDGE_CLOSED'

  constructor() {
    super('The parallel worker semaphore is closed')
    this.name = 'ParallelSemaphoreClosedError'
  }
}

type Waiter = {
  resolve: () => void
  reject: (error: unknown) => void
}

/** Bounded, FIFO permits for one dsh_parallel call and bridge shutdown. */
export class ParallelSemaphore {
  private readonly capacity: number
  private available: number
  private readonly waiters: Waiter[] = []
  private closed = false

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error('PARALLEL_CAPACITY_INVALID')
    }
    this.capacity = capacity
    this.available = capacity
  }

  get active(): number {
    return this.capacity - this.available
  }

  async acquire(): Promise<void> {
    if (this.closed) throw new ParallelSemaphoreClosedError()
    if (this.available > 0) {
      this.available -= 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  release(): void {
    if (this.available >= this.capacity) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve()
      return
    }
    this.available += 1
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const error = new ParallelSemaphoreClosedError()
    while (this.waiters.length > 0) this.waiters.shift()?.reject(error)
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }
}

import type { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

import type { InitializeDiagnostic } from './diagnostics.js'
import { RuntimeBusyError, RuntimeRunGate } from './run-gate.js'

export class RuntimePoolClosedError extends Error {
  readonly code = 'BRIDGE_CLOSED'

  constructor() {
    super('The DSH runtime pool is closed')
    this.name = 'RuntimePoolClosedError'
  }
}

export interface RuntimeResource {
  harness: DeepSeekHarness
  initialize: { current: () => InitializeDiagnostic }
  dispose: () => Promise<void>
}

export interface RuntimeHandle {
  readonly key: string
  readonly cwd: string
  readonly harness: DeepSeekHarness
  readonly initialize: { current: () => InitializeDiagnostic }
  readonly gate: RuntimeRunGate
  readonly sessionIds: Set<string>
  claimed: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  closeTask?: Promise<void>
}

export interface RuntimeLease {
  readonly runtime: RuntimeHandle
  readonly owner: boolean
}

export interface RuntimePoolOptions {
  idleTtlMs: number
  createRuntime: (cwd: string) => Promise<RuntimeResource>
  onRuntimeClosed?: (runtime: RuntimeHandle) => void
}

/**
 * Reuses SDK-owned runtimes while keeping execution serial. A pool entry is
 * keyed by the normalized workspace cwd because the SDK records cwd during
 * session creation. Different cwd entries may remain idle, but two root runs
 * are never orchestrated in parallel by this Phase 2 bridge.
 */
export class RuntimePool {
  private readonly idleTtlMs: number
  private readonly createRuntime: RuntimePoolOptions['createRuntime']
  private readonly onRuntimeClosed: RuntimePoolOptions['onRuntimeClosed']
  private readonly runtimes = new Map<string, RuntimeHandle>()
  private readonly pending = new Map<string, Promise<RuntimeHandle>>()
  private readonly closing = new Map<string, Promise<void>>()
  private closed = false
  private closeTask: Promise<void> | undefined

  constructor(options: RuntimePoolOptions) {
    this.idleTtlMs = options.idleTtlMs
    this.createRuntime = options.createRuntime
    this.onRuntimeClosed = options.onRuntimeClosed
  }

  async acquire(cwd: string): Promise<RuntimeLease> {
    if (this.closed) throw new RuntimePoolClosedError()

    const closing = this.closing.get(cwd)
    if (closing !== undefined) {
      await closing
      if (this.closed) throw new RuntimePoolClosedError()
      return this.acquire(cwd)
    }

    const existing = this.runtimes.get(cwd)
    if (existing !== undefined) {
      if (existing.closeTask !== undefined) await existing.closeTask
      if (this.closed) throw new RuntimePoolClosedError()
      if (existing.closeTask !== undefined) return this.acquire(cwd)
      if (existing.claimed) return { runtime: existing, owner: false }
      this.clearIdleTimer(existing)
      existing.claimed = true
      return { runtime: existing, owner: true }
    }

    const inFlight = this.pending.get(cwd)
    if (inFlight !== undefined) {
      return { runtime: await inFlight, owner: false }
    }

    if (this.hasClaimedRuntime() || this.hasPendingRuntime() || this.hasClosingRuntime()) {
      throw new RuntimeBusyError()
    }

    const creation = (async (): Promise<RuntimeHandle> => {
      const resource = await this.createRuntime(cwd)
      const runtime: RuntimeHandle = {
        key: cwd,
        cwd,
        harness: resource.harness,
        initialize: resource.initialize,
        gate: new RuntimeRunGate(),
        sessionIds: new Set<string>(),
        claimed: true,
        closeTask: undefined,
        idleTimer: undefined,
      }
      this.resourceMap.set(runtime, resource)
      this.runtimes.set(cwd, runtime)
      if (this.closed) {
        await this.closeRuntime(runtime)
        throw new RuntimePoolClosedError()
      }
      return runtime
    })()
    this.pending.set(cwd, creation)

    try {
      return { runtime: await creation, owner: true }
    } finally {
      if (this.pending.get(cwd) === creation) this.pending.delete(cwd)
    }
  }

  acquireExisting(key: string): RuntimeLease | undefined {
    if (this.closed) return undefined
    const runtime = this.runtimes.get(key)
    if (runtime === undefined || runtime.closeTask !== undefined) return undefined
    if (runtime.claimed) return { runtime, owner: false }
    this.clearIdleTimer(runtime)
    runtime.claimed = true
    return { runtime, owner: true }
  }

  hasRuntime(key: string): boolean {
    const runtime = this.runtimes.get(key)
    return runtime !== undefined && runtime.closeTask === undefined
  }

  attachSession(lease: RuntimeLease, sessionId: string): void {
    lease.runtime.sessionIds.add(sessionId)
  }

  async runExclusive<T>(lease: RuntimeLease, task: (runtime: RuntimeHandle) => Promise<T>): Promise<T> {
    if (this.closed) throw new RuntimePoolClosedError()
    if (!lease.owner) throw new RuntimeBusyError()

    try {
      return await lease.runtime.gate.runExclusive(() => task(lease.runtime))
    } finally {
      lease.runtime.claimed = false
      if (this.closed) {
        await this.closeRuntime(lease.runtime)
      } else {
        this.scheduleIdle(lease.runtime)
      }
    }
  }

  async closeRuntime(runtime: RuntimeHandle): Promise<void> {
    this.clearIdleTimer(runtime)
    if (runtime.closeTask !== undefined) return runtime.closeTask

    if (this.runtimes.get(runtime.key) === runtime) this.runtimes.delete(runtime.key)
    runtime.claimed = false
    runtime.closeTask = (async () => {
      this.onRuntimeClosed?.(runtime)
      try {
        // RuntimeResource.dispose owns both the SDK child and its temp root.
        await this.resourceDispose(runtime)
      } finally {
        this.resourceMap.delete(runtime)
        if (this.closing.get(runtime.key) === runtime.closeTask) this.closing.delete(runtime.key)
      }
    })()
    this.closing.set(runtime.key, runtime.closeTask)
    return runtime.closeTask
  }

  async close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask
    this.closed = true
    this.closeTask = (async () => {
      const pendingResults = await Promise.allSettled([...this.pending.values()])
      const pendingErrors = pendingResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
      const closingResults = await Promise.allSettled([...this.closing.values()])
      const closingErrors = closingResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)

      const runtimes = [...this.runtimes.values()]
      const closeResults = await Promise.allSettled(runtimes.map((runtime) => this.closeRuntime(runtime)))
      const closeErrors = closeResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
      const firstError = pendingErrors[0] ?? closingErrors[0] ?? closeErrors[0]
      const firstErrorCode = firstError !== null && typeof firstError === 'object'
        && 'code' in firstError
        ? (firstError as { code?: unknown }).code
        : undefined
      if (
        firstError !== undefined
        && !(firstError instanceof RuntimePoolClosedError)
        && firstErrorCode !== 'BRIDGE_CLOSED'
      ) {
        throw firstError
      }
    })()
    return this.closeTask
  }

  private readonly resourceMap = new WeakMap<RuntimeHandle, RuntimeResource>()

  private async resourceDispose(runtime: RuntimeHandle): Promise<void> {
    const resource = this.resourceMap.get(runtime)
    if (resource !== undefined) {
      await resource.dispose()
      return
    }
    // The map is populated immediately after creation; this fallback only
    // protects a close race around a factory that resolves a thenable.
    await runtime.harness.close()
  }

  private hasClaimedRuntime(): boolean {
    return [...this.runtimes.values()].some((runtime) => runtime.claimed)
  }

  private hasPendingRuntime(): boolean {
    return this.pending.size > 0
  }

  private hasClosingRuntime(): boolean {
    return this.closing.size > 0
  }

  private clearIdleTimer(runtime: RuntimeHandle): void {
    if (runtime.idleTimer !== undefined) {
      clearTimeout(runtime.idleTimer)
      runtime.idleTimer = undefined
    }
  }

  private scheduleIdle(runtime: RuntimeHandle): void {
    if (runtime.closeTask !== undefined || runtime.claimed || runtime.gate.isActive) return
    this.clearIdleTimer(runtime)
    runtime.idleTimer = setTimeout(() => {
      runtime.idleTimer = undefined
      void this.closeRuntime(runtime).catch(() => {
        // A later bridge close retries the same idempotent resource teardown.
      })
    }, this.idleTtlMs)
    runtime.idleTimer.unref?.()
  }
}

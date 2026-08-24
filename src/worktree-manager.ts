import { randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { redactSecretLike } from './config.js'

const execFile = promisify(execFileCallback)
const GIT_COMMAND_TIMEOUT_MS = 30_000
const GIT_OUTPUT_LIMIT = 120_000
const CHANGED_FILES_LIMIT = 512
const CHANGED_FILE_LENGTH_LIMIT = 512

export type WorktreeCleanupState = 'active' | 'removed' | 'preserved_dirty' | 'preserved_error'

export interface WorktreeManagerOptions {
  secretValues?: () => readonly string[]
}

export interface GitRepositoryInfo {
  readonly inputPath: string
  readonly root: string
  readonly commonDir: string
  readonly identity: string
  readonly baseRef: string
  readonly baseCommit: string
}

export interface WorktreeRecord {
  readonly worktreeId: string
  readonly repository: GitRepositoryInfo
  readonly path: string
  readonly branch: string
  readonly name: string
  sessionId?: string
  cleanupState: WorktreeCleanupState
  lastInspection?: WorktreeInspection
  cleanupError?: WorktreeError
}

export interface WorktreeInspection {
  readonly changedFiles: string[]
  readonly changedFilesTruncated: boolean
  readonly gitStatusSummary: string
  readonly dirty: boolean
  readonly cleanupState: WorktreeCleanupState
  readonly cleanupError?: { code: string; message: string }
}

export class WorktreeError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorktreeError'
    this.code = code
  }
}

function bounded(value: string, secretValues: readonly string[] = [], limit = GIT_OUTPUT_LIMIT): string {
  const redacted = redactSecretLike(value, secretValues)
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit)}…`
}

function pathIdentity(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWithin(parent: string, child: string): boolean {
  const parentIdentity = pathIdentity(parent).replace(/\/$/, '')
  const childIdentity = pathIdentity(child).replace(/\/$/, '')
  return childIdentity !== parentIdentity && childIdentity.startsWith(`${parentIdentity}/`)
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

async function runGit(
  cwd: string,
  args: readonly string[],
  secretValues: readonly string[] = [],
): Promise<string> {
  if (args.some((arg) => arg.includes('\0'))) {
    throw new WorktreeError('INVALID_GIT_ARGUMENT', 'Git arguments must not contain NUL characters')
  }

  try {
    const result = await execFile('git', [...args], {
      cwd,
      windowsHide: true,
      timeout: GIT_COMMAND_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_LIMIT,
      shell: false,
    })
    return outputText(result.stdout)
  } catch (error) {
    const details = error as {
      code?: unknown
      killed?: unknown
      signal?: unknown
      stdout?: unknown
      stderr?: unknown
      message?: unknown
    }
    const timedOut = details.killed === true || details.signal === 'SIGTERM'
    const output = outputText(details.stderr) || outputText(details.stdout)
    const message = bounded(
      output || (typeof details.message === 'string' ? details.message : 'Git command failed'),
      secretValues,
      400,
    )
    throw new WorktreeError(
      timedOut ? 'GIT_TIMEOUT' : 'GIT_COMMAND_FAILED',
      timedOut ? 'Git command timed out' : `Git command failed: ${message}`,
      { cause: error },
    )
  }
}

function validateRef(raw: string): string {
  const value = raw.trim()
  if (value.length === 0 || value.length > 256 || value.includes('\0') || value.startsWith('-')) {
    throw new WorktreeError('INVALID_BASE_REF', 'baseRef must be a valid Git revision name')
  }
  return value
}

function parseStatus(status: string, secretValues: readonly string[]): {
  changedFiles: string[]
  changedFilesTruncated: boolean
  gitStatusSummary: string
  dirty: boolean
} {
  const lines = status.replaceAll('\r', '').split('\n').filter((line) => line.length > 0)
  const changedFiles: string[] = []
  let changedFilesTruncated = false
  for (const line of lines) {
    if (changedFiles.length >= CHANGED_FILES_LIMIT) {
      changedFilesTruncated = true
      break
    }
    const rawPath = line.length >= 4 ? line.slice(3).trim() : line.trim()
    const path = rawPath.includes(' -> ')
      ? rawPath.slice(rawPath.lastIndexOf(' -> ') + 4)
      : rawPath
    changedFiles.push(bounded(path, secretValues, CHANGED_FILE_LENGTH_LIMIT))
  }
  return {
    changedFiles,
    changedFilesTruncated,
    gitStatusSummary: bounded(status.trim(), secretValues, 12_000),
    dirty: lines.length > 0,
  }
}

export class WorktreeManager {
  private readonly secretValues: () => readonly string[]
  private readonly records = new Map<string, WorktreeRecord>()
  private root: string | undefined
  private rootTask: Promise<string> | undefined
  private activeCreates = 0
  private readonly createIdleWaiters = new Set<() => void>()
  private closed = false
  private closeTask: Promise<void> | undefined

  constructor(options: WorktreeManagerOptions = {}) {
    this.secretValues = options.secretValues ?? (() => [])
  }

  async validateRepository(repositoryInput: string, baseRefInput?: string): Promise<GitRepositoryInfo> {
    if (!isAbsolute(repositoryInput)) {
      throw new WorktreeError('INVALID_REPOSITORY', 'repo must be an absolute path')
    }

    const candidate = resolve(repositoryInput)
    let candidateReal: string
    try {
      const details = await stat(candidate)
      if (!details.isDirectory()) throw new Error('not a directory')
      candidateReal = await realpath(candidate)
    } catch (error) {
      throw new WorktreeError('INVALID_REPOSITORY', 'repo does not exist or is not accessible', { cause: error })
    }

    let root: string
    try {
      root = (await realpath((await runGit(
        candidateReal,
        ['rev-parse', '--show-toplevel'],
        this.secretValues(),
      )).trim()))
    } catch (error) {
      if (error instanceof WorktreeError && error.code === 'GIT_TIMEOUT') throw error
      throw new WorktreeError('GIT_NOT_REPOSITORY', 'repo is not a supported Git working tree', { cause: error })
    }

    const inside = (await runGit(
      root,
      ['rev-parse', '--is-inside-work-tree'],
      this.secretValues(),
    )).trim()
    const bare = (await runGit(
      root,
      ['rev-parse', '--is-bare-repository'],
      this.secretValues(),
    )).trim()
    if (inside !== 'true' || bare === 'true') {
      throw new WorktreeError('UNSUPPORTED_GIT_REPOSITORY', 'repo must be a non-bare Git working tree')
    }

    const commonRaw = (await runGit(
      root,
      ['rev-parse', '--git-common-dir'],
      this.secretValues(),
    )).trim()
    const commonCandidate = isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw)
    let commonDir: string
    try {
      commonDir = await realpath(commonCandidate)
    } catch (error) {
      throw new WorktreeError('UNSUPPORTED_GIT_REPOSITORY', 'Git common directory is not accessible', { cause: error })
    }

    const baseRef = validateRef(baseRefInput ?? 'HEAD')
    const baseCommit = (await runGit(
      root,
      ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`],
      this.secretValues(),
    )).trim()
    if (!/^[0-9a-f]{7,64}$/i.test(baseCommit)) {
      throw new WorktreeError('INVALID_BASE_REF', 'baseRef did not resolve to a commit')
    }

    return {
      inputPath: candidateReal,
      root,
      commonDir,
      identity: pathIdentity(root),
      baseRef,
      baseCommit,
    }
  }

  private async ensureRoot(): Promise<string> {
    if (this.root !== undefined) return this.root
    if (this.rootTask === undefined) {
      this.rootTask = mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase4-worktrees-'))
        .then((root) => {
          this.root = root
          return root
        })
        .catch((error) => {
          this.rootTask = undefined
          throw error
        })
    }
    return this.rootTask
  }
  private async waitForCreates(): Promise<void> {
    if (this.activeCreates === 0) return
    await new Promise<void>((resolve) => this.createIdleWaiters.add(resolve))
  }
  private finishCreate(): void {
    this.activeCreates -= 1
    if (this.activeCreates !== 0) return
    for (const resolve of this.createIdleWaiters) resolve()
    this.createIdleWaiters.clear()
  }

  async create(repository: GitRepositoryInfo, name: string): Promise<WorktreeRecord> {
    this.activeCreates += 1
    try {
    if (this.closed) throw new WorktreeError('BRIDGE_CLOSED', 'The MCP bridge is shutting down')
    const root = await this.ensureRoot()
    if (this.closed) throw new WorktreeError('BRIDGE_CLOSED', 'The MCP bridge is shutting down')

    const worktreeId = `dsh-wt-${randomUUID()}`
    const branch = `dsh-mcp/${worktreeId}`
    const path = join(root, worktreeId)
    try {
      await runGit(
        repository.root,
        ['worktree', 'add', '-b', branch, path, repository.baseCommit],
        this.secretValues(),
      )
      const canonicalPath = await realpath(path)
      if (!isWithin(root, canonicalPath)) {
        throw new WorktreeError('WORKTREE_CREATE_FAILED', 'Git created a worktree outside the bridge-owned root')
      }
      const record: WorktreeRecord = {
        worktreeId,
        repository,
        path: canonicalPath,
        branch,
        name,
        cleanupState: 'active',
      }
      this.records.set(worktreeId, record)
      if (this.closed) {
        await this.cleanup(worktreeId)
        throw new WorktreeError('BRIDGE_CLOSED', 'The MCP bridge is shutting down')
      }
      return record
    } catch (error) {
      if (error instanceof WorktreeError) throw error
      throw new WorktreeError('WORKTREE_CREATE_FAILED', 'Git could not create the worker worktree', { cause: error })
    }
    } finally {
      this.finishCreate()
    }
  }

  attachSession(worktreeId: string, sessionId: string): void {
    const record = this.records.get(worktreeId)
    if (record === undefined) throw new WorktreeError('WORKTREE_NOT_FOUND', 'The worker worktree does not exist')
    record.sessionId = sessionId
  }

  get(worktreeId: string): WorktreeRecord | undefined {
    return this.records.get(worktreeId)
  }

  async inspect(worktreeId: string): Promise<WorktreeInspection> {
    const record = this.records.get(worktreeId)
    if (record === undefined) throw new WorktreeError('WORKTREE_NOT_FOUND', 'The worker worktree does not exist')
    if (record.lastInspection !== undefined && record.cleanupState === 'removed') return record.lastInspection

    try {
      const status = await runGit(
        record.path,
        ['status', '--porcelain=v1', '--untracked-files=all'],
        this.secretValues(),
      )
      const parsed = parseStatus(status, this.secretValues())
      const inspection: WorktreeInspection = {
        ...parsed,
        cleanupState: record.cleanupState,
        ...(record.cleanupError === undefined
          ? {}
          : { cleanupError: { code: record.cleanupError.code, message: record.cleanupError.message } }),
      }
      record.lastInspection = inspection
      return inspection
    } catch (error) {
      if (error instanceof WorktreeError) throw error
      throw new WorktreeError('WORKTREE_STATUS_FAILED', 'Git status could not be read', { cause: error })
    }
  }

  async cleanup(worktreeId: string): Promise<WorktreeInspection> {
    const record = this.records.get(worktreeId)
    if (record === undefined) throw new WorktreeError('WORKTREE_NOT_FOUND', 'The worker worktree does not exist')
    if (record.cleanupState !== 'active') {
      return record.lastInspection ?? {
        changedFiles: [],
        changedFilesTruncated: false,
        gitStatusSummary: '',
        dirty: record.cleanupState === 'preserved_dirty',
        cleanupState: record.cleanupState,
        ...(record.cleanupError === undefined
          ? {}
          : { cleanupError: { code: record.cleanupError.code, message: record.cleanupError.message } }),
      }
    }

    let inspection: WorktreeInspection
    try {
      inspection = await this.inspect(worktreeId)
    } catch (error) {
      const failure = error instanceof WorktreeError
        ? error
        : new WorktreeError('WORKTREE_STATUS_FAILED', 'Git status could not be read', { cause: error })
      record.cleanupState = 'preserved_error'
      record.cleanupError = failure
      record.lastInspection = {
        changedFiles: [],
        changedFilesTruncated: false,
        gitStatusSummary: '',
        dirty: true,
        cleanupState: record.cleanupState,
        cleanupError: { code: failure.code, message: failure.message },
      }
      return record.lastInspection
    }

    if (inspection.dirty) {
      record.cleanupState = 'preserved_dirty'
      record.lastInspection = { ...inspection, cleanupState: record.cleanupState }
      return record.lastInspection
    }

    try {
      await runGit(
        record.repository.root,
        ['worktree', 'remove', record.path],
        this.secretValues(),
      )
      try {
        await runGit(
          record.repository.root,
          ['branch', '-D', '--', record.branch],
          this.secretValues(),
        )
      } catch {
        // The worktree is already removed; leave the generated branch for manual cleanup.
      }
      record.cleanupState = 'removed'
      record.lastInspection = { ...inspection, cleanupState: record.cleanupState }
      return record.lastInspection
    } catch (error) {
      const failure = error instanceof WorktreeError
        ? error
        : new WorktreeError('WORKTREE_CLEANUP_FAILED', 'Git could not remove the bridge-owned worktree', { cause: error })
      record.cleanupState = 'preserved_error'
      record.cleanupError = failure
      record.lastInspection = {
        ...inspection,
        cleanupState: record.cleanupState,
        cleanupError: { code: failure.code, message: failure.message },
      }
      return record.lastInspection
    }
  }

  async onRuntimeClosed(sessionIds: Iterable<string>): Promise<void> {
    const closedSessions = new Set(sessionIds)
    await Promise.all(
      [...this.records.values()]
        .filter((record) => record.sessionId !== undefined && closedSessions.has(record.sessionId))
        .map((record) => this.cleanup(record.worktreeId)),
    )
  }

  async close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask
    this.closed = true
    this.closeTask = (async () => {
      if (this.rootTask !== undefined) await this.rootTask.catch(() => {})
      await this.waitForCreates()
      await Promise.all([...this.records.keys()].map((worktreeId) => this.cleanup(worktreeId)))
      if (this.root !== undefined) {
        await rm(this.root, { recursive: false, force: true }).catch(() => {})
      }
    })()
    return this.closeTask
  }
}

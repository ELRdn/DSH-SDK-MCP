import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { redactSecretLike } from './config.js'
import {
  WorktreeError,
  WorktreeManager,
  type WorktreeRecord,
  type GitRepositoryInfo,
  runGitCommand,
} from './worktree-manager.js'

export const MAX_PHASE5_FILES = 512
export const MAX_PHASE5_DIFF_CHARS = 50_000
export const MAX_PHASE5_CONFLICT_MARKERS = 128

const GIT_STATUS_LIMIT = 120_000
const SECRET_PATH_PATTERN = /(^|[\\/])(?:\.env(?:\..*)?|.*(?:secret|credential|token|password|passwd|auth|private|id_rsa).*|.*\.(?:pem|key|p12|pfx))$/i

export interface WorktreeGitMetadata {
  readonly currentHead: string
  readonly dirty: boolean
  readonly stagedCount: number
  readonly unstagedCount: number
  readonly untrackedCount: number
  readonly changedFiles: string[]
  readonly changedFilesTruncated: boolean
  readonly additions: number
  readonly deletions: number
  readonly diffSummary: string
  readonly gitStatusSummary: string
  readonly conflictMarkers: string[]
  readonly conflictMarkersTruncated: boolean
}

export interface WorkerSnapshot {
  readonly snapshotId: string
  readonly snapshotCommit: string
  readonly snapshotTree: string
  readonly sourceHead: string
  readonly worktreeId: string
  readonly sessionId: string
  readonly name: string
  readonly changedFiles: string[]
  readonly includedUntrackedFiles: string[]
  readonly excludedUntrackedFiles: string[]
}

export interface IntegrationWorkerRef {
  readonly sessionId: string
  readonly worktreeId: string
  readonly name: string
  readonly status: 'applied' | 'empty' | 'conflict' | 'pending'
  readonly snapshotCommit: string
}

export interface IntegrationResult {
  readonly ok: boolean
  readonly status: 'applied' | 'conflict' | 'error'
  readonly integrationWorktreeId: string
  readonly integrationWorktreePath: string
  readonly integrationBranch: string
  readonly repository: string
  readonly repositoryIdentity: string
  readonly commonDir: string
  readonly baseRef: string
  readonly baseCommit: string
  readonly currentHead: string
  readonly integrationWorktreeDirty: boolean
  readonly clean: boolean
  readonly changedFiles: string[]
  readonly changedFilesTruncated: boolean
  readonly additions: number
  readonly deletions: number
  readonly stagedCount: number
  readonly unstagedCount: number
  readonly untrackedCount: number
  readonly diffSummary: string
  readonly gitStatusSummary: string
  readonly conflictMarkers: string[]
  readonly conflictMarkersTruncated: boolean
  readonly appliedWorkers: IntegrationWorkerRef[]
  readonly pendingWorkers: IntegrationWorkerRef[]
  readonly conflictingWorker?: IntegrationWorkerRef
  readonly conflictingFiles: string[]
  readonly snapshotMetadata: WorkerSnapshot[]
  readonly error?: { code: string; message: string }
}

function bounded(value: string, secretValues: readonly string[], limit: number): string {
  const redacted = redactSecretLike(value, secretValues)
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit)}…`
}

function boundedList(values: readonly string[], secretValues: readonly string[], limit = MAX_PHASE5_FILES): { values: string[]; truncated: boolean } {
  const unique = [...new Set(values)]
  return {
    values: unique.slice(0, limit).map((value) => bounded(value, secretValues, 512)),
    truncated: unique.length > limit,
  }
}

function parseNulList(value: string): string[] {
  return value.split('\0').filter((entry) => entry.length > 0)
}

function parseStatus(value: string): {
  paths: string[]
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  conflict: boolean
} {
  const paths: string[] = []
  let stagedCount = 0
  let unstagedCount = 0
  let untrackedCount = 0
  let conflict = false
  const entries = parseNulList(value)
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.length < 3) continue
    const staged = entry[0]
    const unstaged = entry[1]
    const path = entry.slice(3)
    paths.push(path)
    if (staged === '?' && unstaged === '?') {
      untrackedCount += 1
    } else {
      if (staged !== ' ') stagedCount += 1
      if (unstaged !== ' ') unstagedCount += 1
    }
    if (staged === 'U' || unstaged === 'U' || (staged === 'A' && unstaged === 'A') || (staged === 'D' && unstaged === 'D')) {
      conflict = true
    }
    if (staged === 'R' || staged === 'C' || unstaged === 'R' || unstaged === 'C') index += 1
  }
  return { paths, stagedCount, unstagedCount, untrackedCount, conflict }
}

function parseNumstat(value: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of value.replaceAll('\r', '').split('\n')) {
    const [added, deleted] = line.split('\t')
    if (added !== undefined && /^\d+$/.test(added)) additions += Number(added)
    if (deleted !== undefined && /^\d+$/.test(deleted)) deletions += Number(deleted)
  }
  return { additions, deletions }
}

function workerRef(record: WorktreeRecord, snapshot: WorkerSnapshot, status: IntegrationWorkerRef['status'], secretValues: readonly string[] = []): IntegrationWorkerRef {
  if (record.sessionId === undefined) throw new WorktreeError('WORKER_NOT_FOUND', 'Integration requires a worker session')
  return {
    sessionId: record.sessionId,
    worktreeId: record.worktreeId,
    name: bounded(record.name, secretValues, 128),
    status,
    snapshotCommit: snapshot.snapshotCommit,
  }
}

export class IntegrationManager {
  private readonly worktrees: WorktreeManager
  private readonly secretValues: () => readonly string[]

  constructor(worktrees: WorktreeManager, secretValues: () => readonly string[]) {
    this.worktrees = worktrees
    this.secretValues = secretValues
  }

  private requireRecord(record: WorktreeRecord): void {
    if (record.sessionId === undefined) throw new WorktreeError('WORKER_NOT_FOUND', 'The identifier is not a worker session')
    if (record.cleanupState === 'removed') throw new WorktreeError('WORKER_NOT_FOUND', 'The worker worktree is no longer active')
  }

  async review(record: WorktreeRecord): Promise<WorktreeGitMetadata> {
    if (record.cleanupState === 'removed') throw new WorktreeError('WORKER_NOT_FOUND', 'The worktree is no longer active')
    const secretValues = this.secretValues()
    const statusResult = await runGitCommand(
      record.path,
      ['status', '--porcelain=v1', '--untracked-files=all', '-z'],
      secretValues,
    )
    const status = parseStatus(statusResult.stdout)
    const [currentHead, namesResult, numstatResult, statResult, markerResult] = await Promise.all([
      runGitCommand(record.path, ['rev-parse', 'HEAD'], secretValues),
      runGitCommand(record.path, ['diff', '--name-only', '-z', record.repository.baseCommit, '--'], secretValues),
      runGitCommand(record.path, ['diff', '--numstat', record.repository.baseCommit, '--'], secretValues),
      runGitCommand(record.path, ['diff', '--stat', record.repository.baseCommit, '--'], secretValues),
      runGitCommand(
        record.path,
        ['grep', '--no-index', '-n', '-I', '-E', '^(<<<<<<<|=======|>>>>>>>)', '--', '.'],
        secretValues,
        { allowExitCodes: [1] },
      ),
    ])
    const changed = boundedList(
      [...parseNulList(namesResult.stdout), ...status.paths],
      secretValues,
    )
    const markers = boundedList(markerResult.stdout.replaceAll('\r', '').split('\n').filter(Boolean), secretValues, MAX_PHASE5_CONFLICT_MARKERS)
    const counts = parseNumstat(numstatResult.stdout)
    return {
      currentHead: bounded(currentHead.stdout.trim(), secretValues, 128),
      dirty: status.paths.length > 0,
      stagedCount: status.stagedCount,
      unstagedCount: status.unstagedCount,
      untrackedCount: status.untrackedCount,
      changedFiles: changed.values,
      changedFilesTruncated: changed.truncated,
      additions: counts.additions,
      deletions: counts.deletions,
      diffSummary: bounded(statResult.stdout, secretValues, MAX_PHASE5_DIFF_CHARS),
      gitStatusSummary: bounded(statusResult.stdout.replaceAll('\0', '\n'), secretValues, GIT_STATUS_LIMIT),
      conflictMarkers: markers.values,
      conflictMarkersTruncated: markers.truncated,
    }
  }

  async snapshot(record: WorktreeRecord, baseCommit: string): Promise<WorkerSnapshot> {
    this.requireRecord(record)
    const secretValues = this.secretValues()
    const snapshotId = `dsh-snapshot-${randomUUID()}`
    const snapshotRoot = await mkdtemp(join(tmpdir(), 'dsh-sdk-mcp-phase5-snapshot-'))
    const indexFile = join(snapshotRoot, 'index')
    const indexEnv = { GIT_INDEX_FILE: indexFile }
    try {
      const sourceHead = (await runGitCommand(record.path, ['rev-parse', 'HEAD'], secretValues)).stdout.trim()
      const metadata = await this.review(record)
      const untracked = parseNulList((await runGitCommand(
        record.path,
        ['ls-files', '--others', '--exclude-standard', '-z'],
        secretValues,
      )).stdout)
      const ignored = parseNulList((await runGitCommand(
        record.path,
        ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
        secretValues,
      )).stdout)
      const excluded = [...new Set([...untracked, ...ignored].filter((path) => SECRET_PATH_PATTERN.test(path)))]
      const included = untracked.filter((path) => !SECRET_PATH_PATTERN.test(path))
      await runGitCommand(record.path, ['read-tree', baseCommit], secretValues, { env: indexEnv })
      await runGitCommand(record.path, ['add', '-u', '--', '.'], secretValues, { env: indexEnv })
      if (included.length > 0) await runGitCommand(record.path, ['add', '--', ...included], secretValues, { env: indexEnv })
      const snapshotTree = (await runGitCommand(record.path, ['write-tree'], secretValues, { env: indexEnv })).stdout.trim()
      const snapshotCommit = (await runGitCommand(
        record.path,
        ['commit-tree', snapshotTree, '-p', baseCommit, '-m', `dsh-mcp phase5 snapshot ${snapshotId}`],
        secretValues,
        {
          env: {
            ...indexEnv,
            GIT_AUTHOR_NAME: 'dsh-sdk-mcp phase5',
            GIT_AUTHOR_EMAIL: 'dsh-sdk-mcp@localhost.invalid',
            GIT_COMMITTER_NAME: 'dsh-sdk-mcp phase5',
            GIT_COMMITTER_EMAIL: 'dsh-sdk-mcp@localhost.invalid',
            GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
            GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
          },
        },
      )).stdout.trim()
      return {
        snapshotId,
        snapshotCommit: bounded(snapshotCommit, secretValues, 128),
        snapshotTree: bounded(snapshotTree, secretValues, 128),
        sourceHead: bounded(sourceHead, secretValues, 128),
        worktreeId: record.worktreeId,
        sessionId: record.sessionId as string,
        name: bounded(record.name, secretValues, 128),
        changedFiles: metadata.changedFiles,
        includedUntrackedFiles: boundedList(included, secretValues).values,
        excludedUntrackedFiles: boundedList(excluded, secretValues).values,
      }
    } finally {
      await rm(snapshotRoot, { recursive: true, force: true }).catch(() => {})
    }
  }

  async integrate(repository: GitRepositoryInfo, records: readonly WorktreeRecord[]): Promise<IntegrationResult> {
    const snapshots: Array<{ record: WorktreeRecord; snapshot: WorkerSnapshot }> = []
    for (const record of records) snapshots.push({ record, snapshot: await this.snapshot(record, repository.baseCommit) })

    const integration = await this.worktrees.create(repository, `phase5-integration-${randomUUID()}`)
    const appliedWorkers: IntegrationWorkerRef[] = []
    for (let index = 0; index < snapshots.length; index += 1) {
      const entry = snapshots[index]
      const currentTree = (await runGitCommand(integration.path, ['rev-parse', 'HEAD^{tree}'], this.secretValues())).stdout.trim()
      if (currentTree === entry.snapshot.snapshotTree) {
        appliedWorkers.push(workerRef(entry.record, entry.snapshot, 'empty', this.secretValues()))
        continue
      }
      const cherryPick = await runGitCommand(
        integration.path,
        ['cherry-pick', '--no-edit', entry.snapshot.snapshotCommit],
        this.secretValues(),
        { allowExitCodes: [1] },
      )
      if (cherryPick.exitCode !== 0) {
        const metadata = await this.review(integration)
        const conflictFiles = parseNulList((await runGitCommand(
          integration.path,
          ['diff', '--name-only', '-z', '--diff-filter=U', '--'],
          this.secretValues(),
        )).stdout)
        const conflictingWorker = workerRef(entry.record, entry.snapshot, 'conflict', this.secretValues())
        return this.result(repository, integration, metadata, 'conflict', appliedWorkers, [conflictingWorker, ...snapshots.slice(index + 1).map(({ record, snapshot }) => workerRef(record, snapshot, 'pending', this.secretValues()))], snapshots.map(({ snapshot }) => snapshot), conflictingWorker, conflictFiles)
      }
      appliedWorkers.push(workerRef(entry.record, entry.snapshot, 'applied', this.secretValues()))
    }
    const metadata = await this.review(integration)
    return this.result(repository, integration, metadata, 'applied', appliedWorkers, [], snapshots.map(({ snapshot }) => snapshot))
  }

  private result(
    repository: GitRepositoryInfo,
    integration: WorktreeRecord,
    metadata: WorktreeGitMetadata,
    status: 'applied' | 'conflict',
    appliedWorkers: IntegrationWorkerRef[],
    pendingWorkers: IntegrationWorkerRef[],
    snapshots: WorkerSnapshot[],
    conflictingWorker?: IntegrationWorkerRef,
    conflictingFiles: string[] = [],
  ): IntegrationResult {
    const secretValues = this.secretValues()
    return {
      ok: status === 'applied',
      status,
      integrationWorktreeId: bounded(integration.worktreeId, secretValues, 128),
      integrationWorktreePath: bounded(integration.path, secretValues, 4096),
      integrationBranch: bounded(integration.branch, secretValues, 256),
      repository: bounded(repository.root, secretValues, 4096),
      repositoryIdentity: bounded(repository.identity, secretValues, 4096),
      commonDir: bounded(repository.commonDir, secretValues, 4096),
      baseRef: bounded(repository.baseRef, secretValues, 256),
      baseCommit: bounded(repository.baseCommit, secretValues, 128),
      currentHead: metadata.currentHead,
      integrationWorktreeDirty: metadata.dirty,
      clean: !metadata.dirty,
      changedFiles: metadata.changedFiles,
      changedFilesTruncated: metadata.changedFilesTruncated,
      additions: metadata.additions,
      deletions: metadata.deletions,
      stagedCount: metadata.stagedCount,
      unstagedCount: metadata.unstagedCount,
      untrackedCount: metadata.untrackedCount,
      diffSummary: metadata.diffSummary,
      gitStatusSummary: metadata.gitStatusSummary,
      conflictMarkers: metadata.conflictMarkers,
      conflictMarkersTruncated: metadata.conflictMarkersTruncated,
      appliedWorkers,
      pendingWorkers,
      ...(conflictingWorker === undefined ? {} : { conflictingWorker }),
      conflictingFiles: boundedList(conflictingFiles, secretValues).values,
      snapshotMetadata: snapshots,
      ...(status === 'conflict' ? { error: { code: 'INTEGRATION_CONFLICT', message: 'Git reported a conflict; the integration worktree was preserved for inspection' } } : {}),
    }
  }
}

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { redactArgs, redactSecretLike, secretValuesFromEnvironment } from './config.js'

const require = createRequire(import.meta.url)

export type StageStatus = 'passed' | 'failed' | 'skipped' | 'inconclusive'

export type SandboxCapabilityStatus =
  | 'verified-full'
  | 'observed-partial'
  | 'inconclusive'
  | 'failed'

export interface StageResult {
  status: StageStatus
  details: Record<string, unknown>
  error?: {
    code?: string
    message: string
  }
}

export interface Phase0Report {
  schemaVersion: 3
  status: 'passed' | 'failed'
  coreStatus: 'passed' | 'failed'
  phase1Eligible: false
  profile: string
  provider: string
  model: string
  credentialRef: string
  startedAt: string
  finishedAt: string
  platform: {
    node: string
    platform: NodeJS.Platform
    arch: string
    release: string
    osVersion: string
    windowsRequired: boolean
  }
  dependencies: Record<string, string | null>
  launch: {
    command: string
    args: string[]
    cwd?: string
    cordisConfig?: string
    overrideKeys: string[]
  }
  stages: {
    protocol: StageResult
    tool: StageResult
    lifecycle: StageResult
    sandbox: StageResult
    cleanup: StageResult
  }
  sandboxCapability: {
    status: SandboxCapabilityStatus
    details: Record<string, unknown>
  }
  coreFailures: string[]
  failures: string[]
}

export const MAX_SAFE_ERROR_MESSAGE_CHARS = 400

export function packageVersion(packageName: string): string | null {
  try {
    const metadata = require(`${packageName}/package.json`) as { version?: unknown }
    return typeof metadata.version === 'string' ? metadata.version : null
  } catch {
    try {
      const directPackageJson = join(process.cwd(), 'node_modules', ...packageName.split('/'), 'package.json')
      const metadata = JSON.parse(readFileSync(directPackageJson, 'utf8')) as { version?: unknown }
      return typeof metadata.version === 'string' ? metadata.version : null
    } catch {
      try {
        let directory = dirname(require.resolve(packageName))
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version?: unknown }
            return typeof metadata.version === 'string' ? metadata.version : null
          } catch {
            directory = dirname(directory)
          }
        }
      } catch {
        return null
      }
      return null
    }
  }
}
export function safeError(
  error: unknown,
  secretValues: readonly string[] = [],
): { code?: string; message: string } {
  const bounded = (message: string): string => (
    message.length <= MAX_SAFE_ERROR_MESSAGE_CHARS
      ? message
      : `${message.slice(0, MAX_SAFE_ERROR_MESSAGE_CHARS)}…`
  )
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown }
    return {
      code: typeof candidate.code === 'string'
        ? bounded(redactSecretLike(candidate.code, secretValues))
        : undefined,
      message: bounded(redactSecretLike(error.message, secretValues)),
    }
  }
  return { message: bounded(redactSecretLike(String(error), secretValues)) }
}

export function redactEnvironmentKeys(environment: NodeJS.ProcessEnv): string[] {
  return Object.keys(environment)
    .filter((key) => /(key|token|secret|password|authorization)/i.test(key))
    .sort()
}

export function makeLaunchReport(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): Phase0Report['launch'] {
  const secretValues = secretValuesFromEnvironment(environment)
  return {
    command: redactSecretLike(command, secretValues),
    args: redactArgs(args, secretValues),
    cwd: cwd === undefined ? undefined : redactSecretLike(cwd, secretValues),
    cordisConfig: environment.DSH_CORDIS_CONFIG === undefined
      ? undefined
      : redactSecretLike(environment.DSH_CORDIS_CONFIG, secretValues),
    overrideKeys: redactEnvironmentKeys(environment),
  }
}

export function stagePassed(details: Record<string, unknown> = {}): StageResult {
  return { status: 'passed', details }
}

export function stageSkipped(reason: string): StageResult {
  return { status: 'skipped', details: { reason } }
}

export function stageInconclusive(details: Record<string, unknown> = {}): StageResult {
  return { status: 'inconclusive', details }
}

export function stageFailed(
  error: unknown,
  details: Record<string, unknown> = {},
  secretValues: readonly string[] = [],
): StageResult {
  return { status: 'failed', details, error: safeError(error, secretValues) }
}

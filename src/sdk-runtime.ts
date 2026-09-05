import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DeepSeekHarness,
  type DeepSeekHarnessOptions,
} from '@deepseek-ai/dsh-sdk-client'

import type { RuntimeLaunchConfig } from './config.js'

const require = createRequire(import.meta.url)
const externalRuntimeLauncher = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'external-runtime-launcher.js',
)

const EXTERNAL_COMMAND = 'DSH_MCP_EXTERNAL_RUNTIME_COMMAND'
const EXTERNAL_ARGS = 'DSH_MCP_EXTERNAL_RUNTIME_ARGS_JSON'
const EXTERNAL_CWD = 'DSH_MCP_EXTERNAL_RUNTIME_CWD'

export interface HarnessRoute {
  cwd: string
  provider?: string
  model?: string
  maxTokens?: number
  dshHome?: string
  env?: NodeJS.ProcessEnv
  initializeTimeoutMs?: number
}

export interface MaterializedRuntimeLaunch {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/** Resolve the exact DSH CLI installed beside the pinned SDK client. */
export function resolveBundledDshBin(): string {
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin?: string | Record<string, string>
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  if (typeof bin !== 'string' || bin.length === 0) {
    throw new Error('@deepseek-ai/dsh declares no dsh executable')
  }
  return join(dirname(manifestPath), bin)
}

/**
 * Materialize the SDK-owned DSH invocation for the Phase 0 process audit.
 * Normal bridge turns let the official SDK perform this resolution itself.
 */
export function materializeRuntimeLaunch(launch: RuntimeLaunchConfig): MaterializedRuntimeLaunch {
  if (launch.command !== undefined) {
    return {
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
    }
  }

  return {
    command: process.execPath,
    args: [
      launch.dshBin ?? resolveBundledDshBin(),
      '--profile',
      launch.profile,
      ...launch.patches.flatMap((path) => ['--patch', path]),
    ],
    cwd: launch.cwd,
    env: launch.env,
  }
}

/**
 * Build a DSH 0.1.2+ harness while preserving the bridge's legacy explicit
 * command/argv seam. The default path launches the same-version bundled DSH
 * CLI with its official `sdk` profile.
 */
export function createDeepSeekHarness(
  launch: RuntimeLaunchConfig,
  route: HarnessRoute,
): DeepSeekHarness {
  const environment = route.env ?? launch.env
  const options: DeepSeekHarnessOptions = {
    profile: launch.profile,
    patches: launch.patches,
    dshBin: launch.dshBin,
    dshHome: route.dshHome ?? launch.dshHome,
    processCwd: launch.cwd ?? route.cwd,
    env: environment,
    initializeTimeoutMs: route.initializeTimeoutMs ?? launch.initializeTimeoutMs,
    requestTimeoutMs: launch.requestTimeoutMs,
    shutdownTimeoutMs: launch.shutdownTimeoutMs,
    disposeEofGraceMs: launch.disposeEofGraceMs,
    disposeGraceMs: launch.disposeGraceMs,
    cwd: route.cwd,
    provider: route.provider,
    model: route.model,
    maxTokens: route.maxTokens,
  }

  if (launch.command !== undefined) {
    options.dshBin = externalRuntimeLauncher
    options.profile = 'sdk'
    options.patches = []
    options.env = {
      ...(environment ?? process.env),
      [EXTERNAL_COMMAND]: launch.command,
      [EXTERNAL_ARGS]: JSON.stringify(launch.args),
      ...(launch.cwd === undefined ? {} : { [EXTERNAL_CWD]: launch.cwd }),
    }
  }

  return new DeepSeekHarness(options)
}

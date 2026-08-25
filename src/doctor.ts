import { execFile as execFileCallback } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { arch, platform, version as osVersion } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

import {
  MAX_PARALLEL_HARD_LIMIT,
  loadPhase0Options,
  loadRuntimeLaunchConfig,
  redactSecretLike,
  secretValuesFromEnvironment,
  type Phase0Options,
  type RuntimeLaunchConfig,
} from './config.js'
import { packageVersion, safeError, MAX_SAFE_ERROR_MESSAGE_CHARS } from './report.js'

const execFile = promisify(execFileCallback)
const MCP_PROTOCOL_REVISION = '2025-11-25'
const DEFAULT_MAX_PARALLEL = 3

export type DoctorStatus = 'ready' | 'needs-configuration' | 'error'

export interface DoctorReport {
  readonly schemaVersion: 1
  readonly status: DoctorStatus
  readonly packageVersion: string
  readonly node: {
    version: string
    platform: string
    arch: string
    osVersion: string
  }
  readonly mcp: {
    sdkVersion: string | null
    protocolRevision: string
    transport: 'stdio'
  }
  readonly dsh: {
    clientVersion: string | null
    protocolVersion: string | null
    runtimePackage: string
    runtimePackageVersion: string | null
    runtimeCommandConfigured: boolean
    runtimeCommandAvailable: boolean
    runtimeArgsConfigured: boolean
    runtimeArgsCount: number
    externalRuntimeRequired: true
  }
  readonly provider: {
    profile: string
    provider: string
    model: string
    credentialConfigured: boolean
    readiness: 'not-probed'
  }
  readonly cordis: {
    configured: boolean
    available: boolean
  }
  readonly workspace: {
    configured: boolean
    absolute: boolean
    available: boolean
  }
  readonly git: {
    available: boolean
  }
  readonly maxParallel: {
    configured: number
    hardLimit: number
  }
  readonly sandbox: 'inconclusive'
  readonly warnings: string[]
}

interface CommandCheck {
  available: boolean
  message?: string
}

async function commandAvailable(
  command: string | undefined,
  args: readonly string[],
  secretValues: readonly string[],
): Promise<CommandCheck> {
  if (command === undefined || command.trim() === '') return { available: false }
  try {
    await execFile(command, [...args], {
      shell: false,
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 8_000,
    })
    return { available: true }
  } catch (error) {
    const safe = safeError(error, secretValues)
    return {
      available: false,
      message: safe.message.slice(0, MAX_SAFE_ERROR_MESSAGE_CHARS),
    }
  }
}

async function directoryEntryAvailable(path: string | undefined): Promise<boolean> {
  if (path === undefined || path.trim() === '') return false
  try {
    const details = await stat(path)
    return details.isDirectory()
  } catch {
    return false
  }
}

async function fileEntryAvailable(path: string | undefined): Promise<boolean> {
  if (path === undefined || path.trim() === '') return false
  try {
    const details = await stat(path)
    return details.isFile()
  } catch {
    return false
  }
}

function credentialConfigured(environment: NodeJS.ProcessEnv, options: Phase0Options): boolean {
  const references = new Set([options.credentialRef])
  if (options.profile === 'opencode-go') {
    references.add('OPENCODE_API_KEY')
    references.add('OPENCODE_GO_API_KEY')
  }
  return [...references].some((reference) => {
    const value = environment[reference]
    return typeof value === 'string' && value.trim().length > 0
  })
}

async function packageVersionFromRoot(root: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function validMaxParallel(environment: NodeJS.ProcessEnv): number {
  const raw = environment.DSH_MCP_MAX_PARALLEL?.trim()
  if (raw === undefined || raw === '') return DEFAULT_MAX_PARALLEL
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_MAX_PARALLEL
  return Math.min(value, MAX_PARALLEL_HARD_LIMIT)
}

export async function collectDoctor(
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot: string,
): Promise<DoctorReport> {
  let options: Phase0Options
  let optionsError: string | undefined
  try {
    options = loadPhase0Options(environment, projectRoot)
  } catch (error) {
    optionsError = safeError(error, secretValuesFromEnvironment(environment)).message
    options = loadPhase0Options({}, projectRoot)
  }

  let launch: RuntimeLaunchConfig | undefined
  let launchError: string | undefined
  try {
    if (environment.DSH_MCP_RUNTIME_COMMAND?.trim()) {
      launch = loadRuntimeLaunchConfig(environment, projectRoot)
    }
  } catch (error) {
    launchError = safeError(error, secretValuesFromEnvironment(environment)).message
  }

  const secretValues = secretValuesFromEnvironment(environment, options.credentialRef)
  const runtimeCommand = environment.DSH_MCP_RUNTIME_COMMAND?.trim()
  const runtimeCommandCheck = await commandAvailable(runtimeCommand, ['--version'], secretValues)
  const gitCheck = await commandAvailable('git', ['--version'], secretValues)
  const cordisAvailable = await fileEntryAvailable(options.cordisConfig)
  const workspaceValue = environment.DSH_MCP_RUNTIME_CWD?.trim()
  const workspaceAbsolute = workspaceValue !== undefined && isAbsolute(workspaceValue)
  const workspaceAvailable = workspaceAbsolute && await directoryEntryAvailable(workspaceValue)
  const packageVersionValue = await packageVersionFromRoot(projectRoot)
  const runtimeArgs = environment.DSH_MCP_RUNTIME_ARGS?.trim()
  let runtimeArgsCount = 0
  if (runtimeArgs !== undefined && runtimeArgs !== '') {
    try {
      const parsed = JSON.parse(runtimeArgs) as unknown
      if (Array.isArray(parsed)) runtimeArgsCount = parsed.length
    } catch {
      // The launch diagnostic below reports malformed arguments without echoing them.
    }
  }

  const warnings: string[] = []
  if (optionsError !== undefined) warnings.push('provider configuration is invalid')
  if (launchError !== undefined) warnings.push('runtime launch configuration is invalid')
  if (runtimeCommand === undefined || runtimeCommand === '') warnings.push('set DSH_MCP_RUNTIME_COMMAND and DSH_MCP_RUNTIME_ARGS to an external DSH JSON-RPC runtime')
  else if (!runtimeCommandCheck.available) warnings.push('the configured runtime command is not available')
  if (!cordisAvailable) warnings.push('the selected Cordis configuration is not available in this installation')
  if (!gitCheck.available) warnings.push('git is unavailable; worktree tools cannot operate')
  if (!credentialConfigured(environment, options)) warnings.push(`credential is not configured for ${options.credentialRef}`)
  if (workspaceValue !== undefined && (!workspaceAbsolute || !workspaceAvailable)) warnings.push('DSH_MCP_RUNTIME_CWD must be an existing absolute directory')

  const fatal = optionsError !== undefined || launchError !== undefined || !cordisAvailable || !gitCheck.available
  const needsConfiguration = runtimeCommand === undefined
    || runtimeCommand === ''
    || !runtimeCommandCheck.available
    || !credentialConfigured(environment, options)
  const status: DoctorStatus = fatal ? 'error' : needsConfiguration ? 'needs-configuration' : 'ready'

  return {
    schemaVersion: 1,
    status,
    packageVersion: packageVersionValue,
    node: {
      version: process.version,
      platform: platform(),
      arch: arch(),
      osVersion: osVersion(),
    },
    mcp: {
      sdkVersion: packageVersion('@modelcontextprotocol/sdk'),
      protocolRevision: MCP_PROTOCOL_REVISION,
      transport: 'stdio',
    },
    dsh: {
      clientVersion: packageVersion('@deepseek-ai/dsh-sdk-client'),
      protocolVersion: packageVersion('@deepseek-ai/dsh-sdk-protocol'),
      runtimePackage: redactSecretLike(options.runtimePackage, secretValues),
      runtimePackageVersion: packageVersion(options.runtimePackage),
      runtimeCommandConfigured: runtimeCommand !== undefined && runtimeCommand !== '',
      runtimeCommandAvailable: runtimeCommandCheck.available,
      runtimeArgsConfigured: runtimeArgs !== undefined && runtimeArgs !== '',
      runtimeArgsCount,
      externalRuntimeRequired: true,
    },
    provider: {
      profile: redactSecretLike(options.profile, secretValues),
      provider: redactSecretLike(options.provider, secretValues),
      model: redactSecretLike(options.model, secretValues),
      credentialConfigured: credentialConfigured(environment, options),
      readiness: 'not-probed',
    },
    cordis: {
      configured: environment.DSH_MCP_CORDIS_CONFIG?.trim() !== '' && environment.DSH_MCP_CORDIS_CONFIG !== undefined,
      available: cordisAvailable,
    },
    workspace: {
      configured: workspaceValue !== undefined && workspaceValue !== '',
      absolute: workspaceAbsolute,
      available: workspaceAvailable,
    },
    git: {
      available: gitCheck.available,
    },
    maxParallel: {
      configured: launch?.maxParallel ?? validMaxParallel(environment),
      hardLimit: MAX_PARALLEL_HARD_LIMIT,
    },
    sandbox: 'inconclusive',
    warnings,
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    'dsh-sdk-mcp doctor',
    `status: ${report.status}`,
    `package: ${report.packageVersion}`,
    `node: ${report.node.version} (${report.node.platform}/${report.node.arch})`,
    `mcp: @modelcontextprotocol/sdk ${report.mcp.sdkVersion ?? 'unavailable'} / ${report.mcp.protocolRevision} / ${report.mcp.transport}`,
    `dsh: client=${report.dsh.clientVersion ?? 'unavailable'} protocol=${report.dsh.protocolVersion ?? 'unavailable'} runtime=${report.dsh.runtimePackageVersion ?? 'external-or-uninstalled'}`,
    `runtime command: configured=${report.dsh.runtimeCommandConfigured} available=${report.dsh.runtimeCommandAvailable} args=${report.dsh.runtimeArgsCount}`,
    `provider: ${report.provider.provider}/${report.provider.model} credentialConfigured=${report.provider.credentialConfigured}`,
    `cordis: configured=${report.cordis.configured} available=${report.cordis.available}`,
    `workspace: configured=${report.workspace.configured} absolute=${report.workspace.absolute} available=${report.workspace.available}`,
    `git: available=${report.git.available}`,
    `maxParallel: ${report.maxParallel.configured}/${report.maxParallel.hardLimit}`,
    `sandbox: ${report.sandbox}`,
  ]
  if (report.warnings.length > 0) {
    lines.push('warnings:')
    for (const warning of report.warnings) lines.push(`- ${warning}`)
  }
  return `${lines.join('\n')}\n`
}

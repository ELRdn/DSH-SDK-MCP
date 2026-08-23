import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export interface RuntimeLaunchConfig {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export type RuntimeConfigErrorCode =
  | 'RUNTIME_NOT_CONFIGURED'
  | 'INVALID_RUNTIME_ARGS'
  | 'INVALID_RUNTIME_ENV'
  | 'RUNTIME_CONFIG_NOT_FOUND'
  | 'INVALID_PROVIDER_PROFILE'

export class RuntimeConfigError extends Error {
  readonly code: RuntimeConfigErrorCode

  constructor(code: RuntimeConfigErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RuntimeConfigError'
    this.code = code
  }
}

function parseStringArray(raw: string | undefined, variableName: string): string[] {
  if (raw === undefined || raw.trim() === '') return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new RuntimeConfigError(
      'INVALID_RUNTIME_ARGS',
      `${variableName} must be a JSON array of strings`,
      { cause: error },
    )
  }

  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new RuntimeConfigError(
      'INVALID_RUNTIME_ARGS',
      `${variableName} must be a JSON array of strings`,
    )
  }

  return parsed
}

function parseEnvironmentOverrides(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new RuntimeConfigError(
      'INVALID_RUNTIME_ENV',
      'DSH_MCP_RUNTIME_ENV_JSON must be a JSON object of string values',
      { cause: error },
    )
  }

  if (
    parsed === null
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || !Object.values(parsed).every((value) => typeof value === 'string')
  ) {
    throw new RuntimeConfigError(
      'INVALID_RUNTIME_ENV',
      'DSH_MCP_RUNTIME_ENV_JSON must be a JSON object of string values',
    )
  }

  return parsed as Record<string, string>
}

function resolveOptionalPath(raw: string | undefined, baseDirectory: string): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  return isAbsolute(raw) ? resolve(raw) : resolve(baseDirectory, raw)
}

/**
 * Load the explicit child-process launch contract used by the TypeScript SDK.
 *
 * When no override is needed, `env` stays undefined so the SDK inherits the
 * parent environment verbatim. Any override creates a complete merged copy,
 * preserving PATH and all other inherited variables.
 */
export function loadRuntimeLaunchConfig(
  environment: NodeJS.ProcessEnv = process.env,
  baseDirectory = process.cwd(),
): RuntimeLaunchConfig {
  const command = environment.DSH_MCP_RUNTIME_COMMAND?.trim()
  if (!command) {
    throw new RuntimeConfigError(
      'RUNTIME_NOT_CONFIGURED',
      'DSH_MCP_RUNTIME_COMMAND is required for the Phase 0 smoke test',
    )
  }

  const args = parseStringArray(environment.DSH_MCP_RUNTIME_ARGS, 'DSH_MCP_RUNTIME_ARGS')
  const cwd = resolveOptionalPath(environment.DSH_MCP_RUNTIME_CWD, baseDirectory)
  const cordisConfig = resolveOptionalPath(environment.DSH_MCP_CORDIS_CONFIG, baseDirectory)
  const overrides = parseEnvironmentOverrides(environment.DSH_MCP_RUNTIME_ENV_JSON)

  if (cordisConfig !== undefined && !existsSync(cordisConfig)) {
    throw new RuntimeConfigError(
      'RUNTIME_CONFIG_NOT_FOUND',
      `DSH_MCP_CORDIS_CONFIG does not exist: ${cordisConfig}`,
    )
  }

  const childOverrides: Record<string, string> = { ...overrides }
  if (cordisConfig !== undefined) childOverrides.DSH_CORDIS_CONFIG = cordisConfig

  const selectedProvider = environment.DSH_MCP_PROFILE?.trim()
    || environment.DSH_MCP_PROVIDER?.trim()
  if (selectedProvider === 'opencode-go'
    && environment.OPENCODE_API_KEY === undefined
    && environment.OPENCODE_GO_API_KEY !== undefined) {
    childOverrides.OPENCODE_API_KEY = environment.OPENCODE_GO_API_KEY
  }

  const env = Object.keys(childOverrides).length > 0
    ? { ...environment, ...childOverrides }
    : undefined

  return { command, args, cwd, env }
}

export type Phase0ProviderProfile = 'deepseek-official' | 'opencode-go'



const PHASE0_PROVIDER_PROFILES: Record<Phase0ProviderProfile, {
  provider: string
  model: string
  credentialRef: string
  cordisConfigFile: string
}> = {
  'deepseek-official': {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    credentialRef: 'DEEPSEEK_API_KEY',
    cordisConfigFile: 'phase0.cordis.yml',
  },
  'opencode-go': {
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    credentialRef: 'OPENCODE_API_KEY',
    cordisConfigFile: 'phase0.opencode-go.cordis.yml',
  },
}

export interface Phase0Options {
  profile: Phase0ProviderProfile
  provider: string
  model: string
  credentialRef: string
  cordisConfig: string
  maxTokens?: number
  requireWindows: boolean
  runtimePackage: string
  sandboxCordisConfig: string
}

function parsePositiveInteger(raw: string | undefined, variableName: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeConfigError(
      'INVALID_RUNTIME_ENV',
      `${variableName} must be a positive safe integer`,
    )
  }
  return value
}

export function loadPhase0Options(
  environment: NodeJS.ProcessEnv = process.env,
  baseDirectory = process.cwd(),
): Phase0Options {
  const requestedProfile = environment.DSH_MCP_PROFILE?.trim()
  const requestedProvider = environment.DSH_MCP_PROVIDER?.trim()
  const inferredProfile = requestedProvider === 'opencode-go'
    ? 'opencode-go'
    : 'deepseek-official'
  const profileName = requestedProfile ?? inferredProfile
  if (!(profileName in PHASE0_PROVIDER_PROFILES)) {
    throw new RuntimeConfigError(
      'INVALID_PROVIDER_PROFILE',
      'DSH_MCP_PROFILE must be one of: ' + Object.keys(PHASE0_PROVIDER_PROFILES).join(', '),
    )
  }

  const profile = PHASE0_PROVIDER_PROFILES[profileName as Phase0ProviderProfile]
  if (requestedProfile !== undefined
    && requestedProvider !== undefined
    && requestedProvider !== profile.provider) {
    throw new RuntimeConfigError(
      'INVALID_PROVIDER_PROFILE',
      'DSH_MCP_PROFILE ' + requestedProfile + ' does not match DSH_MCP_PROVIDER ' + requestedProvider,
    )
  }
  if (requestedProfile === undefined
    && requestedProvider !== undefined
    && requestedProvider !== profile.provider) {
    throw new RuntimeConfigError(
      'INVALID_PROVIDER_PROFILE',
      'DSH_MCP_PROVIDER ' + requestedProvider + ' requires an explicit compatible Phase 0 profile',
    )
  }

  const sandboxCordisConfig = resolveOptionalPath(
    environment.DSH_MCP_SANDBOX_CORDIS_CONFIG,
    baseDirectory,
  ) ?? resolve(baseDirectory, 'runtime', profile.cordisConfigFile)

  return {
    profile: profileName as Phase0ProviderProfile,
    provider: requestedProvider || profile.provider,
    model: environment.DSH_MCP_MODEL?.trim() || profile.model,
    credentialRef: environment.DSH_MCP_CREDENTIAL_REF?.trim() || profile.credentialRef,
    cordisConfig: resolveOptionalPath(
      environment.DSH_MCP_CORDIS_CONFIG,
      baseDirectory,
    ) ?? resolve(baseDirectory, 'runtime', profile.cordisConfigFile),
    maxTokens: parsePositiveInteger(environment.DSH_MCP_MAX_TOKENS, 'DSH_MCP_MAX_TOKENS'),
    requireWindows: environment.DSH_MCP_REQUIRE_WINDOWS !== '0',
    runtimePackage: environment.DSH_MCP_RUNTIME_PACKAGE?.trim()
      || '@deepseek-ai/dsh-sdk-jsonrpc-demo',
    sandboxCordisConfig,
  }
}

export function redactSecretLike(value: string): string {
  let redacted = value.replace(
    /(\b(?:api[_-]?key|token|secret|password|authorization)\b\s*["']?\s*[:=]\s*["']?)[^\s,;}\]"']+/gi,
    '$1[REDACTED]',
  )
  redacted = redacted.replace(/\b(?:sk|sess|token)-[A-Za-z0-9._-]+\b/gi, '[REDACTED]')
  redacted = redacted.replace(/(\bBearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
  return redacted
}

export function redactArgs(args: readonly string[]): string[] {
  return args.map(redactSecretLike)
}

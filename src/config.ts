import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FishDrawsError } from './errors.js'

export type ApprovalSource = 'bundled' | 'calibrated' | 'user_override'

export interface SafetyProfileConfig {
  maxSampleWidth?: number
  maxSampleHeight?: number
  maxSamplePixels?: number
  reserveMiB?: number
  approvalSource?: ApprovalSource
}

export interface ModelProfileConfig {
  schemaVersion: 1
  id: string
  name: string
  files: { unetName: string; clipName: string; vaeName: string }
  workflowCompatibility: { workflowVersion: string; workflowSha256?: string }
  safety: {
    t2iBalanced: SafetyProfileConfig
    editSingleBalanced: SafetyProfileConfig
    editMultiBalanced: SafetyProfileConfig
    fastBatch: SafetyProfileConfig
  }
  notes?: string
  validation?: {
    status: 'unverified' | 'verified' | 'failed'
    profileHash: string
    workflowHash: string
    checkedAtUtc: string
    diagnosticRunId?: string
  }
}

export interface DiagnosticModelRouteConfig {
  provider: string
  model: string
  reasoningEffort?: string
  userConfirmedLocal: true
  status: 'unverified' | 'verified' | 'unavailable'
  lastVerifiedAtUtc?: string
}

export interface ConfigValues {
  configSchemaVersion?: number
  comfy?: { root?: string; pythonPath?: string; apiUrl?: string; autoStart?: boolean; idleShutdownMs?: number; startupTimeoutMs?: number }
  storage?: { outputRoot?: string; retainAllSuccessfulCandidates?: boolean; runtimeLogMaxBytes?: number; runtimeLogMaxFiles?: number }
  /** v3.0 compatibility mirror of the current model profile. */
  models?: { unetName?: string; clipName?: string; vaeName?: string }
  modelProfiles?: ModelProfileConfig[]
  currentModelProfileId?: string
  strata?: { vramEndpoint?: string; credentialRef?: string; reserveMiB?: number; handoffEnabled?: boolean; authMode?: 'none' | 'bearer' }
  promptExpansion?: { mode?: 'current-agent'; endpoint?: string }
  runtime?: { timeoutPerImageSec?: number }
  /** v3.0 compatibility mirror of the current model profile safety values. */
  safety?: { t2iBalanced?: SafetyProfileConfig; editSingleBalanced?: SafetyProfileConfig; editMultiBalanced?: SafetyProfileConfig; fastBatch?: SafetyProfileConfig }
  diagnostics?: { localModelRoutes?: DiagnosticModelRouteConfig[]; lastRunId?: string }
  migration?: { legacyMirrorHash?: string }
}

/** Loader-facing configuration: every settings-owned top-level value is a live reference. */
export interface RuntimeConfig {
  configSchemaVersion: Volatile<number>
  comfy: Volatile<NonNullable<ConfigValues['comfy']>>
  storage: Volatile<NonNullable<ConfigValues['storage']>>
  models: Volatile<NonNullable<ConfigValues['models']>>
  modelProfiles: Volatile<ModelProfileConfig[]>
  currentModelProfileId: Volatile<string>
  strata: Volatile<NonNullable<ConfigValues['strata']>>
  promptExpansion: Volatile<NonNullable<ConfigValues['promptExpansion']>>
  runtime: Volatile<NonNullable<ConfigValues['runtime']>>
  safety: Volatile<NonNullable<ConfigValues['safety']>>
  diagnostics: Volatile<NonNullable<ConfigValues['diagnostics']>>
  migration: Volatile<NonNullable<ConfigValues['migration']>>
}

const safetyProfile = z.object({
  maxSampleWidth: z.natural().min(1).default(2048),
  maxSampleHeight: z.natural().min(1).default(2048),
  maxSamplePixels: z.natural().min(1).default(2_400_000),
  reserveMiB: z.natural().min(1024).max(30_000).default(21_504),
  approvalSource: z.union(['bundled', 'calibrated', 'user_override'] as const).default('bundled'),
})

const modelProfile = z.object({
  schemaVersion: z.const(1).default(1),
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  files: z.object({ unetName: z.string().min(1).max(260), clipName: z.string().min(1).max(260), vaeName: z.string().min(1).max(260) }),
  workflowCompatibility: z.object({ workflowVersion: z.string().min(1).max(80), workflowSha256: z.string().max(64) }),
  safety: z.object({
    t2iBalanced: safetyProfile.default({}),
    editSingleBalanced: safetyProfile.default({}),
    editMultiBalanced: safetyProfile.default({}),
    fastBatch: safetyProfile.default({}),
  }),
  notes: z.string().max(2000),
  validation: z.object({
    status: z.union(['unverified', 'verified', 'failed'] as const),
    profileHash: z.string().min(64).max(64),
    workflowHash: z.string().min(64).max(64),
    checkedAtUtc: z.string().min(1).max(64),
    diagnosticRunId: z.string().max(80),
  }),
})

const diagnosticRoute = z.object({
  provider: z.string().min(1).max(120),
  model: z.string().min(1).max(240),
  reasoningEffort: z.string().max(80),
  userConfirmedLocal: z.const(true),
  status: z.union(['unverified', 'verified', 'unavailable'] as const).default('unverified'),
  lastVerifiedAtUtc: z.string().max(64),
})

const baseConfig = z.object({
  configSchemaVersion: z.natural().min(1).default(2).volatile(),
  comfy: z.object({
    root: z.string().default(''), pythonPath: z.string().default(''), apiUrl: z.string().default('http://127.0.0.1:8188'),
    autoStart: z.boolean().default(true), idleShutdownMs: z.natural().min(60_000).max(86_400_000).default(600_000),
    startupTimeoutMs: z.natural().min(10_000).max(600_000).default(180_000),
  }).default({}).volatile(),
  storage: z.object({
    outputRoot: z.string().default(''), retainAllSuccessfulCandidates: z.boolean().default(false),
    runtimeLogMaxBytes: z.natural().min(65_536).max(104_857_600).default(5_242_880), runtimeLogMaxFiles: z.natural().min(1).max(50).default(5),
  }).default({}).volatile(),
  models: z.object({
    unetName: z.string().default('qwen-image-2.1-UC-Q8_0_2.gguf'), clipName: z.string().default('qwen3vl_8b_int8_convrot.safetensors'),
    vaeName: z.string().default('qwen_image_2.1_vae_bf16.safetensors'),
  }).default({}).volatile(),
  modelProfiles: z.array(modelProfile).default([]).volatile(),
  currentModelProfileId: z.string().default('').volatile(),
  strata: z.object({
    vramEndpoint: z.string().default(''), credentialRef: z.string().default('FISH_DRAWS_STRATA_API_KEY'),
    reserveMiB: z.natural().min(1024).max(30_000).default(21_504).deprecated(), handoffEnabled: z.boolean().default(true),
    authMode: z.union(['none', 'bearer'] as const).default('bearer'),
  }).default({}).volatile(),
  promptExpansion: z.object({ mode: z.const('current-agent').default('current-agent'), endpoint: z.string().default('').deprecated().hidden() }).default({}).volatile(),
  runtime: z.object({ timeoutPerImageSec: z.natural().min(60).max(3600).default(900) }).default({}).volatile(),
  safety: z.object({
    t2iBalanced: safetyProfile.default({}), editSingleBalanced: safetyProfile.default({}),
    editMultiBalanced: safetyProfile.default({}), fastBatch: safetyProfile.default({}),
  }).default({}).volatile(),
  diagnostics: z.object({ localModelRoutes: z.array(diagnosticRoute).default([]), lastRunId: z.string().max(80) }).default({}).volatile(),
  migration: z.object({ legacyMirrorHash: z.string().max(64) }).default({}).volatile(),
})

export const Config = z.transform(baseConfig, (value) => { resolveConfig(value as unknown as RuntimeConfig); return value }) as unknown as z<ConfigValues, RuntimeConfig>

export interface ResolvedSafetyProfile {
  maxSampleWidth: number
  maxSampleHeight: number
  maxSamplePixels: number
  reserveMiB: number
  approvalSource: ApprovalSource
}

export interface ResolvedModelProfile extends Omit<ModelProfileConfig, 'safety'> {
  safety: Record<'t2i-balanced' | 'edit-single-balanced' | 'edit-multi-balanced' | 'fast-batch', ResolvedSafetyProfile>
  profileHash: string
}

export interface ResolvedConfig {
  configSchemaVersion: number
  comfy: { root: string; pythonPath: string; apiUrl: URL; autoStart: boolean; idleShutdownMs: number; startupTimeoutMs: number }
  storage: { outputRoot: string; retainAllSuccessfulCandidates: boolean; runtimeLogMaxBytes: number; runtimeLogMaxFiles: number }
  /** Compatibility view of currentModelProfile.files used by the fixed workflow compiler. */
  models: { unetName: string; clipName: string; vaeName: string }
  modelProfiles: ResolvedModelProfile[]
  currentModelProfileId: string
  currentModelProfile: ResolvedModelProfile
  strata: { vramEndpoint?: URL; credentialRef: string; handoffEnabled: boolean; authMode: 'none' | 'bearer'; deprecatedReserveMiB: number }
  promptExpansion: { mode: 'current-agent'; deprecatedEndpoint?: URL }
  runtime: { timeoutPerImageSec: number }
  safety: Record<'t2i-balanced' | 'edit-single-balanced' | 'edit-multi-balanced' | 'fast-batch', ResolvedSafetyProfile>
  diagnostics: { localModelRoutes: DiagnosticModelRouteConfig[]; lastRunId?: string }
  migrationRequired: boolean
  legacyMirrorHash: string
  legacyMirror: { models: NonNullable<ConfigValues['models']>; safety: NonNullable<ConfigValues['safety']> }
  rollbackMirrorChanged: boolean
}

function read<T>(value: T | Volatile<T> | undefined, fallback: T): T {
  if (value !== undefined && value !== null && typeof value === 'object' && 'get' in value && typeof value.get === 'function') return value.get() as T
  return value === undefined ? fallback : value as T
}

function loopbackUrl(value: string, field: string, allowEmpty = false): URL | undefined {
  if (value.trim() === '' && allowEmpty) return undefined
  let url: URL
  try { url = new URL(value) } catch { throw new FishDrawsError(`${field} must be a valid URL`, 'INVALID_URL', 'preflight') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FishDrawsError(`${field} must use http or https`, 'INVALID_URL_SCHEME', 'preflight')
  const host = url.hostname.toLowerCase()
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) throw new FishDrawsError(`${field} must target loopback in public v1`, 'NON_LOOPBACK_URL', 'preflight')
  return url
}

function resolvedProfile(input: SafetyProfileConfig | undefined): ResolvedSafetyProfile {
  return {
    maxSampleWidth: input?.maxSampleWidth ?? 2048, maxSampleHeight: input?.maxSampleHeight ?? 2048,
    maxSamplePixels: input?.maxSamplePixels ?? 2_400_000, reserveMiB: input?.reserveMiB ?? 21_504,
    approvalSource: input?.approvalSource ?? 'bundled',
  }
}

function assertModelFileName(value: string, field: string): void {
  const normalized = value.replaceAll('\\', '/')
  if (value.trim() === '' || value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:/u.test(value) || normalized.split('/').some(part => part === '..')) {
    throw new FishDrawsError(`${field} must be a relative ComfyUI loader filename without traversal`, 'INVALID_MODEL_FILENAME', 'preflight')
  }
}

export function modelProfileHash(profile: Omit<ModelProfileConfig, 'validation'> | ModelProfileConfig): string {
  const { validation: _validation, ...stable } = profile as ModelProfileConfig
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

function resolveModelProfile(profile: ModelProfileConfig): ResolvedModelProfile {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(profile.id)) throw new FishDrawsError('model profile id is invalid', 'INVALID_MODEL_PROFILE', 'preflight')
  if (profile.name.trim() === '') throw new FishDrawsError('model profile name must not be empty', 'INVALID_MODEL_PROFILE', 'preflight')
  assertModelFileName(profile.files.unetName, 'unetName'); assertModelFileName(profile.files.clipName, 'clipName'); assertModelFileName(profile.files.vaeName, 'vaeName')
  return {
    ...profile,
    safety: {
      't2i-balanced': resolvedProfile(profile.safety.t2iBalanced), 'edit-single-balanced': resolvedProfile(profile.safety.editSingleBalanced),
      'edit-multi-balanced': resolvedProfile(profile.safety.editMultiBalanced), 'fast-batch': resolvedProfile(profile.safety.fastBatch),
    },
    profileHash: modelProfileHash(profile),
  }
}

export function legacyModelProfile(models: NonNullable<ConfigValues['models']>, safety: NonNullable<ConfigValues['safety']>): ModelProfileConfig {
  return {
    schemaVersion: 1, id: 'legacy-v3-profile', name: '原有配置',
    files: {
      unetName: models.unetName ?? 'qwen-image-2.1-UC-Q8_0_2.gguf', clipName: models.clipName ?? 'qwen3vl_8b_int8_convrot.safetensors',
      vaeName: models.vaeName ?? 'qwen_image_2.1_vae_bf16.safetensors',
    },
    workflowCompatibility: { workflowVersion: 'qwen-image-2.1-unified-v3' },
    safety: { t2iBalanced: safety.t2iBalanced ?? {}, editSingleBalanced: safety.editSingleBalanced ?? {}, editMultiBalanced: safety.editMultiBalanced ?? {}, fastBatch: safety.fastBatch ?? {} },
    notes: 'Migrated from fish-draws 3.0.0.',
  }
}

export function resolveConfig(input: ConfigValues | RuntimeConfig = {}): ResolvedConfig {
  const comfy = read<NonNullable<ConfigValues['comfy']>>(input.comfy, {}); const storage = read<NonNullable<ConfigValues['storage']>>(input.storage, {}); const legacyModels = read<NonNullable<ConfigValues['models']>>(input.models, {})
  const legacySafety = read<NonNullable<ConfigValues['safety']>>(input.safety, {}); const strata = read<NonNullable<ConfigValues['strata']>>(input.strata, {}); const promptExpansion = read<NonNullable<ConfigValues['promptExpansion']>>(input.promptExpansion, {})
  const runtime = read<NonNullable<ConfigValues['runtime']>>(input.runtime, {}); const diagnostics = read<NonNullable<ConfigValues['diagnostics']>>(input.diagnostics, {}); const migration = read<NonNullable<ConfigValues['migration']>>(input.migration, {}); const suppliedProfiles = read<ModelProfileConfig[]>(input.modelProfiles, [])
  const legacyMirrorHash = hashLegacyMirror(legacyModels, legacySafety)
  const migrationRequired = suppliedProfiles.length === 0
  const profiles = (migrationRequired ? [legacyModelProfile(legacyModels, legacySafety)] : suppliedProfiles).map(resolveModelProfile)
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new FishDrawsError('model profile ids must be unique', 'DUPLICATE_MODEL_PROFILE', 'preflight')
  const requestedCurrent = read(input.currentModelProfileId, '')
  const currentModelProfileId = requestedCurrent === '' && migrationRequired ? profiles[0]!.id : requestedCurrent
  const currentModelProfile = profiles.find(profile => profile.id === currentModelProfileId)
  if (currentModelProfile === undefined) throw new FishDrawsError('current model profile does not exist', 'CURRENT_MODEL_PROFILE_MISSING', 'preflight')
  const routes = diagnostics.localModelRoutes ?? []
  const routeKeys = routes.map(route => `${route.provider}\0${route.model}\0${route.reasoningEffort ?? ''}`)
  if (new Set(routeKeys).size !== routeKeys.length) throw new FishDrawsError('diagnostic model routes must be unique', 'DUPLICATE_DIAGNOSTIC_ROUTE', 'preflight')
  const comfyRoot = comfy.root?.trim() === '' || comfy.root === undefined ? '' : resolve(comfy.root)
  const outputRootValue = storage.outputRoot?.trim() ?? ''
  const outputRoot = outputRootValue !== '' ? resolve(outputRootValue) : comfyRoot === '' ? '' : resolve(comfyRoot, 'output')
  const comfyUrl = loopbackUrl(comfy.apiUrl ?? 'http://127.0.0.1:8188', 'comfy.apiUrl')
  const strataUrl = loopbackUrl(strata.vramEndpoint ?? '', 'strata.vramEndpoint', true)
  const deprecatedPromptEndpoint = loopbackUrl(promptExpansion.endpoint ?? '', 'promptExpansion.endpoint', true)
  if (comfyUrl === undefined) throw new Error('unreachable')
  const authMode = strata.authMode ?? 'bearer'; const credentialRef = strata.credentialRef ?? 'FISH_DRAWS_STRATA_API_KEY'
  if (authMode === 'bearer' && credentialRef.trim() === '') throw new FishDrawsError('strata.credentialRef is required for bearer authentication', 'STRATA_CREDENTIAL_REF_REQUIRED', 'preflight')
  return {
    configSchemaVersion: read(input.configSchemaVersion, 2),
    comfy: {
      root: comfyRoot, pythonPath: comfy.pythonPath?.trim() === '' || comfy.pythonPath === undefined ? '' : resolve(comfy.pythonPath), apiUrl: comfyUrl,
      autoStart: comfy.autoStart ?? true, idleShutdownMs: comfy.idleShutdownMs ?? 600_000, startupTimeoutMs: comfy.startupTimeoutMs ?? 180_000,
    },
    storage: {
      outputRoot, retainAllSuccessfulCandidates: storage.retainAllSuccessfulCandidates ?? false,
      runtimeLogMaxBytes: storage.runtimeLogMaxBytes ?? 5_242_880, runtimeLogMaxFiles: storage.runtimeLogMaxFiles ?? 5,
    },
    models: { ...currentModelProfile.files }, modelProfiles: profiles, currentModelProfileId, currentModelProfile,
    strata: {
      ...(strataUrl === undefined ? {} : { vramEndpoint: strataUrl }), credentialRef, handoffEnabled: strata.handoffEnabled ?? true,
      authMode, deprecatedReserveMiB: strata.reserveMiB ?? 21_504,
    },
    promptExpansion: { mode: 'current-agent', ...(deprecatedPromptEndpoint === undefined ? {} : { deprecatedEndpoint: deprecatedPromptEndpoint }) },
    runtime: { timeoutPerImageSec: runtime.timeoutPerImageSec ?? 900 }, safety: currentModelProfile.safety,
    diagnostics: { localModelRoutes: routes.map(route => ({ ...route })), ...(diagnostics.lastRunId === undefined ? {} : { lastRunId: diagnostics.lastRunId }) },
    migrationRequired, legacyMirrorHash, legacyMirror: { models: structuredClone(legacyModels), safety: structuredClone(legacySafety) }, rollbackMirrorChanged: !migrationRequired && migration.legacyMirrorHash !== undefined && migration.legacyMirrorHash !== legacyMirrorHash,
  }
}

export function hashLegacyMirror(models: NonNullable<ConfigValues['models']>, safety: NonNullable<ConfigValues['safety']>): string {
  return createHash('sha256').update(JSON.stringify({ models, safety })).digest('hex')
}

export function currentProfileCompatibilityValues(config: ResolvedConfig): Pick<ConfigValues, 'models' | 'safety'> {
  const safety = config.currentModelProfile.safety
  return {
    models: { ...config.currentModelProfile.files },
    safety: {
      t2iBalanced: { ...safety['t2i-balanced'] }, editSingleBalanced: { ...safety['edit-single-balanced'] },
      editMultiBalanced: { ...safety['edit-multi-balanced'] }, fastBatch: { ...safety['fast-batch'] },
    },
  }
}

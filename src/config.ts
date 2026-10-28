import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { FishDrawsError } from './errors.js'

export interface SafetyProfileConfig {
  maxSampleWidth?: number
  maxSampleHeight?: number
  maxSamplePixels?: number
  reserveMiB?: number
  approvalSource?: 'bundled' | 'calibrated' | 'user_override'
}

export interface Config {
  comfy?: {
    root?: string
    pythonPath?: string
    apiUrl?: string
    autoStart?: boolean
    idleShutdownMs?: number
    startupTimeoutMs?: number
  }
  storage?: {
    outputRoot?: string
    retainAllSuccessfulCandidates?: boolean
    runtimeLogMaxBytes?: number
    runtimeLogMaxFiles?: number
  }
  models?: {
    unetName?: string
    clipName?: string
    vaeName?: string
  }
  strata?: {
    vramEndpoint?: string
    credentialRef?: string
    reserveMiB?: number
    handoffEnabled?: boolean
  }
  promptExpansion?: {
    mode?: 'current-agent'
    endpoint?: string
  }
  runtime?: {
    timeoutPerImageSec?: number
  }
  safety?: {
    t2iBalanced?: SafetyProfileConfig
    editSingleBalanced?: SafetyProfileConfig
    editMultiBalanced?: SafetyProfileConfig
    fastBatch?: SafetyProfileConfig
  }
}

const safetyProfile = z.object({
  maxSampleWidth: z.natural().min(1).default(2048),
  maxSampleHeight: z.natural().min(1).default(2048),
  maxSamplePixels: z.natural().min(1).default(2_400_000),
  reserveMiB: z.natural().min(1024).max(30_000).default(21_504),
  approvalSource: z.union(['bundled', 'calibrated', 'user_override'] as const).default('bundled'),
})

export const Config: z<Config> = z.object({
  comfy: z.object({
    root: z.string().default(''),
    pythonPath: z.string().default(''),
    apiUrl: z.string().default('http://127.0.0.1:8188'),
    autoStart: z.boolean().default(true),
    idleShutdownMs: z.natural().min(60_000).max(86_400_000).default(600_000),
    startupTimeoutMs: z.natural().min(10_000).max(600_000).default(180_000),
  }).default({}),
  storage: z.object({
    outputRoot: z.string().default(''),
    retainAllSuccessfulCandidates: z.boolean().default(false),
    runtimeLogMaxBytes: z.natural().min(65_536).max(104_857_600).default(5_242_880),
    runtimeLogMaxFiles: z.natural().min(1).max(50).default(5),
  }).default({}),
  models: z.object({
    unetName: z.string().default('qwen-image-2.1-UC-Q8_0_2.gguf'),
    clipName: z.string().default('qwen3vl_8b_int8_convrot.safetensors'),
    vaeName: z.string().default('qwen_image_2.1_vae_bf16.safetensors'),
  }).default({}),
  strata: z.object({
    vramEndpoint: z.string().default(''),
    credentialRef: z.string().default('FISH_DRAWS_STRATA_API_KEY'),
    reserveMiB: z.natural().min(1024).max(30_000).default(21_504),
    handoffEnabled: z.boolean().default(true),
  }).default({}),
  promptExpansion: z.object({
    mode: z.const('current-agent').default('current-agent'),
    endpoint: z.string().default(''),
  }).default({}),
  runtime: z.object({
    timeoutPerImageSec: z.natural().min(60).max(3600).default(900),
  }).default({}),
  safety: z.object({
    t2iBalanced: safetyProfile.default({}),
    editSingleBalanced: safetyProfile.default({}),
    editMultiBalanced: safetyProfile.default({}),
    fastBatch: safetyProfile.default({}),
  }).default({}),
})

export interface ResolvedSafetyProfile {
  maxSampleWidth: number
  maxSampleHeight: number
  maxSamplePixels: number
  reserveMiB: number
  approvalSource: 'bundled' | 'calibrated' | 'user_override'
}

export interface ResolvedConfig {
  comfy: {
    root: string
    pythonPath: string
    apiUrl: URL
    autoStart: boolean
    idleShutdownMs: number
    startupTimeoutMs: number
  }
  storage: {
    outputRoot: string
    retainAllSuccessfulCandidates: boolean
    runtimeLogMaxBytes: number
    runtimeLogMaxFiles: number
  }
  models: { unetName: string; clipName: string; vaeName: string }
  strata: {
    vramEndpoint?: URL
    credentialRef: string
    reserveMiB: number
    handoffEnabled: boolean
  }
  promptExpansion: { mode: 'current-agent'; endpoint?: URL }
  runtime: { timeoutPerImageSec: number }
  safety: Record<'t2i-balanced' | 'edit-single-balanced' | 'edit-multi-balanced' | 'fast-batch', ResolvedSafetyProfile>
}

function loopbackUrl(value: string, field: string, allowEmpty = false): URL | undefined {
  if (value.trim() === '' && allowEmpty) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new FishDrawsError(`${field} must be a valid URL`, 'INVALID_URL', 'preflight')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FishDrawsError(`${field} must use http or https`, 'INVALID_URL_SCHEME', 'preflight')
  }
  const host = url.hostname.toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') {
    throw new FishDrawsError(`${field} must target loopback in public v1`, 'NON_LOOPBACK_URL', 'preflight')
  }
  return url
}

function resolvedProfile(input: SafetyProfileConfig | undefined): ResolvedSafetyProfile {
  return {
    maxSampleWidth: input?.maxSampleWidth ?? 2048,
    maxSampleHeight: input?.maxSampleHeight ?? 2048,
    maxSamplePixels: input?.maxSamplePixels ?? 2_400_000,
    reserveMiB: input?.reserveMiB ?? 21_504,
    approvalSource: input?.approvalSource ?? 'bundled',
  }
}

export function resolveConfig(input: Config = {}): ResolvedConfig {
  const comfyRoot = input.comfy?.root?.trim() === '' || input.comfy?.root === undefined
    ? ''
    : resolve(input.comfy.root)
  const outputRootValue = input.storage?.outputRoot?.trim() ?? ''
  const outputRoot = outputRootValue !== ''
    ? resolve(outputRootValue)
    : comfyRoot === '' ? '' : resolve(comfyRoot, 'output')
  const comfyUrl = loopbackUrl(input.comfy?.apiUrl ?? 'http://127.0.0.1:8188', 'comfy.apiUrl')
  const strataUrl = loopbackUrl(input.strata?.vramEndpoint ?? '', 'strata.vramEndpoint', true)
  const promptEndpoint = loopbackUrl(input.promptExpansion?.endpoint ?? '', 'promptExpansion.endpoint', true)
  if (comfyUrl === undefined) throw new Error('unreachable')
  return {
    comfy: {
      root: comfyRoot,
      pythonPath: input.comfy?.pythonPath?.trim() === '' || input.comfy?.pythonPath === undefined
        ? ''
        : resolve(input.comfy.pythonPath),
      apiUrl: comfyUrl,
      autoStart: input.comfy?.autoStart ?? true,
      idleShutdownMs: input.comfy?.idleShutdownMs ?? 600_000,
      startupTimeoutMs: input.comfy?.startupTimeoutMs ?? 180_000,
    },
    storage: {
      outputRoot,
      retainAllSuccessfulCandidates: input.storage?.retainAllSuccessfulCandidates ?? false,
      runtimeLogMaxBytes: input.storage?.runtimeLogMaxBytes ?? 5_242_880,
      runtimeLogMaxFiles: input.storage?.runtimeLogMaxFiles ?? 5,
    },
    models: {
      unetName: input.models?.unetName ?? 'qwen-image-2.1-UC-Q8_0_2.gguf',
      clipName: input.models?.clipName ?? 'qwen3vl_8b_int8_convrot.safetensors',
      vaeName: input.models?.vaeName ?? 'qwen_image_2.1_vae_bf16.safetensors',
    },
    strata: {
      ...(strataUrl === undefined ? {} : { vramEndpoint: strataUrl }),
      credentialRef: input.strata?.credentialRef ?? 'FISH_DRAWS_STRATA_API_KEY',
      reserveMiB: input.strata?.reserveMiB ?? 21_504,
      handoffEnabled: input.strata?.handoffEnabled ?? true,
    },
    promptExpansion: {
      mode: 'current-agent',
      ...(promptEndpoint === undefined ? {} : { endpoint: promptEndpoint }),
    },
    runtime: { timeoutPerImageSec: input.runtime?.timeoutPerImageSec ?? 900 },
    safety: {
      't2i-balanced': resolvedProfile(input.safety?.t2iBalanced),
      'edit-single-balanced': resolvedProfile(input.safety?.editSingleBalanced),
      'edit-multi-balanced': resolvedProfile(input.safety?.editMultiBalanced),
      'fast-batch': resolvedProfile(input.safety?.fastBatch),
    },
  }
}


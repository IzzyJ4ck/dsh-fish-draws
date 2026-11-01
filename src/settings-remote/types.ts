import type { ResultManifest } from '../runtime/result-manifest.js'

export type ComfyOwnership = 'plugin-owned-live-handle' | 'user-or-external' | 'stale-owner-record' | 'offline'

export interface SettingsOverview {
  pluginVersion: string
  currentModelProfileId: string
  currentModelProfileName: string
  currentModelProfileHash: string
  comfyOnline: boolean
  comfyOwnership: ComfyOwnership
  activeTaskId?: string
  diagnosticActive: boolean
  activeDiagnosticRunId?: string
  lastDiagnosticRunId?: string
  strataReleased: boolean
  deprecatedPromptEndpointConfigured: boolean
}

export interface ComfyProbeResult {
  online: boolean
  ownership: ComfyOwnership
  rootValid: boolean
  python: string
  apiUrl: string
  version?: string
  system?: Record<string, unknown>
  error?: string
}

export interface ComfyStopPreparation {
  allowed: boolean
  ownership: ComfyOwnership
  queueRunning: number
  queuePending: number
  nonce?: string
  expiresAtUtc?: string
  blockers: string[]
}

export interface OperationResult {
  ok: boolean
  code?: string
  message?: string
}

export interface ModelCandidates {
  unet: string[]
  clip: string[]
  vae: string[]
}

export interface ModelProfileProbe {
  profileId: string
  status: 'missing' | 'unverified' | 'verified' | 'incompatible'
  missingFiles: string[]
  workflowCompatible: boolean
  profileHash: string
  workflowHash: string
}

export interface StrataProbeResult {
  enabled: boolean
  configured: boolean
  authMode: 'none' | 'bearer'
  online: boolean
  status?: Record<string, unknown>
  error?: string
}

export interface DiagnosticPrepareRequest {
  runId: string
  sessionId: string
  provider: string
  model: string
  reasoningEffort?: string
  profileId: string
}

export interface DiagnosticRunView {
  runId: string
  sessionId: string
  status: 'prepared' | 'running' | 'cancelling' | 'completed' | 'warning' | 'failed' | 'cancelled'
  profileId: string
  profileName: string
  profileHash: string
  route: { provider: string; model: string; reasoningEffort?: string }
  createdAtUtc: string
  updatedAtUtc: string
  taskId?: string
  executionId?: string
  jobId?: string
  expandedPrompt?: string
  imageRelativePath?: string
  canvas?: { targetWidth: number; targetHeight: number; sampleWidth: number; sampleHeight: number; actualWidth?: number; actualHeight?: number }
  stages?: Array<{ name: string; startedAtUtc: string; completedAtUtc?: string; durationMs?: number; detail?: string }>
  lifecycle?: { comfyStartedByPlugin: boolean; comfyModelsUnloaded: boolean; strataRestored: boolean; cleanupComplete: boolean }
  archivedManifest?: ResultManifest
  failureClass?: string
  error?: string
}

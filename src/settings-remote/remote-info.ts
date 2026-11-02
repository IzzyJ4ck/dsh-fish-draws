import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'

const scalar = (schema: z.ZodType, symbol: string) => ({ mode: 'strict' as const, typeSymbol: symbol, create: () => schema })
const request = (schema: z.ZodObject<any>, symbol: string) => ({ name: 'request', source: 'json' as const, codec: scalar(schema, symbol), strictCodec: scalar(schema.strict(), symbol) })
const direct = (parameters: any[] = [], output: z.ZodType = z.unknown(), symbol = 'unknown') => ({ service: 'fishDrawsSettings', invocation: { kind: 'direct' as const }, parameters, result: scalar(output, symbol) })
const runId = z.object({ runId: z.string().min(8).max(80) })
const profileId = z.object({ profileId: z.string().min(1).max(64) })
const operation = z.object({ ok: z.boolean(), code: z.string().optional(), message: z.string().optional() })
const ownership = z.enum(['plugin-owned-live-handle', 'user-or-external', 'stale-owner-record', 'offline'])
const overview = z.object({ pluginVersion: z.string(), currentModelProfileId: z.string(), currentModelProfileName: z.string(), currentModelProfileHash: z.string(), comfyOnline: z.boolean(), comfyOwnership: ownership, activeTaskId: z.string().optional(), diagnosticActive: z.boolean(), activeDiagnosticRunId: z.string().optional(), lastDiagnosticRunId: z.string().optional(), strataReleased: z.boolean(), deprecatedPromptEndpointConfigured: z.boolean() })
const comfyProbe = z.object({ online: z.boolean(), ownership, rootValid: z.boolean(), python: z.string(), apiUrl: z.string(), version: z.string().optional(), system: z.record(z.string(), z.unknown()).optional(), error: z.string().optional() })
const stopPreparation = z.object({ allowed: z.boolean(), ownership, queueRunning: z.number(), queuePending: z.number(), nonce: z.string().optional(), expiresAtUtc: z.string().optional(), blockers: z.array(z.string()) })
const candidates = z.object({ unet: z.array(z.string()), clip: z.array(z.string()), vae: z.array(z.string()) })
const profileProbe = z.object({ profileId: z.string(), status: z.enum(['missing', 'unverified', 'verified', 'incompatible']), missingFiles: z.array(z.string()), workflowCompatible: z.boolean(), profileHash: z.string(), workflowHash: z.string() })
const strataProbe = z.object({ enabled: z.boolean(), configured: z.boolean(), authMode: z.enum(['none', 'bearer']), online: z.boolean(), status: z.record(z.string(), z.unknown()).optional(), error: z.string().optional() })
const diagnosticView = z.object({ runId: z.string(), sessionId: z.string(), status: z.enum(['prepared', 'running', 'cancelling', 'completed', 'warning', 'failed', 'cancelled']), profileId: z.string(), profileName: z.string(), profileHash: z.string(), route: z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() }), createdAtUtc: z.string(), updatedAtUtc: z.string() }).passthrough()

const methods = {
  'fishDrawsSettings/overview': direct([], overview, '@izzyj4ck/dsh-fish-draws/types#SettingsOverview'),
  'fishDrawsSettings/probeComfy': direct([], comfyProbe, '@izzyj4ck/dsh-fish-draws/types#ComfyProbeResult'),
  'fishDrawsSettings/startComfyForTest': direct([], operation, '@izzyj4ck/dsh-fish-draws/types#OperationResult'),
  'fishDrawsSettings/prepareComfyStop': direct([], stopPreparation, '@izzyj4ck/dsh-fish-draws/types#ComfyStopPreparation'),
  'fishDrawsSettings/stopComfy': direct([request(z.object({ nonce: z.string().min(16).max(128) }), '@izzyj4ck/dsh-fish-draws/types#StopComfyRequest')], operation, '@izzyj4ck/dsh-fish-draws/types#OperationResult'),
  'fishDrawsSettings/discoverModelCandidates': direct([], candidates, '@izzyj4ck/dsh-fish-draws/types#ModelCandidates'),
  'fishDrawsSettings/probeModelProfile': direct([request(profileId, '@izzyj4ck/dsh-fish-draws/types#ProfileRequest')], profileProbe, '@izzyj4ck/dsh-fish-draws/types#ModelProfileProbe'),
  'fishDrawsSettings/probeStrata': direct([], strataProbe, '@izzyj4ck/dsh-fish-draws/types#StrataProbeResult'),
  'fishDrawsSettings/readStrataStatus': direct([], strataProbe, '@izzyj4ck/dsh-fish-draws/types#StrataProbeResult'),
  'fishDrawsSettings/diagnose': direct([], z.record(z.string(), z.unknown()), 'Record<string, unknown>'),
  'fishDrawsSettings/diagnosticPrepare': direct([request(z.object({ runId: z.string().min(8).max(80), sessionId: z.string().min(1).max(160), provider: z.string().min(1).max(120), model: z.string().min(1).max(240), reasoningEffort: z.string().max(80).optional(), profileId: z.string().min(1).max(64) }), '@izzyj4ck/dsh-fish-draws/types#DiagnosticPrepareRequest')], diagnosticView, '@izzyj4ck/dsh-fish-draws/types#DiagnosticRunView'),
  'fishDrawsSettings/diagnosticStatus': direct([request(runId, '@izzyj4ck/dsh-fish-draws/types#DiagnosticRunRequest')], diagnosticView, '@izzyj4ck/dsh-fish-draws/types#DiagnosticRunView'),
  'fishDrawsSettings/diagnosticCancel': direct([request(runId, '@izzyj4ck/dsh-fish-draws/types#DiagnosticRunRequest')], diagnosticView, '@izzyj4ck/dsh-fish-draws/types#DiagnosticRunView'),
  'fishDrawsSettings/diagnosticDelete': direct([request(runId, '@izzyj4ck/dsh-fish-draws/types#DiagnosticRunRequest')], operation, '@izzyj4ck/dsh-fish-draws/types#OperationResult'),
}

export const TYPERT_REMOTE = createTypertRemoteInfo({ package: '@izzyj4ck/dsh-fish-draws', methods }, z)

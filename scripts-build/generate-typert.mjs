import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0))
const out = resolve(root, 'lib')
await mkdir(out, { recursive: true })

const shared = `import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'

const scalar = (schema, symbol) => ({ mode: 'strict', typeSymbol: symbol, create: () => schema })
const request = (schema, symbol) => ({ name: 'request', source: 'json', codec: scalar(schema, symbol), strictCodec: scalar(schema.strict(), symbol) })
const direct = (parameters = [], output = z.unknown(), symbol = 'unknown') => ({ service: 'fishDrawsSettings', invocation: { kind: 'direct' }, parameters, result: scalar(output, symbol) })
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
const TYPERT_REMOTE = createTypertRemoteInfo({ package: '@izzyj4ck/dsh-fish-draws', methods }, z)
`

await writeFile(resolve(out, 'typert.host.js'), `${shared}\nexport const TYPERT = { package: '@izzyj4ck/dsh-fish-draws', face: 'host', schemas: [], get invocations() { return TYPERT_REMOTE.descriptors }, model: { services: [{ key: 'fishDrawsSettings', export: { subpath: '.', name: 'FishDrawsSettingsController' } }], events: [], objects: [] } }\n`, 'utf8')
await writeFile(resolve(out, 'typert.host.d.ts'), `export declare const TYPERT: unknown\n`, 'utf8')
await writeFile(resolve(out, 'typert.remote-client.js'), `${shared}\nexport { TYPERT_REMOTE }\nexport default TYPERT_REMOTE\n`, 'utf8')
await writeFile(resolve(out, 'typert.remote-client.d.ts'), `import type { RemoteResult, TypertRemoteInfo, TypertRemoteMethod } from '@deepseek-ai/dsh-typert-protocol'
import type { ComfyProbeResult, ComfyStopPreparation, DiagnosticPrepareRequest, DiagnosticRunView, ModelCandidates, ModelProfileProbe, OperationResult, SettingsOverview, StrataProbeResult } from '@izzyj4ck/dsh-fish-draws/types'
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'fishDrawsSettings/overview': () => Promise<RemoteResult<SettingsOverview>>
    'fishDrawsSettings/probeComfy': () => Promise<RemoteResult<ComfyProbeResult>>
    'fishDrawsSettings/startComfyForTest': () => Promise<RemoteResult<OperationResult>>
    'fishDrawsSettings/prepareComfyStop': () => Promise<RemoteResult<ComfyStopPreparation>>
    'fishDrawsSettings/stopComfy': (request: { nonce: string }) => Promise<RemoteResult<OperationResult>>
    'fishDrawsSettings/discoverModelCandidates': () => Promise<RemoteResult<ModelCandidates>>
    'fishDrawsSettings/probeModelProfile': (request: { profileId: string }) => Promise<RemoteResult<ModelProfileProbe>>
    'fishDrawsSettings/probeStrata': () => Promise<RemoteResult<StrataProbeResult>>
    'fishDrawsSettings/readStrataStatus': () => Promise<RemoteResult<StrataProbeResult>>
    'fishDrawsSettings/diagnose': () => Promise<RemoteResult<Record<string, unknown>>>
    'fishDrawsSettings/diagnosticPrepare': (request: DiagnosticPrepareRequest) => Promise<RemoteResult<DiagnosticRunView>>
    'fishDrawsSettings/diagnosticStatus': (request: { runId: string }) => Promise<RemoteResult<DiagnosticRunView>>
    'fishDrawsSettings/diagnosticCancel': (request: { runId: string }) => Promise<RemoteResult<DiagnosticRunView>>
    'fishDrawsSettings/diagnosticDelete': (request: { runId: string }) => Promise<RemoteResult<OperationResult>>
  }
  interface TypertRemoteNamespaceMap { fishDrawsSettings: import('@deepseek-ai/dsh-typert-protocol').TypertRemoteNamespace<'fishDrawsSettings'> }
}
export declare const TYPERT_REMOTE: TypertRemoteInfo<Readonly<Record<string, TypertRemoteMethod<object, unknown>>>>
export default TYPERT_REMOTE
`, 'utf8')
await writeFile(resolve(out, 'typert.remote-client.d.ts.map'), JSON.stringify({ version: 3, file: 'typert.remote-client.d.ts', sourceRoot: '', sources: [], names: [], mappings: '' }), 'utf8')

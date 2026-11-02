import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0))
const out = resolve(root, 'lib')
await mkdir(out, { recursive: true })

await writeFile(resolve(out, 'typert.host.js'), `import { TYPERT_REMOTE } from './settings-remote/remote-info.js'
export const TYPERT = { package: '@izzyj4ck/dsh-fish-draws', face: 'host', schemas: [], get invocations() { return TYPERT_REMOTE.descriptors }, model: { services: [{ key: 'fishDrawsSettings', export: { subpath: '.', name: 'FishDrawsSettingsController' } }], events: [], objects: [] } }
`, 'utf8')
await writeFile(resolve(out, 'typert.host.d.ts'), `export declare const TYPERT: unknown
`, 'utf8')
await writeFile(resolve(out, 'typert.remote-client.js'), `export { TYPERT_REMOTE } from './settings-remote/remote-info.js'
export { TYPERT_REMOTE as default } from './settings-remote/remote-info.js'
`, 'utf8')
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

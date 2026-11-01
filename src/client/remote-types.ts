import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ComfyProbeResult, ComfyStopPreparation, DiagnosticPrepareRequest, DiagnosticRunView, ModelCandidates, ModelProfileProbe, OperationResult, SettingsOverview, StrataProbeResult } from '../settings-remote/types.js'

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
  interface TypertRemoteNamespaceMap {
    fishDrawsSettings: import('@deepseek-ai/dsh-typert-protocol').TypertRemoteNamespace<'fishDrawsSettings'>
  }
}

export {}

import { randomBytes } from 'node:crypto'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { FishDrawsError } from '../errors.js'
import type { FishDrawsService } from '../service.js'
import { loadWorkflowTemplate } from '../runtime/workflow-compiler.js'
import { StrataVram } from '../runtime/strata-vram.js'
import { PLUGIN_VERSION, WORKFLOW_VERSION } from '../version.js'
import type { ComfyProbeResult, ComfyStopPreparation, DiagnosticPrepareRequest, DiagnosticRunView, ModelCandidates, ModelProfileProbe, OperationResult, SettingsOverview, StrataProbeResult } from './types.js'

interface StopNonce { value: string; expiresAt: number; signature: string }

declare module '@deepseek-ai/cordis' { interface Context { fishDrawsSettings: FishDrawsSettingsController } }

export class FishDrawsSettingsController extends TypertRemoteService {
  private stopNonce: StopNonce | undefined
  constructor(ctx: Context, private readonly service: FishDrawsService) { super(ctx, 'fishDrawsSettings') }

  @Remote
  async overview(): Promise<SettingsOverview> {
    const config = this.service.config; const online = await this.service.lifecycle.client.online().then(() => true, () => false)
    return {
      pluginVersion: PLUGIN_VERSION, currentModelProfileId: config.currentModelProfileId, currentModelProfileName: config.currentModelProfile.name,
      currentModelProfileHash: config.currentModelProfile.profileHash, comfyOnline: online,
      comfyOwnership: online ? this.service.lifecycle.ownership : 'offline',
      ...(this.service.activeTaskId === undefined ? {} : { activeTaskId: this.service.activeTaskId }),
      diagnosticActive: this.service.diagnosticsRunner.active, strataReleased: this.service.strataReleased,
      ...(this.service.diagnosticsRunner.activeRun?.runId === undefined ? {} : { activeDiagnosticRunId: this.service.diagnosticsRunner.activeRun.runId }),
      ...(this.service.diagnosticsRunner.lastRunId === undefined ? {} : { lastDiagnosticRunId: this.service.diagnosticsRunner.lastRunId }),
      deprecatedPromptEndpointConfigured: config.promptExpansion.deprecatedEndpoint !== undefined,
    }
  }

  @Remote
  async probeComfy(): Promise<ComfyProbeResult> {
    const config = this.service.config
    const rootValid = config.comfy.root !== '' && await access(join(config.comfy.root, 'main.py'), constants.R_OK).then(() => true, () => false)
    try {
      const system = await this.service.lifecycle.client.systemStats()
      const version = typeof system.system === 'object' && system.system !== null && 'comfyui_version' in system.system ? String((system.system as Record<string, unknown>).comfyui_version) : undefined
      return { online: true, ownership: this.service.lifecycle.ownership, rootValid, python: config.comfy.pythonPath === '' ? 'auto' : config.comfy.pythonPath, apiUrl: config.comfy.apiUrl.origin, ...(version === undefined ? {} : { version }), system: system as unknown as Record<string, unknown> }
    } catch (error) {
      return { online: false, ownership: 'offline', rootValid, python: config.comfy.pythonPath === '' ? 'auto' : config.comfy.pythonPath, apiUrl: config.comfy.apiUrl.origin, error: safeMessage(error) }
    }
  }

  @Remote
  async startComfyForTest(): Promise<OperationResult> {
    try { const result = await this.service.startComfyForTest(); return { ok: true, message: result.startedByPlugin ? 'ComfyUI started by fish-draws.' : 'Existing ComfyUI instance is online.' } }
    catch (error) { return operationFailure(error) }
  }

  @Remote
  async prepareComfyStop(): Promise<ComfyStopPreparation> {
    this.stopNonce = undefined
    const queue = await this.service.lifecycle.client.queueState().catch(() => ({ running: 0, pending: 0, idle: false }))
    const blockers: string[] = []
    const ownership = await this.service.lifecycle.client.online().then(() => this.service.lifecycle.ownership, () => 'offline' as const)
    if (ownership !== 'plugin-owned-live-handle') blockers.push('ComfyUI is not owned through a live process handle in this Host lifecycle.')
    if (this.service.activeTaskId !== undefined) blockers.push('A fish-draws job is active.')
    if (this.service.diagnosticsRunner.active) blockers.push('A diagnostic run is active.')
    if (this.service.strataReleased) blockers.push('Strata has not been restored.')
    if (!queue.idle) blockers.push('The ComfyUI queue is not empty.')
    const preparation: ComfyStopPreparation = { allowed: blockers.length === 0, ownership, queueRunning: queue.running, queuePending: queue.pending, blockers }
    if (preparation.allowed) {
      const value = randomBytes(24).toString('base64url'); const expiresAt = Date.now() + 30_000
      this.stopNonce = { value, expiresAt, signature: this.stopSignature(ownership, queue.running, queue.pending) }
      preparation.nonce = value; preparation.expiresAtUtc = new Date(expiresAt).toISOString()
    }
    return preparation
  }

  @Remote
  async stopComfy(request: { nonce: string }): Promise<OperationResult> {
    const prepared = this.stopNonce; this.stopNonce = undefined
    if (prepared === undefined || prepared.value !== request.nonce || Date.now() > prepared.expiresAt) return { ok: false, code: 'STOP_NONCE_INVALID', message: 'The stop confirmation expired; prepare it again.' }
    const current = await this.prepareComfyStop()
    this.stopNonce = undefined
    if (!current.allowed || prepared.signature !== this.stopSignature(current.ownership, current.queueRunning, current.queuePending)) return { ok: false, code: 'STOP_STATE_CHANGED', message: 'ComfyUI state changed after confirmation.' }
    try { await this.service.lifecycle.unloadModels(); await this.service.lifecycle.stopOwned(); return { ok: true } }
    catch (error) { return operationFailure(error) }
  }

  @Remote
  async discoverModelCandidates(): Promise<ModelCandidates> {
    const info = await this.service.lifecycle.client.request<Record<string, unknown>>('/object_info', {}, 30_000)
    return {
      unet: candidates(info, 'UnetLoaderGGUF', 'unet_name'), clip: candidates(info, 'CLIPLoader', 'clip_name'), vae: candidates(info, 'VAELoader', 'vae_name'),
    }
  }

  @Remote
  async probeModelProfile(request: { profileId: string }): Promise<ModelProfileProbe> {
    const config = this.service.config; const profile = config.modelProfiles.find(value => value.id === request.profileId)
    if (profile === undefined) throw new FishDrawsError('model profile was not found', 'MODEL_PROFILE_NOT_FOUND', 'preflight')
    const template = await loadWorkflowTemplate(); const discovered = await this.discoverModelCandidates()
    const missingFiles = [
      ...(discovered.unet.includes(profile.files.unetName) ? [] : [profile.files.unetName]),
      ...(discovered.clip.includes(profile.files.clipName) ? [] : [profile.files.clipName]),
      ...(discovered.vae.includes(profile.files.vaeName) ? [] : [profile.files.vaeName]),
    ]
    const workflowCompatible = profile.workflowCompatibility.workflowVersion === WORKFLOW_VERSION
      && (profile.workflowCompatibility.workflowSha256 === undefined || profile.workflowCompatibility.workflowSha256 === template.sha256)
    const validationMatches = profile.validation?.status === 'verified' && profile.validation.profileHash === profile.profileHash && profile.validation.workflowHash === template.sha256
    const status: ModelProfileProbe['status'] = !workflowCompatible ? 'incompatible' : missingFiles.length > 0 ? 'missing' : validationMatches ? 'verified' : 'unverified'
    return { profileId: profile.id, status, missingFiles, workflowCompatible, profileHash: profile.profileHash, workflowHash: template.sha256 }
  }

  @Remote
  async probeStrata(): Promise<StrataProbeResult> {
    const config = this.service.config
    if (!config.strata.handoffEnabled) return { enabled: false, configured: true, authMode: config.strata.authMode, online: false }
    if (config.strata.vramEndpoint === undefined) return { enabled: true, configured: false, authMode: config.strata.authMode, online: false, error: 'Strata endpoint is not configured.' }
    if (config.strata.authMode === 'bearer' && await this.ctx.credentials.resolve(credentialRef(config.strata.credentialRef)) === undefined) return { enabled: true, configured: false, authMode: 'bearer', online: false, error: 'Strata bearer credential is not configured.' }
    try {
      const client = new StrataVram(config.strata.vramEndpoint, config.strata.credentialRef, this.ctx.credentials, undefined, config.strata.authMode)
      return { enabled: true, configured: true, authMode: config.strata.authMode, online: true, status: await client.status() }
    } catch (error) { return { enabled: true, configured: true, authMode: config.strata.authMode, online: false, error: safeMessage(error) } }
  }

  @Remote
  async readStrataStatus(): Promise<StrataProbeResult> { return this.probeStrata() }

  @Remote
  async diagnose(): Promise<Record<string, unknown>> { return this.service.diagnose() }

  @Remote
  async diagnosticPrepare(request: DiagnosticPrepareRequest): Promise<DiagnosticRunView> {
    if (this.service.activeTaskId !== undefined) throw new FishDrawsError('a formal fish-draws task is active', 'TASK_BUSY', 'preflight')
    return this.service.diagnosticsRunner.prepare(request)
  }

  @Remote
  async diagnosticStatus(request: { runId: string }): Promise<DiagnosticRunView> { return this.service.diagnosticsRunner.status(request.runId) }

  @Remote
  async diagnosticCancel(request: { runId: string }): Promise<DiagnosticRunView> {
    const value = await this.service.diagnosticsRunner.cancel(request.runId)
    if (value.taskId !== undefined) { this.service.executor.cancel(value.taskId, 'diagnostic cancelled'); return value }
    return this.service.diagnosticsRunner.settle(value.runId, { status: 'cancelled', failureClass: 'cancelled', error: 'diagnostic cancelled before generation started' })
  }

  @Remote
  async diagnosticDelete(request: { runId: string }): Promise<OperationResult> {
    try { await this.service.diagnosticsRunner.delete(request.runId); return { ok: true } } catch (error) { return operationFailure(error) }
  }

  private stopSignature(ownership: string, running: number, pending: number): string { return `${ownership}\0${running}\0${pending}\0${this.service.activeTaskId ?? ''}\0${this.service.diagnosticsRunner.active}\0${this.service.strataReleased}` }
}

function candidates(info: Record<string, unknown>, node: string, input: string): string[] {
  const nodeInfo = info[node] as { input?: { required?: Record<string, unknown> } } | undefined
  const definition = nodeInfo?.input?.required?.[input]
  const values = Array.isArray(definition) && Array.isArray(definition[0]) ? definition[0] : []
  return values.filter((value): value is string => typeof value === 'string').sort((a, b) => a.localeCompare(b))
}

function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z]:\\[^\s"']+/gu, '<local-path>').replace(/Bearer\s+\S+/giu, 'Bearer <redacted>') }
function operationFailure(error: unknown): OperationResult { return { ok: false, code: error instanceof FishDrawsError ? error.code : 'INTERNAL', message: safeMessage(error) } }

export default FishDrawsSettingsController

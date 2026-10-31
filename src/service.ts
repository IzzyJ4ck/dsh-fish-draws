import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { JobHandle, JobId } from '@deepseek-ai/dsh-jobs'
import { FishDrawsError } from './errors.js'
import type { ResolvedConfig } from './config.js'
import { readImageMetadata } from './runtime/image-metadata.js'
import { assertExistingPathInside, assertRelativeUserPath } from './runtime/paths.js'
import { resolveCanvas, safetyProfileName, canvasWithinProfile, type Acceleration, type TaskMode } from './runtime/size-resolver.js'
import { ComfyLifecycle } from './runtime/comfy-lifecycle.js'
import { FishDrawsExecutor } from './runtime/executor.js'
import type { ResolvedReference, TaskRecord } from './runtime/task-state.js'
import { diagnostics } from './runtime/diagnostics.js'
import { readManifest, toManifest, writeManifestAtomic, type ResultManifest } from './runtime/result-manifest.js'
import { preserveCandidate, removeManagedFile, cleanupEmptyCandidates, promoteOutput } from './runtime/retention.js'
import { loadWorkflowTemplate } from './runtime/workflow-compiler.js'
import { StrataVram } from './runtime/strata-vram.js'
import { planPreflightReferences } from './runtime/preflight-references.js'
import { normalizeExpandedPrompt } from './runtime/prompt-normalization.js'

export type ReferenceSelector =
  | { kind: 'attachment'; user_turn_offset: number; image_index: number }
  | { kind: 'workspace_file'; relative_path: string }
  | { kind: 'fish_draws_output'; execution_id: string; output_index: number }

export interface PreflightInput {
  task_id?: string
  mode: TaskMode
  original_prompt: string
  references: ReferenceSelector[]
  target_width?: number
  target_height?: number
  aspect_ratio?: string
  size_reference_index?: number
  content_canvas_index?: number
  acceleration?: Acceleration
  count?: number
  visual_facts?: string[]
  uncertainties?: string[]
  complex_confirmation_required?: boolean
}

export interface PreflightRecord {
  taskId: string; mode: TaskMode; originalPrompt: string; references: ResolvedReference[]
  targetWidth: number; targetHeight: number; sampleWidth: number; sampleHeight: number; sizeSource: string
  outpaintingRequired: boolean; safetyProfile: string; oversizeConfirmationRequired: boolean
  visualFacts: string[]; uncertainties: string[]; complexConfirmationRequired: boolean; digest: string; createdAtUtc: string
}

export interface GenerateInput {
  task_id: string; preflight_digest: string; expanded_prompt: string; count?: number; seed?: number; steps?: number
  acceleration?: Acceleration; quality_cycle?: number; complex_task_confirmed?: boolean; allow_oversize?: boolean; formal_batch?: boolean
  no_improvement_rounds?: number
}

interface TaskIndex { createdAtUtc: string; taskDirectory: string; executionId: string }

declare module '@deepseek-ai/cordis' { interface Context { fishDraws: FishDrawsService } }
declare module '@deepseek-ai/dsh-jobs/view' { interface JobKindMap { 'fish-draws': 'fish-draws' } }

export class FishDrawsService extends Service {
  readonly lifecycle: ComfyLifecycle
  readonly executor: FishDrawsExecutor
  private readonly preflights = new Map<string, PreflightRecord>()
  private readonly tasks = new Map<string, TaskIndex>()
  private readonly records = new Map<string, TaskRecord>()
  constructor(ctx: Context, readonly config: ResolvedConfig, readonly runtimeRoot: string) {
    super(ctx, 'fishDraws')
    this.lifecycle = new ComfyLifecycle(config)
    this.executor = new FishDrawsExecutor(config, this.lifecycle, ctx.credentials, runtimeRoot)
  }

  async preflight(input: PreflightInput, agent: Agent, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.config.comfy.root === '' || this.config.storage.outputRoot === '') throw new FishDrawsError('configure comfy.root before using fish-draws', 'CONFIGURATION_REQUIRED', 'preflight')
    if (this.config.strata.handoffEnabled && this.config.strata.vramEndpoint === undefined) throw new FishDrawsError('configure the loopback Strata VRAM endpoint or explicitly disable VRAM handoff', 'STRATA_CONFIGURATION_REQUIRED', 'preflight')
    const taskId = input.task_id ?? this.newTaskId()
    this.validateTaskId(taskId)
    if (input.mode === 't2i' && input.references.length !== 0) throw new FishDrawsError('t2i does not accept reference images', 'UNEXPECTED_REFERENCE', 'preflight')
    if (input.mode === 'edit' && (input.references.length < 1 || input.references.length > 6)) throw new FishDrawsError('edit requires one to six reference images', 'INVALID_REFERENCE_COUNT', 'preflight')
    const references = await this.resolveReferences(input.references, agent, signal)
    const planned = planPreflightReferences(input.mode, references, input.content_canvas_index, input.size_reference_index)
    const normalized = planned.references
    const canvas = resolveCanvas({ mode: input.mode, references: normalized, ...(input.target_width === undefined ? {} : { targetWidth: input.target_width }), ...(input.target_height === undefined ? {} : { targetHeight: input.target_height }), ...(input.aspect_ratio === undefined ? {} : { aspectRatio: input.aspect_ratio }), ...(planned.sizeReferenceIndex === undefined ? {} : { sizeReferenceIndex: planned.sizeReferenceIndex }) })
    if (input.size_reference_index !== undefined) canvas.sizeSource = `reference-upload:${input.size_reference_index + 1}`
    const acceleration = input.acceleration ?? ((input.count ?? 1) > 1 ? 'fast' : 'balanced')
    const profileName = safetyProfileName(input.mode, normalized.length, acceleration, input.count ?? 1)
    const profile = this.config.safety[profileName]
    const base = {
      taskId, mode: input.mode, originalPrompt: input.original_prompt, references: normalized,
      targetWidth: canvas.targetWidth, targetHeight: canvas.targetHeight, sampleWidth: canvas.sampleWidth, sampleHeight: canvas.sampleHeight,
      sizeSource: canvas.sizeSource, outpaintingRequired: canvas.outpaintingRequired, safetyProfile: profileName,
      oversizeConfirmationRequired: !canvasWithinProfile(canvas, profile), visualFacts: input.visual_facts ?? [], uncertainties: input.uncertainties ?? [],
      complexConfirmationRequired: input.complex_confirmation_required ?? false, createdAtUtc: new Date().toISOString(),
    }
    const { createdAtUtc: _createdAtUtc, ...contract } = base
    const digest = createHash('sha256').update(JSON.stringify({ ...contract, references: base.references.map(({ path: _path, ...value }) => value) })).digest('hex')
    const existing = this.tasks.get(taskId) ?? await this.findTask(taskId)
    if (existing !== undefined) {
      const manifest = await readManifest(join(existing.taskDirectory, 'result.json'))
      if (manifest.contract_hash !== digest) throw new FishDrawsError('task_id already belongs to a different immutable request contract', 'TASK_ID_CONFLICT', 'preflight')
    }
    const record: PreflightRecord = { ...base, digest }
    signal?.throwIfAborted()
    this.preflights.set(taskId, record)
    return this.publicPreflight(record)
  }

  async generate(input: GenerateInput, agent: Agent, toolCall?: { callId: string; rootCallId: string }): Promise<{ jobId: JobId; taskId: string; executionId: string; status: 'queued' }> {
    const preflight = this.preflights.get(input.task_id)
    if (preflight === undefined || preflight.digest !== input.preflight_digest) throw new FishDrawsError('preflight is missing or changed', 'PREFLIGHT_MISMATCH', 'preflight')
    if (preflight.complexConfirmationRequired && input.complex_task_confirmed !== true) throw new FishDrawsError('complex task facts and expanded prompt require confirmation', 'CONFIRMATION_REQUIRED', 'preflight')
    if (preflight.oversizeConfirmationRequired && input.allow_oversize !== true) throw new FishDrawsError('sampling canvas exceeds the approved profile and requires confirmation', 'OVERSIZE_CONFIRMATION_REQUIRED', 'preflight')
    const normalizedInput: GenerateInput = { ...input, expanded_prompt: normalizeExpandedPrompt(input.expanded_prompt) }
    const executionId = randomUUID()
    const prior = this.records.get(input.task_id) ?? await this.previousRecord(input.task_id)
    const record = this.newTaskRecord(preflight, normalizedInput, executionId, prior)
    const owner = agent.id
    const controller = new AbortController()
    const jobId = this.ctx.jobs.start({
      kind: 'fish-draws', label: `${preflight.mode} ${preflight.targetWidth}x${preflight.targetHeight}`, owner,
      ...(toolCall === undefined ? {} : { toolCall: { callId: toolCall.callId as any, rootCallId: toolCall.rootCallId as any } }),
      run: (job: JobHandle) => {
        const done = this.runJob(record, preflight, normalizedInput, job, controller.signal)
        return {
          cancel: reason => {
            const cancellation = new FishDrawsError(reason ?? 'cancelled', 'CANCELLED', 'cancelled')
            job.updateProgress('cancelling')
            if (!controller.signal.aborted) controller.abort(cancellation)
            this.executor.cancel(record.taskId, reason)
          },
          done,
        }
      },
    })
    this.preflights.delete(record.taskId)
    await rm(join(this.runtimeRoot, 'preflight', `${record.taskId}.json`), { force: true })
    this.tasks.set(record.taskId, { createdAtUtc: record.createdAtUtc, taskDirectory: this.executor.taskDirectory(record.taskId, record.createdAtUtc), executionId })
    return { jobId, taskId: record.taskId, executionId, status: 'queued' }
  }

  async result(taskId: string): Promise<ResultManifest> {
    const index = this.tasks.get(taskId) ?? await this.findTask(taskId)
    if (index === undefined) throw new FishDrawsError('task result was not found', 'TASK_NOT_FOUND', 'preflight')
    return readManifest(join(index.taskDirectory, 'result.json'))
  }

  async taskDirectory(taskId: string): Promise<string> {
    const index = this.tasks.get(taskId) ?? await this.findTask(taskId)
    if (index === undefined) throw new FishDrawsError('task result was not found', 'TASK_NOT_FOUND', 'preflight')
    return index.taskDirectory
  }

  async finalize(taskId: string, decision: 'adopt' | 'continue' | 'abandon', selections: Array<{ execution_id: string; output_index: number }> = []): Promise<ResultManifest> {
    const index = this.tasks.get(taskId) ?? await this.findTask(taskId)
    if (index === undefined) throw new FishDrawsError('task was not found', 'TASK_NOT_FOUND', 'preflight')
    const path = join(index.taskDirectory, 'result.json'); const manifest = await readManifest(path)
    if (manifest.status !== 'awaiting_selection') throw new FishDrawsError('task is not awaiting a selection', 'INVALID_SELECTION_STATE', 'preflight')
    if (decision === 'continue') { await writeManifestAtomic(path, manifest); return manifest }
    const chosen = decision === 'adopt' ? this.resolveCandidateSelections(manifest, selections) : []
    manifest.outputs = []
    if (decision === 'adopt') {
      for (let indexOut = 0; indexOut < chosen.length; indexOut += 1) {
        const value = chosen[indexOut]!
        const promoted = await promoteOutput({ source: join(index.taskDirectory, value.relative_path), taskDirectory: index.taskDirectory, outputIndex: indexOut + 1, seed: value.seed, executionId: value.execution_id, targetWidth: value.width, targetHeight: value.height })
        manifest.outputs.push({ relative_path: promoted.relativePath, width: promoted.width, height: promoted.height, seed: promoted.seed, sha256: promoted.sha256 })
      }
      manifest.quality.adopted_execution_id = chosen[0]!.execution_id
    }
    const unchosen = manifest.candidates.filter(candidate => !chosen.some(value => value?.relative_path === candidate.relative_path))
    if (decision === 'abandon' || !this.config.storage.retainAllSuccessfulCandidates) {
      for (const candidate of unchosen) await removeManagedFile(join(index.taskDirectory, candidate.relative_path), index.taskDirectory)
      manifest.candidates = []
    } else {
      manifest.candidates = unchosen
    }
    manifest.status = decision === 'adopt' ? 'completed' : 'cancelled'; manifest.completed_at_utc = new Date().toISOString()
    await cleanupEmptyCandidates(index.taskDirectory); await writeManifestAtomic(path, manifest); return manifest
  }

  private resolveCandidateSelections(manifest: ResultManifest, selections: Array<{ execution_id: string; output_index: number }>): ResultManifest['candidates'] {
    if (selections.length === 0) throw new FishDrawsError('adopt requires at least one candidate selection', 'INVALID_SELECTION', 'preflight')
    const executionIds = new Set(selections.map(value => value.execution_id))
    if (executionIds.size !== 1) throw new FishDrawsError('all adopted outputs must come from the same execution', 'MIXED_SELECTION_EXECUTIONS', 'preflight')
    const chosen = selections.map(selection => {
      if (!Number.isSafeInteger(selection.output_index) || selection.output_index < 0) throw new FishDrawsError('selection output_index must be a zero-based non-negative integer', 'INVALID_SELECTION_INDEX', 'preflight')
      const candidates = manifest.candidates.filter(value => value.execution_id === selection.execution_id)
      const candidate = candidates[selection.output_index]
      if (candidate === undefined) throw new FishDrawsError('selection does not identify a candidate at that zero-based output_index', 'INVALID_SELECTION', 'preflight')
      return candidate
    })
    if (new Set(chosen.map(value => value.relative_path)).size !== chosen.length) throw new FishDrawsError('the same candidate cannot be adopted more than once', 'DUPLICATE_SELECTION', 'preflight')
    return chosen
  }

  async diagnose(): Promise<Record<string, unknown>> { await this.cleanupLegacyPreflights(); await this.retryCleanupJournal(); return diagnostics(this.config, this.lifecycle, this.runtimeRoot) }
  async recoverLifecycle(): Promise<void> {
    await this.cleanupLegacyPreflights()
    if (!this.config.strata.handoffEnabled || this.config.strata.vramEndpoint === undefined) return
    const strata = new StrataVram(this.config.strata.vramEndpoint, this.config.strata.credentialRef, this.ctx.credentials, join(this.runtimeRoot, 'strata-vram-journal.json'))
    await strata.recover()
  }
  async dispose(): Promise<void> {
    this.preflights.clear()
    await this.cleanupLegacyPreflights()
    await this.lifecycle.stopOwned()
  }

  private async cleanupLegacyPreflights(): Promise<void> {
    await rm(join(this.runtimeRoot, 'preflight'), { recursive: true, force: true })
  }

  private async retryCleanupJournal(): Promise<void> {
    const root = join(this.runtimeRoot, 'cleanup-journal')
    for (const name of await readdir(root).catch(() => [])) {
      const journalPath = join(root, name)
      try {
        const value = JSON.parse(await readFile(journalPath, 'utf8')) as { task_id?: string; execution_id?: string; residual_items?: string[] }
        if (typeof value.task_id !== 'string' || typeof value.execution_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,63}$/u.test(value.task_id) || !/^[0-9a-f-]{16,64}$/iu.test(value.execution_id)) continue
        if (this.executor.activeTaskId === value.task_id) continue
        const remaining: string[] = []
        for (const item of value.residual_items ?? []) {
          let target: string | undefined
          if (item === 'temporary_inputs') target = join(this.config.comfy.root, 'input', 'fish-draws', value.task_id, value.execution_id)
          if (item === 'workflow') target = join(this.runtimeRoot, 'workflows', `${value.execution_id}.json`)
          if (item === 'comfy_staging') target = join(this.config.comfy.root, 'output', 'fish-draws-staging', value.task_id, value.execution_id)
          if (target === undefined) { remaining.push(item); continue }
          try { await rm(target, { recursive: true, force: true }) } catch { remaining.push(item) }
        }
        if (remaining.length === 0) await rm(journalPath, { force: true })
        else await writeFile(journalPath, JSON.stringify({ ...value, residual_items: remaining, updated_at_utc: new Date().toISOString() }), { encoding: 'utf8', flag: 'w', mode: 0o600 })
      } catch { /* preserve unreadable journal for manual diagnosis */ }
    }
  }

  private async runJob(record: TaskRecord, preflight: PreflightRecord, input: GenerateInput, job: JobHandle, signal: AbortSignal) {
    try {
      const profile = this.config.safety[preflight.safetyProfile as keyof ResolvedConfig['safety']]
      const final = await this.executor.execute({ record, references: preflight.references, count: input.count ?? 1, seed: input.seed ?? -1, reserveMiB: profile.reserveMiB, retainAllCandidates: this.config.storage.retainAllSuccessfulCandidates, formalBatch: input.formal_batch ?? (input.count ?? 1) > 1, allowOversize: input.allow_oversize ?? false, pauseForSelection: (input.no_improvement_rounds ?? 0) >= 2 }, value => { job.updateProgress(value.detail === undefined ? value.phase : `${value.phase}: ${value.detail}`) }, signal)
      this.records.set(record.taskId, final)
      return final.status === 'failed' ? { status: 'failed' as const, ...(final.failure?.message === undefined ? {} : { detail: final.failure.message }) } : final.status === 'cancelled' ? { status: 'killed' as const } : { status: 'completed' as const, result: JSON.stringify({ task_id: final.taskId, execution_id: final.executionId, status: final.status }) }
    } catch (error) { return { status: signal.aborted ? 'killed' as const : 'failed' as const, detail: error instanceof Error ? error.message : String(error) } }
  }

  private newTaskRecord(preflight: PreflightRecord, input: GenerateInput, executionId: string, previous?: TaskRecord): TaskRecord {
    return { taskId: preflight.taskId, contractHash: preflight.digest, executionId, mode: preflight.mode, status: 'queued', createdAtUtc: previous?.createdAtUtc ?? new Date().toISOString(), originalPrompt: preflight.originalPrompt, expandedPrompt: input.expanded_prompt, references: preflight.references.map(value => ({ sha256: value.sha256, imageTag: value.imageTag, width: value.width, height: value.height })), targetWidth: preflight.targetWidth, targetHeight: preflight.targetHeight, sampleWidth: preflight.sampleWidth, sampleHeight: preflight.sampleHeight, sizeSource: preflight.sizeSource, outpaintingRequired: preflight.outpaintingRequired, acceleration: input.acceleration ?? ((input.count ?? 1) > 1 ? 'fast' : 'balanced'), steps: input.steps ?? 40, technicalAttempts: 0, qualityCycle: input.quality_cycle ?? 0, qualityReworkOccurred: (input.quality_cycle ?? 0) > 0, outputs: previous?.outputs.map(value => ({ ...value })) ?? [], candidates: previous?.candidates.map(value => ({ ...value })) ?? [], comfyStartedByPlugin: false, comfyModelsUnloaded: false, strataRestored: false, cleanup: { complete: false, temporaryInputsRemoved: false, workflowRemoved: false, queueStateRemoved: false, residualItems: [] } }
  }

  private async resolveReferences(selectors: ReferenceSelector[], agent: Agent, signal?: AbortSignal): Promise<ResolvedReference[]> {
    if (selectors.length === 0) return []
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal)
    const values: ResolvedReference[] = []
    for (let index = 0; index < selectors.length; index += 1) {
      const selector = selectors[index]!
      let path: string
      let originalDimensions: { width: number; height: number } | undefined
      if (selector.kind === 'workspace_file') { assertRelativeUserPath(selector.relative_path); path = await assertExistingPathInside(resolve(cwd, selector.relative_path), cwd, 'reference image') }
      else if (selector.kind === 'attachment') {
        const ref = this.attachmentAt(agent, selector.user_turn_offset, selector.image_index)
        await this.ctx.attachments.readImage(ref, signal)
        originalDimensions = ref.originalDimensions ?? { width: ref.width, height: ref.height }
        const hostPath = this.ctx.attachments.imageHostPath(ref)
        if (hostPath === undefined) throw new FishDrawsError('attachment provider has no host path for ComfyUI', 'ATTACHMENT_NOT_HOST_BACKED', 'preflight')
        path = hostPath
      } else {
        const found = [...this.tasks.values()].find(value => value.executionId === selector.execution_id) ?? await this.findByExecutionId(selector.execution_id)
        if (found === undefined) throw new FishDrawsError('fish-draws output reference was not found', 'OUTPUT_REFERENCE_NOT_FOUND', 'preflight')
        const manifest = await readManifest(join(found.taskDirectory, 'result.json')); const output = manifest.outputs[selector.output_index]
        if (output === undefined) throw new FishDrawsError('output index is outside the task result', 'OUTPUT_REFERENCE_NOT_FOUND', 'preflight')
        path = join(found.taskDirectory, output.relative_path)
      }
      const metadata = await readImageMetadata(path)
      values.push({ path, sha256: metadata.sha256, width: originalDimensions?.width ?? metadata.width, height: originalDimensions?.height ?? metadata.height, imageTag: `<image${index + 1}>` })
    }
    return values
  }
  private attachmentAt(agent: Agent, userTurnOffset: number, imageIndex: number): ImageAttachmentRef {
    if (!Number.isInteger(userTurnOffset) || userTurnOffset < 0 || !Number.isInteger(imageIndex) || imageIndex < 0) throw new FishDrawsError('attachment selector indices must be non-negative integers', 'INVALID_ATTACHMENT_SELECTOR', 'preflight')
    const messages = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user').reverse()
    const message = messages[userTurnOffset]
    const images = message?.type === 'user/message' ? message.data.content.filter((block): block is { type: 'image'; attachment: ImageAttachmentRef } => block.type === 'image') : []
    const ref = images[imageIndex]?.attachment
    if (ref === undefined) throw new FishDrawsError('attachment selector did not match an image', 'ATTACHMENT_NOT_FOUND', 'preflight')
    return ref
  }
  private publicPreflight(record: PreflightRecord): Record<string, unknown> { return { task_id: record.taskId, mode: record.mode, references: record.references.map(({ path: _path, ...value }) => value), target_width: record.targetWidth, target_height: record.targetHeight, sample_width: record.sampleWidth, sample_height: record.sampleHeight, size_source: record.sizeSource, outpainting_required: record.outpaintingRequired, safety_profile: record.safetyProfile, oversize_confirmation_required: record.oversizeConfirmationRequired, visual_facts: record.visualFacts, uncertainties: record.uncertainties, complex_confirmation_required: record.complexConfirmationRequired, preflight_digest: record.digest } }
  private newTaskId(): string { return `fish-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}` }
  private validateTaskId(value: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,63}$/u.test(value)) throw new FishDrawsError('task_id must be 8-64 safe identifier characters', 'INVALID_TASK_ID', 'preflight') }
  private async findTask(taskId: string): Promise<TaskIndex | undefined> {
    for (const date of await (await import('node:fs/promises')).readdir(join(this.config.storage.outputRoot, 'fish-draws')).catch(() => [])) {
      const taskDirectory = join(this.config.storage.outputRoot, 'fish-draws', date, taskId)
      try { const manifest = await readManifest(join(taskDirectory, 'result.json')); const value = { createdAtUtc: manifest.created_at_utc, taskDirectory, executionId: manifest.execution_id }; this.tasks.set(taskId, value); return value } catch { /* keep looking */ }
    }
    return undefined
  }
  private async findByExecutionId(executionId: string): Promise<TaskIndex | undefined> {
    if (!/^[0-9a-f-]{16,64}$/iu.test(executionId)) throw new FishDrawsError('execution_id has an invalid format', 'INVALID_EXECUTION_ID', 'preflight')
    for (const date of await (await import('node:fs/promises')).readdir(join(this.config.storage.outputRoot, 'fish-draws')).catch(() => [])) {
      for (const taskId of await (await import('node:fs/promises')).readdir(join(this.config.storage.outputRoot, 'fish-draws', date)).catch(() => [])) {
        const taskDirectory = join(this.config.storage.outputRoot, 'fish-draws', date, taskId)
        try {
          const manifest = await readManifest(join(taskDirectory, 'result.json'))
          if (manifest.execution_id === executionId || manifest.quality.adopted_execution_id === executionId) {
            const found = { createdAtUtc: manifest.created_at_utc, taskDirectory, executionId: manifest.execution_id }
            this.tasks.set(taskId, found); return found
          }
        } catch { /* ignore unrelated or incomplete task directories */ }
      }
    }
    return undefined
  }
  private async previousRecord(taskId: string): Promise<TaskRecord | undefined> {
    const index = this.tasks.get(taskId) ?? await this.findTask(taskId)
    if (index === undefined) return undefined
    const value = await readManifest(join(index.taskDirectory, 'result.json'))
    return {
      taskId: value.task_id, contractHash: value.contract_hash, executionId: value.execution_id, mode: value.task_mode as TaskMode,
      status: value.status as TaskRecord['status'], createdAtUtc: value.created_at_utc, ...(value.completed_at_utc === undefined ? {} : { completedAtUtc: value.completed_at_utc }),
      originalPrompt: value.prompts.original, expandedPrompt: value.prompts.expanded,
      references: value.references.map(item => ({ sha256: item.sha256, imageTag: item.image_tag, width: item.width, height: item.height })),
      targetWidth: value.canvas.target_width, targetHeight: value.canvas.target_height, sampleWidth: value.canvas.sample_width, sampleHeight: value.canvas.sample_height,
      sizeSource: value.canvas.size_source, outpaintingRequired: false, acceleration: value.generation.acceleration as Acceleration, steps: value.generation.steps,
      technicalAttempts: value.generation.technical_attempts, qualityCycle: value.quality.rework_rounds, qualityReworkOccurred: value.quality.rework_occurred,
      ...(value.quality.adopted_execution_id === undefined ? {} : { adoptedExecutionId: value.quality.adopted_execution_id }),
      outputs: value.outputs.map(item => ({ path: join(index.taskDirectory, item.relative_path), relativePath: item.relative_path, width: item.width, height: item.height, seed: item.seed, sha256: item.sha256, executionId: value.quality.adopted_execution_id ?? value.execution_id, adopted: true })),
      candidates: value.candidates.map(item => ({ path: join(index.taskDirectory, item.relative_path), relativePath: item.relative_path, width: item.width, height: item.height, seed: item.seed, sha256: item.sha256, executionId: item.execution_id, adopted: item.adopted, qualityCycle: item.quality_cycle, candidateKind: item.candidate_kind, candidateIndex: item.candidate_index })),
      comfyStartedByPlugin: value.lifecycle.comfy_started_by_plugin, comfyModelsUnloaded: value.lifecycle.comfy_models_unloaded, strataRestored: value.lifecycle.strata_restored,
      cleanup: { complete: value.cleanup.complete, temporaryInputsRemoved: value.cleanup.temporary_inputs_removed, workflowRemoved: value.cleanup.workflow_removed, queueStateRemoved: value.cleanup.queue_state_removed, residualItems: [...value.cleanup.residual_items] },
      ...(value.failure === null ? {} : { failure: { class: value.failure.class as any, code: value.failure.code, message: value.failure.message } }),
    }
  }
}

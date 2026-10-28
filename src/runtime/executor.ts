import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { randomInt } from 'node:crypto'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ResolvedConfig } from '../config.js'
import { FishDrawsError, errorMessage } from '../errors.js'
import { ComfyLifecycle } from './comfy-lifecycle.js'
import { loadWorkflowTemplate, compileWorkflow, type WorkflowTemplate } from './workflow-compiler.js'
import { StrataVram } from './strata-vram.js'
import { promoteOutput, preserveCandidate, removeManagedFile, cleanupEmptyCandidates } from './retention.js'
import { toManifest, writeManifestAtomic } from './result-manifest.js'
import type { ResolvedReference, TaskRecord } from './task-state.js'

export interface ExecutionRequest {
  record: TaskRecord
  references: readonly ResolvedReference[]
  count: number
  seed: number
  reserveMiB: number
  retainAllCandidates: boolean
  formalBatch: boolean
  allowOversize: boolean
  pauseForSelection: boolean
}

export interface ExecutionProgress { phase: string; detail?: string }

export class FishDrawsExecutor {
  private template?: WorkflowTemplate
  private active: { taskId: string; controller: AbortController; promptId: string | undefined } | undefined
  constructor(
    readonly config: ResolvedConfig,
    readonly lifecycle: ComfyLifecycle,
    private readonly credentials: CredentialProvider,
    readonly runtimeRoot: string,
  ) {}

  cancel(taskId: string, reason = 'cancelled'): void {
    if (this.active?.taskId === taskId) this.active.controller.abort(new FishDrawsError(reason, 'CANCELLED', 'cancelled'))
  }
  get activeTaskId(): string | undefined { return this.active?.taskId }

  async execute(request: ExecutionRequest, progress: (value: ExecutionProgress) => void): Promise<TaskRecord> {
    if (this.active !== undefined) throw new FishDrawsError('another fish-draws task is active', 'TASK_BUSY', 'preflight')
    const controller = new AbortController()
    this.active = { taskId: request.record.taskId, controller, promptId: undefined }
    const signal = controller.signal
    const record = request.record
    const taskDirectory = this.taskDirectory(record.taskId, record.createdAtUtc)
    const resultPath = join(taskDirectory, 'result.json')
    await mkdir(taskDirectory, { recursive: true })
    await mkdir(this.runtimeRoot, { recursive: true })
    const activeLock = join(this.runtimeRoot, 'active-task.json')
    await this.acquireLock(activeLock, record.taskId, record.executionId)
    let template = this.template
    const strata = new StrataVram(this.config.strata.vramEndpoint, this.config.strata.credentialRef, this.credentials, join(this.runtimeRoot, 'strata-vram-journal.json'))
    const stagedInputs = join(this.config.comfy.root, 'input', 'fish-draws', record.taskId, record.executionId)
    const stagedNames: string[] = []
    const workflowPath = join(this.runtimeRoot, 'workflows', `${record.executionId}.json`)
    const promptIds: string[] = []
    try {
      template ??= await loadWorkflowTemplate(); this.template = template
      record.status = 'running'; progress({ phase: 'comfy_starting' })
      const online = await this.lifecycle.ensureOnline(this.runtimeRoot, signal)
      record.comfyStartedByPlugin = online.startedByPlugin
      this.lifecycle.cancelIdleShutdown()
      if (!await this.lifecycle.client.waitIdle(30_000, signal)) throw new FishDrawsError('ComfyUI is busy', 'COMFY_BUSY', 'technical', true)
      await this.lifecycle.client.freeModels(signal)

      progress({ phase: 'input_staging' }); await mkdir(stagedInputs, { recursive: true })
      for (let index = 0; index < request.references.length; index += 1) {
        const reference = request.references[index]!
        const extension = extname(reference.path).toLowerCase() || '.png'
        const filename = `input-${index + 1}${extension}`
        await cp(reference.path, join(stagedInputs, filename), { force: false, errorOnExist: true })
        stagedNames.push(`fish-draws/${record.taskId}/${record.executionId}/${filename}`)
      }

      progress({ phase: 'strata_releasing' })
      if (this.config.strata.handoffEnabled) await strata.release(request.reserveMiB, signal)
      let lastError: unknown
      const selectedSeed = request.seed < 0 ? randomInt(1, 2_147_483_647) : request.seed
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        record.technicalAttempts = attempt
        try {
          progress({ phase: 'generating', detail: `technical attempt ${attempt}` })
          const generated: Array<{ path: string; seed: number }> = []
          for (let index = 0; index < request.count; index += 1) {
            signal.throwIfAborted()
            const seed = selectedSeed + index
            const prefix = `fish-draws-staging/${record.taskId}/${record.executionId}/image-${index + 1}`
            const graph = compileWorkflow(template, this.config, {
              prompt: record.expandedPrompt, inputImageNames: stagedNames, targetWidth: record.targetWidth, targetHeight: record.targetHeight,
              sampleWidth: record.sampleWidth, sampleHeight: record.sampleHeight, seed, steps: record.steps, acceleration: record.acceleration, filenamePrefix: prefix,
            })
            await mkdir(resolve(workflowPath, '..'), { recursive: true })
            await writeFile(workflowPath, JSON.stringify(graph), { encoding: 'utf8', flag: 'w' })
            const promptId = await this.lifecycle.client.submit(graph, `fish-draws-${record.executionId}`, signal)
            this.active.promptId = promptId; promptIds.push(promptId)
            const images = await this.lifecycle.client.waitResult(promptId, this.config.runtime.timeoutPerImageSec * 1000, signal)
            for (const image of images) generated.push({ path: this.resolveComfyOutput(image), seed })
            this.active.promptId = undefined
          }
          await this.promoteGenerated(record, generated, taskDirectory, request)
          lastError = undefined
          break
        } catch (error) {
          lastError = error
          await this.lifecycle.client.interrupt(this.active.promptId)
          await this.lifecycle.client.waitIdle(120_000).catch(() => false)
          await this.lifecycle.client.freeModels().catch(() => false)
          if (!(error instanceof FishDrawsError && error.retryable) || attempt === 4 || signal.aborted) throw error
        }
      }
      if (lastError !== undefined) throw lastError
      progress({ phase: 'comfy_unloading' })
      record.comfyModelsUnloaded = await this.lifecycle.client.freeModels(signal)
      if (!record.comfyModelsUnloaded) throw new FishDrawsError('ComfyUI models could not be unloaded', 'COMFY_UNLOAD_FAILED', 'lifecycle')
      progress({ phase: 'strata_restoring' })
      record.strataRestored = await strata.restore(signal)
      if (!record.strataRestored) throw new FishDrawsError('Strata reserve could not be restored', 'STRATA_RESTORE_FAILED', 'lifecycle')
      record.completedAtUtc = new Date().toISOString()
      if (request.pauseForSelection && !request.formalBatch) record.status = 'awaiting_selection'
      else record.status = 'completed'
    } catch (error) {
      await this.lifecycle.client.interrupt(this.active?.promptId)
      record.comfyModelsUnloaded = await this.lifecycle.client.freeModels().catch(() => false)
      record.strataRestored = await strata.restore().catch(() => false)
      record.completedAtUtc = new Date().toISOString()
      record.status = signal.aborted ? 'cancelled' : 'failed'
      const typed = error instanceof FishDrawsError ? error : new FishDrawsError(errorMessage(error), 'UNEXPECTED', 'technical')
      record.failure = { class: typed.failureClass, code: typed.code, message: typed.message }
    } finally {
      progress({ phase: 'cleanup' })
      const residual: string[] = []
      for (const [name, action] of [
        ['temporary_inputs', () => rm(stagedInputs, { recursive: true, force: true })],
        ['workflow', () => rm(workflowPath, { force: true })],
        ['comfy_staging', () => rm(join(this.config.comfy.root, 'output', 'fish-draws-staging', record.taskId, record.executionId), { recursive: true, force: true })],
      ] as const) {
        try { await action() } catch { residual.push(name) }
      }
      for (const promptId of promptIds) await this.lifecycle.client.deleteHistory(promptId)
      record.cleanup.temporaryInputsRemoved = !residual.includes('temporary_inputs')
      record.cleanup.workflowRemoved = !residual.includes('workflow')
      record.cleanup.queueStateRemoved = true
      record.cleanup.residualItems = residual
      record.cleanup.complete = residual.length === 0
      try { await rm(activeLock, { force: true }) } catch { residual.push('active_task_lock'); record.cleanup.queueStateRemoved = false }
      record.cleanup.residualItems = residual
      record.cleanup.complete = residual.length === 0
      if (record.status === 'completed' && residual.length > 0) {
        record.status = 'completed_with_warnings'
      }
      if (residual.length > 0 && record.failure === undefined) record.failure = { class: 'cleanup', code: 'CLEANUP_INCOMPLETE', message: `cleanup left managed residual items: ${residual.join(', ')}` }
      const journalPath = join(this.runtimeRoot, 'cleanup-journal', `${record.taskId}.json`)
      if (residual.length > 0) {
        await mkdir(join(this.runtimeRoot, 'cleanup-journal'), { recursive: true })
        await writeFile(journalPath, JSON.stringify({ schema_version: 1, task_id: record.taskId, execution_id: record.executionId, residual_items: residual, updated_at_utc: new Date().toISOString() }), { encoding: 'utf8', flag: 'w', mode: 0o600 })
      } else await rm(journalPath, { force: true })
      await writeManifestAtomic(resultPath, toManifest(record, template?.sha256 ?? 'unavailable'))
      this.active = undefined
      this.lifecycle.scheduleIdleShutdown()
    }
    return record
  }

  private async promoteGenerated(record: TaskRecord, generated: Array<{ path: string; seed: number }>, taskDirectory: string, request: ExecutionRequest): Promise<void> {
    if (record.qualityCycle > 0 && record.outputs.length > 0) {
      const previous = [...record.outputs]; record.outputs = []
      for (let index = 0; index < previous.length; index += 1) {
        const old = previous[index]!
        record.candidates.push(await preserveCandidate({ source: old.path, taskDirectory, candidateIndex: record.candidates.length + 1, outputIndex: index + 1, seed: old.seed, executionId: old.executionId, qualityCycle: Math.max(0, record.qualityCycle - 1), targetWidth: record.targetWidth, targetHeight: record.targetHeight }))
      }
    }
    for (let index = 0; index < generated.length; index += 1) {
      const output = generated[index]!
      if (request.pauseForSelection && !request.formalBatch) {
        record.candidates.push(await preserveCandidate({ source: output.path, taskDirectory, candidateIndex: record.candidates.length + 1, outputIndex: index + 1, seed: output.seed, executionId: record.executionId, qualityCycle: record.qualityCycle, targetWidth: record.targetWidth, targetHeight: record.targetHeight }))
      } else {
        record.outputs.push(await promoteOutput({ source: output.path, taskDirectory, outputIndex: index + 1, seed: output.seed, executionId: record.executionId, targetWidth: record.targetWidth, targetHeight: record.targetHeight }))
      }
    }
    if (!request.retainAllCandidates && !request.pauseForSelection) {
      for (const candidate of record.candidates) await removeManagedFile(candidate.path, taskDirectory)
      record.candidates = []; await cleanupEmptyCandidates(taskDirectory)
    }
  }

  private resolveComfyOutput(image: { type: string; filename: string; subfolder: string }): string {
    if (image.type !== 'output' || image.filename.includes('/') || image.filename.includes('\\') || image.subfolder.includes('..')) throw new FishDrawsError('ComfyUI returned an unsafe output path', 'UNSAFE_COMFY_OUTPUT', 'technical')
    const root = resolve(this.config.comfy.root, 'output')
    const path = resolve(root, image.subfolder, basename(image.filename))
    if (!path.toLowerCase().startsWith(`${root.toLowerCase()}\\`) && path.toLowerCase() !== root.toLowerCase()) throw new FishDrawsError('ComfyUI output escaped its root', 'UNSAFE_COMFY_OUTPUT', 'technical')
    return path
  }
  taskDirectory(taskId: string, createdAtUtc: string): string {
    const local = new Date(createdAtUtc); const date = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
    return join(this.config.storage.outputRoot, 'fish-draws', date, taskId)
  }
  private async acquireLock(path: string, taskId: string, executionId: string): Promise<void> {
    try { await writeFile(path, JSON.stringify({ schema_version: 1, pid: process.pid, task_id: taskId, execution_id: executionId }), { encoding: 'utf8', flag: 'wx', mode: 0o600 }); return }
    catch (error: any) { if (error?.code !== 'EEXIST') throw error }
    try {
      const current = JSON.parse(await readFile(path, 'utf8')) as { pid?: number }
      if (Number.isInteger(current.pid)) { try { process.kill(current.pid!, 0); throw new FishDrawsError('another fish-draws host process owns the active-task lock', 'TASK_BUSY', 'preflight') } catch (error) { if (error instanceof FishDrawsError) throw error } }
      await rm(path, { force: true })
      await writeFile(path, JSON.stringify({ schema_version: 1, pid: process.pid, task_id: taskId, execution_id: executionId }), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) { if (error instanceof FishDrawsError) throw error; throw new FishDrawsError('active-task lock is unreadable; diagnose before continuing', 'TASK_LOCK_INVALID', 'preflight') }
  }
}

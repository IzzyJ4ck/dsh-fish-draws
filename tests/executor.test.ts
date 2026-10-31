import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { resolveConfig } from '../src/config.js'
import { FishDrawsError } from '../src/errors.js'
import type { ComfyLifecycle } from '../src/runtime/comfy-lifecycle.js'
import { FishDrawsExecutor } from '../src/runtime/executor.js'
import type { TaskRecord } from '../src/runtime/task-state.js'
import { loadWorkflowTemplate } from '../src/runtime/workflow-compiler.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function record(taskId: string): TaskRecord {
  return {
    taskId, contractHash: 'contract', executionId: '00000000-0000-4000-8000-000000000001', mode: 't2i', status: 'queued',
    createdAtUtc: '2026-10-29T00:00:00.000Z', originalPrompt: 'original', expandedPrompt: 'expanded', references: [],
    targetWidth: 512, targetHeight: 512, sampleWidth: 512, sampleHeight: 512, sizeSource: 'explicit', outpaintingRequired: false,
    acceleration: 'balanced', steps: 40, technicalAttempts: 0, qualityCycle: 0, qualityReworkOccurred: false,
    outputs: [], candidates: [], comfyStartedByPlugin: false, comfyModelsUnloaded: false, strataRestored: false,
    cleanup: { complete: false, temporaryInputsRemoved: false, workflowRemoved: false, queueStateRemoved: false, residualItems: [] },
  }
}

async function fixture(
  submit: () => Promise<string>,
  waitResult: (promptId: string, timeoutMs: number, signal?: AbortSignal) => Promise<Array<{ filename: string; subfolder: string; type: string }>> = async () => [],
) {
  const root = await mkdtemp(join(tmpdir(), 'fish-executor-'))
  roots.push(root)
  const comfyRoot = join(root, 'comfy')
  const outputRoot = join(root, 'output')
  await Promise.all([mkdir(join(comfyRoot, 'input'), { recursive: true }), mkdir(join(comfyRoot, 'output'), { recursive: true }), mkdir(outputRoot, { recursive: true })])
  const client = {
    waitIdle: vi.fn(async () => true),
    freeModels: vi.fn(async () => true),
    interrupt: vi.fn(async () => undefined),
    submit: vi.fn(submit),
    waitResult: vi.fn(waitResult),
    deleteHistory: vi.fn(async () => undefined),
  }
  const lifecycle = {
    client,
    ensureOnline: vi.fn(async () => ({ startedByPlugin: true })),
    cancelIdleShutdown: vi.fn(),
    unloadModels: vi.fn(async () => true),
    scheduleIdleShutdown: vi.fn(),
  } as unknown as ComfyLifecycle
  const config = resolveConfig({ comfy: { root: comfyRoot }, storage: { outputRoot }, strata: { handoffEnabled: false } })
  const executor = new FishDrawsExecutor(config, lifecycle, {} as CredentialProvider, join(outputRoot, '.fish-draws-runtime'))
  Object.assign(executor as any, { template: await loadWorkflowTemplate(new URL('../assets/qwen21-unified-api.json', import.meta.url)) })
  return { executor, lifecycle, client }
}

function request(value: TaskRecord) {
  return { record: value, references: [], count: 1, seed: 1, reserveMiB: 21_504, retainAllCandidates: false, formalBatch: false, allowOversize: false, pauseForSelection: false }
}

describe('technical attempt cleanup', () => {
  it('preserves a non-retryable original error instead of masking it with retry unload', async () => {
    const original = new FishDrawsError('original failure', 'ORIGINAL_FAILURE', 'technical')
    const { executor, lifecycle } = await fixture(async () => { throw original })
    const result = await executor.execute(request(record('preserve-original')), () => undefined)

    expect(result.failure).toMatchObject({ class: 'technical', code: 'ORIGINAL_FAILURE', message: 'original failure' })
    expect(result.technicalAttempts).toBe(1)
    expect(lifecycle.unloadModels).toHaveBeenCalledTimes(1)
  })

  it('uses lifecycle reset and restarts plugin-owned ComfyUI before a retry', async () => {
    let attempt = 0
    const { executor, lifecycle, client } = await fixture(async () => {
      attempt += 1
      if (attempt === 1) throw new FishDrawsError('temporary timeout', 'COMFY_TIMEOUT', 'technical', true)
      throw new FishDrawsError('second failure', 'SECOND_FAILURE', 'technical')
    })
    const result = await executor.execute(request(record('restart-before-retry')), () => undefined)

    expect(result.failure).toMatchObject({ code: 'SECOND_FAILURE' })
    expect(result.technicalAttempts).toBe(2)
    expect(lifecycle.ensureOnline).toHaveBeenCalledTimes(2)
    expect(lifecycle.unloadModels).toHaveBeenCalledTimes(2)
    expect(client.freeModels).toHaveBeenCalledTimes(1)
  })

  it('stops after four retryable executions and keeps the fourth technical error', async () => {
    const { executor, lifecycle } = await fixture(async () => { throw new FishDrawsError('timed out', 'COMFY_TIMEOUT', 'technical', true) })
    const result = await executor.execute(request(record('four-attempt-limit')), () => undefined)

    expect(result.failure).toMatchObject({ class: 'technical', code: 'COMFY_TIMEOUT', message: 'timed out' })
    expect(result.technicalAttempts).toBe(4)
    expect(lifecycle.ensureOnline).toHaveBeenCalledTimes(4)
    expect(lifecycle.unloadModels).toHaveBeenCalledTimes(4)
  })
})

describe('job cancellation', () => {
  it('honours a signal that was cancelled before executor startup', async () => {
    const { executor, lifecycle, client } = await fixture(async () => 'unused')
    const controller = new AbortController()
    controller.abort(new FishDrawsError('cancelled before startup', 'CANCELLED', 'cancelled'))

    const result = await executor.execute(request(record('cancel-before-start')), () => undefined, controller.signal)

    expect(result.status).toBe('cancelled')
    expect(result.failure).toEqual({ class: 'cancelled', code: 'CANCELLED', message: 'cancelled before startup' })
    expect(result.technicalAttempts).toBe(0)
    expect(lifecycle.ensureOnline).not.toHaveBeenCalled()
    expect(client.submit).not.toHaveBeenCalled()
    expect(result.cleanup.complete).toBe(true)
    expect(executor.activeTaskId).toBeUndefined()
  })

  it('interrupts an active prompt and settles only after lifecycle cleanup', async () => {
    let markWaiting!: () => void
    const waiting = new Promise<void>(resolve => { markWaiting = resolve })
    const { executor, lifecycle, client } = await fixture(
      async () => 'prompt-to-cancel',
      async (_promptId, _timeoutMs, signal) => {
        markWaiting()
        await new Promise<never>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason)
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    )
    const controller = new AbortController()
    const completion = executor.execute(request(record('cancel-active-prompt')), () => undefined, controller.signal)
    await waiting

    controller.abort(new FishDrawsError('user requested cancellation', 'CANCELLED', 'cancelled'))
    const result = await completion

    expect(result.status).toBe('cancelled')
    expect(result.failure).toEqual({ class: 'cancelled', code: 'CANCELLED', message: 'user requested cancellation' })
    expect(result.technicalAttempts).toBe(1)
    expect(client.interrupt).toHaveBeenCalledWith('prompt-to-cancel')
    expect(lifecycle.unloadModels).toHaveBeenCalled()
    expect(result.comfyModelsUnloaded).toBe(true)
    expect(result.strataRestored).toBe(true)
    expect(result.cleanup.complete).toBe(true)
    expect(executor.activeTaskId).toBeUndefined()
  })

  it('keeps direct executor cancellation idempotent', async () => {
    let markWaiting!: () => void
    const waiting = new Promise<void>(resolve => { markWaiting = resolve })
    const { executor } = await fixture(
      async () => 'direct-cancel-prompt',
      async (_promptId, _timeoutMs, signal) => {
        markWaiting()
        await new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))
      },
    )
    const completion = executor.execute(request(record('direct-cancel')), () => undefined)
    await waiting

    executor.cancel('direct-cancel', 'first cancellation')
    executor.cancel('direct-cancel', 'second cancellation')
    const result = await completion

    expect(result.status).toBe('cancelled')
    expect(result.failure).toMatchObject({ class: 'cancelled', code: 'CANCELLED', message: 'first cancellation' })
  })
})

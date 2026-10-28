import { describe, expect, it } from 'vitest'
import { toManifest, redactError } from '../src/runtime/result-manifest.js'
import type { TaskRecord } from '../src/runtime/task-state.js'

describe('result manifest privacy', () => {
  it('stores relative outputs and no reference source path', () => {
    const task: TaskRecord = {
      taskId: 'task-1234', contractHash: 'contract', executionId: 'execution', mode: 'edit', status: 'completed', createdAtUtc: '2026-01-01T00:00:00.000Z',
      originalPrompt: 'edit', expandedPrompt: 'expanded', references: [{ sha256: 'abc', imageTag: '<image1>', width: 10, height: 20 }],
      targetWidth: 10, targetHeight: 20, sampleWidth: 16, sampleHeight: 32, sizeSource: 'reference:1-default', outpaintingRequired: false,
      acceleration: 'balanced', steps: 40, technicalAttempts: 1, qualityCycle: 0, qualityReworkOccurred: false,
      outputs: [{ path: 'E:\\private\\image-1.png', relativePath: 'image-1.png', width: 10, height: 20, seed: 1, sha256: 'out', executionId: 'execution', adopted: true }],
      candidates: [], comfyStartedByPlugin: true, comfyModelsUnloaded: true, strataRestored: true,
      cleanup: { complete: true, temporaryInputsRemoved: true, workflowRemoved: true, queueStateRemoved: true, residualItems: [] },
    }
    const manifest = toManifest(task, 'workflow')
    expect(JSON.stringify(manifest)).not.toContain('E:\\private')
    expect(manifest.outputs[0]?.relative_path).toBe('image-1.png')
    expect(manifest.references[0]).toEqual({ sha256: 'abc', image_tag: '<image1>', width: 10, height: 20 })
  })
  it('redacts local paths and bearer credentials from failures', () => {
    expect(redactError('C:\\Users\\alice\\secret.txt Bearer abcdefgh')).not.toContain('alice')
    expect(redactError('C:\\Users\\alice\\secret.txt Bearer abcdefgh')).not.toContain('abcdefgh')
  })
})

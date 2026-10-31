import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPublicResult } from '../src/runtime/public-result.js'
import type { ResultManifest } from '../src/runtime/result-manifest.js'

function manifest(relativePath = 'image-1.png'): ResultManifest {
  return {
    schema_version: 1,
    plugin_version: '3.0.0',
    embedded_skill_version: '3.0.0',
    workflow: { version: 'workflow', sha256: 'workflow-hash' },
    task_id: 'task-1234',
    contract_hash: 'contract',
    execution_id: 'execution',
    task_mode: 'edit',
    status: 'completed',
    created_at_utc: '2026-10-29T00:00:00.000Z',
    completed_at_utc: '2026-10-29T00:01:00.000Z',
    prompts: { original: 'edit', expanded: 'expanded edit' },
    references: [],
    canvas: { target_width: 16, target_height: 16, sample_width: 16, sample_height: 16, size_source: 'explicit' },
    generation: { acceleration: 'balanced', steps: 40, technical_attempts: 1 },
    quality: { rework_occurred: false, rework_rounds: 0 },
    outputs: [{ relative_path: relativePath, width: 16, height: 16, seed: 7, sha256: 'output-hash' }],
    candidates: [],
    lifecycle: { comfy_started_by_plugin: true, comfy_models_unloaded: true, strata_restored: true },
    cleanup: { complete: true, temporary_inputs_removed: true, workflow_removed: true, queue_state_removed: true, residual_items: [] },
    failure: null,
  }
}

describe('public fish-draws result', () => {
  it('adds directly usable absolute image and output paths without changing the persisted manifest', () => {
    const taskDirectory = resolve('E:\\ComfyUI\\output\\fish-draws\\2026-10-29\\task-1234')
    const source = manifest()
    const result = buildPublicResult(source, taskDirectory)
    const expected = resolve(taskDirectory, 'image-1.png')
    expect(result.images).toEqual([expected])
    expect(result.outputs[0]).toMatchObject({ path: expected, relative_path: 'image-1.png', width: 16, height: 16, seed: 7 })
    expect(source.outputs[0]).not.toHaveProperty('path')
  })

  it('rejects a manifest output that escapes the task directory', () => {
    expect(() => buildPublicResult(manifest('../outside.png'), resolve('E:\\ComfyUI\\output\\fish-draws\\task-1234'))).toThrow(/escaped/u)
  })
})

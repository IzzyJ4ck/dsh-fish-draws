import { deflateSync } from 'node:zlib'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import type { ResultManifest } from '../src/runtime/result-manifest.js'
import { writeManifestAtomic } from '../src/runtime/result-manifest.js'
import { FishDrawsService } from '../src/service.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function png(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const chunk = (type: string, data: Buffer) => Buffer.concat([Buffer.from([(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255]), Buffer.from(type), data, Buffer.alloc(4)])
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  const rows = Buffer.alloc((width * 4 + 1) * height)
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

async function fixture(options: { mixedExecutions?: boolean; retainAll?: boolean } = {}): Promise<{ service: FishDrawsService; taskDirectory: string; manifestPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'fish-finalize-')); roots.push(root)
  const outputRoot = join(root, 'output'); const taskDirectory = join(outputRoot, 'fish-draws', '2026-10-30', 'selection-task')
  const candidateDirectory = join(taskDirectory, 'candidates'); await mkdir(candidateDirectory, { recursive: true })
  const first = 'candidates/rework-01-image-01-seed-11.png'; const second = 'candidates/rework-02-image-02-seed-22.png'
  await writeFile(join(taskDirectory, first), png(16, 16)); await writeFile(join(taskDirectory, second), png(16, 16))
  const manifest: ResultManifest = {
    schema_version: 1, plugin_version: '3.0.0', embedded_skill_version: '3.0.0', workflow: { version: 'workflow', sha256: 'hash' },
    task_id: 'selection-task', contract_hash: 'contract', execution_id: 'latest-execution', task_mode: 't2i', status: 'awaiting_selection',
    created_at_utc: '2026-10-30T00:00:00.000Z', completed_at_utc: '2026-10-30T00:02:00.000Z', prompts: { original: 'fixture', expanded: 'fixture' }, references: [],
    canvas: { target_width: 16, target_height: 16, sample_width: 16, sample_height: 16, size_source: 'explicit' }, generation: { acceleration: 'balanced', steps: 40, technical_attempts: 1 },
    quality: { rework_occurred: true, rework_rounds: 2 }, outputs: [],
    candidates: [
      { relative_path: first, width: 16, height: 16, seed: 11, sha256: 'first', execution_id: 'candidate-execution', adopted: false, quality_cycle: 1, candidate_kind: 'rework', candidate_index: 1 },
      { relative_path: second, width: 16, height: 16, seed: 22, sha256: 'second', execution_id: options.mixedExecutions === true ? 'other-execution' : 'candidate-execution', adopted: false, quality_cycle: 2, candidate_kind: 'rework', candidate_index: 2 },
    ],
    lifecycle: { comfy_started_by_plugin: false, comfy_models_unloaded: true, strata_restored: true }, cleanup: { complete: true, temporary_inputs_removed: true, workflow_removed: true, queue_state_removed: true, residual_items: [] }, failure: null,
  }
  const manifestPath = join(taskDirectory, 'result.json'); await writeManifestAtomic(manifestPath, manifest)
  const ctx = new Context(); ctx.provide('credentials', { resolve: async () => undefined })
  const service = new FishDrawsService(ctx, resolveConfig({ comfy: { root: join(root, 'comfy') }, storage: { outputRoot, retainAllSuccessfulCandidates: options.retainAll ?? false }, strata: { handoffEnabled: false } }), join(root, 'runtime'))
  return { service, taskDirectory, manifestPath }
}

describe('awaiting-selection finalization', () => {
  it('uses a zero-based per-execution output index and records the adopted execution', async () => {
    const { service, taskDirectory, manifestPath } = await fixture()
    const result = await service.finalize('selection-task', 'adopt', [{ execution_id: 'candidate-execution', output_index: 1 }])
    expect(result.status).toBe('completed')
    expect(result.execution_id).toBe('latest-execution')
    expect(result.quality.adopted_execution_id).toBe('candidate-execution')
    expect(result.outputs).toHaveLength(1); expect(result.outputs[0]).toMatchObject({ relative_path: 'image-1.png', seed: 22, width: 16, height: 16 })
    expect(result.candidates).toEqual([])
    await expect(access(join(taskDirectory, 'image-1.png'))).resolves.toBeUndefined()
    await expect(access(join(taskDirectory, 'candidates'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((JSON.parse(await readFile(manifestPath, 'utf8')) as ResultManifest).quality.adopted_execution_id).toBe('candidate-execution')
  })

  it('rejects negative and out-of-range zero-based indexes', async () => {
    const negative = await fixture()
    await expect(negative.service.finalize('selection-task', 'adopt', [{ execution_id: 'candidate-execution', output_index: -1 }])).rejects.toMatchObject({ code: 'INVALID_SELECTION_INDEX' })
    const outOfRange = await fixture()
    await expect(outOfRange.service.finalize('selection-task', 'adopt', [{ execution_id: 'candidate-execution', output_index: 2 }])).rejects.toMatchObject({ code: 'INVALID_SELECTION' })
  })

  it('rejects combining candidates from different executions under one adopted execution id', async () => {
    const { service } = await fixture({ mixedExecutions: true })
    await expect(service.finalize('selection-task', 'adopt', [
      { execution_id: 'candidate-execution', output_index: 0 },
      { execution_id: 'other-execution', output_index: 0 },
    ])).rejects.toMatchObject({ code: 'MIXED_SELECTION_EXECUTIONS' })
  })
})

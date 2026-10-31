import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveConfig } from '../src/config.js'
import { FishDrawsService } from '../src/service.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function serviceFixture(): Promise<{ service: FishDrawsService; runtimeRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'fish-draws-preflight-'))
  roots.push(root)
  const ctx = new Context()
  ctx.provide('credentials', { resolve: async () => undefined })
  const runtimeRoot = join(root, 'runtime')
  return {
    service: new FishDrawsService(ctx, resolveConfig({
      comfy: { root: join(root, 'comfy') },
      storage: { outputRoot: join(root, 'output') },
      strata: { handoffEnabled: false },
    }), runtimeRoot),
    runtimeRoot,
  }
}

describe('FishDrawsService T2I preflight regression', () => {
  it('creates a collision-free task ID when a new task omits task_id', async () => {
    const { service } = await serviceFixture()
    const first = await service.preflight({
      mode: 't2i', original_prompt: 'first fixture', references: [], aspect_ratio: '1:1',
    }, {} as Agent)
    const second = await service.preflight({
      mode: 't2i', original_prompt: 'second fixture', references: [], aspect_ratio: '1:1',
    }, {} as Agent)
    expect(first.task_id).toMatch(/^fish-[a-z0-9]+-[0-9a-f]{8}$/u)
    expect(second.task_id).toMatch(/^fish-[a-z0-9]+-[0-9a-f]{8}$/u)
    expect(second.task_id).not.toBe(first.task_id)
  })

  it('accepts references=[] without content_canvas_index at exact 1920x1080', async () => {
    const { service } = await serviceFixture()
    const result = await service.preflight({
      task_id: 't2i-regression-001',
      mode: 't2i',
      original_prompt: 'regression fixture',
      references: [],
      target_width: 1920,
      target_height: 1080,
      acceleration: 'balanced',
      count: 1,
    }, {} as Agent)
    expect(result).toMatchObject({
      mode: 't2i',
      references: [],
      target_width: 1920,
      target_height: 1080,
      sample_width: 1920,
      sample_height: 1088,
    })
  })

  it('rejects references before resolving them for T2I', async () => {
    const { service } = await serviceFixture()
    await expect(service.preflight({
      task_id: 't2i-regression-002',
      mode: 't2i',
      original_prompt: 'regression fixture',
      references: [{ kind: 'workspace_file', relative_path: 'unexpected.png' }],
      target_width: 1920,
      target_height: 1080,
    }, {} as Agent)).rejects.toThrow(/does not accept reference images/u)
  })

  it('keeps pending preflights in memory instead of leaving host paths on disk', async () => {
    const { service, runtimeRoot } = await serviceFixture()
    await service.preflight({
      task_id: 'memory-preflight-001', mode: 't2i', original_prompt: 'fixture', references: [], aspect_ratio: '1:1',
    }, {} as Agent)

    await expect(access(join(runtimeRoot, 'preflight'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes legacy persisted preflights during lifecycle recovery', async () => {
    const { service, runtimeRoot } = await serviceFixture()
    const legacy = join(runtimeRoot, 'preflight', 'legacy-task.json')
    await mkdir(join(runtimeRoot, 'preflight'), { recursive: true })
    await writeFile(legacy, '{"legacy":true}')

    await service.recoverLifecycle()

    await expect(access(join(runtimeRoot, 'preflight'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

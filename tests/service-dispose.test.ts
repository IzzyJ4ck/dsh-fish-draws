import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { FishDrawsService } from '../src/service.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('Host disposal convergence', () => {
  it('cancels active work, waits for its cleanup, settles diagnostics, then stops only owned ComfyUI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fish-dispose-')); roots.push(root)
    const ctx = new Context(); ctx.provide('credentials', { resolve: async () => undefined })
    const service = new FishDrawsService(ctx, resolveConfig({ storage: { outputRoot: root }, strata: { handoffEnabled: false } }), join(root, 'runtime'))
    const controller = new AbortController(); const events: string[] = []
    const done = new Promise<void>(resolve => controller.signal.addEventListener('abort', () => { events.push('aborted'); resolve() }, { once: true }))
    ;(service as any).activeExecution = { taskId: 'fish-active', controller, done }
    ;(service as any).executor = { cancel: (taskId: string) => events.push(`cancel:${taskId}`) }
    ;(service as any).diagnosticsRunner = {
      active: true, activeRun: { runId: 'diag-active' },
      settle: async (runId: string, value: { status: string }) => { events.push(`diagnostic:${runId}:${value.status}`) },
    }
    ;(service as any).lifecycle = { stopOwned: async () => { expect(controller.signal.aborted).toBe(true); events.push('stopped') } }

    await service.dispose()
    expect(events).toEqual(['aborted', 'cancel:fish-active', 'diagnostic:diag-active:cancelled', 'stopped'])
  })
})

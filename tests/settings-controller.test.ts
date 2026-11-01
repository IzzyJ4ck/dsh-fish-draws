import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { FishDrawsSettingsController } from '../src/settings-remote/controller.js'

function serviceFixture(ownership: 'plugin-owned-live-handle' | 'user-or-external' | 'stale-owner-record', overrides: Record<string, unknown> = {}) {
  return {
    lifecycle: {
      ownership,
      client: { queueState: async () => ({ running: 0, pending: 0, idle: true }), online: async () => undefined },
      unloadModels: async () => true,
      stopOwned: async () => undefined,
    },
    activeTaskId: undefined,
    diagnosticsRunner: { active: false, activeRun: undefined, lastRunId: undefined },
    strataReleased: false,
    ...overrides,
  }
}

describe('settings ComfyUI stop safety', () => {
  it.each(['user-or-external', 'stale-owner-record'] as const)('refuses to stop %s instances', async ownership => {
    const controller = new FishDrawsSettingsController(new Context(), serviceFixture(ownership) as any)
    await expect(controller.prepareComfyStop()).resolves.toMatchObject({ allowed: false, ownership })
  })

  it('issues a short-lived nonce only for a live plugin-owned handle', async () => {
    const controller = new FishDrawsSettingsController(new Context(), serviceFixture('plugin-owned-live-handle') as any)
    const prepared = await controller.prepareComfyStop()
    expect(prepared.allowed).toBe(true)
    expect(prepared.nonce).toMatch(/^[A-Za-z0-9_-]+$/u)
    await expect(controller.stopComfy({ nonce: 'wrong' })).resolves.toMatchObject({ ok: false, code: 'STOP_NONCE_INVALID' })
  })

  it('refuses stop preparation while a task, diagnostic, queue item, or released Strata is active', async () => {
    const service = serviceFixture('plugin-owned-live-handle', {
      activeTaskId: 'fish-active', strataReleased: true,
      diagnosticsRunner: { active: true, activeRun: { runId: 'diag-active' }, lastRunId: 'diag-active' },
    }) as any
    service.lifecycle.client.queueState = async () => ({ running: 1, pending: 2, idle: false })
    const controller = new FishDrawsSettingsController(new Context(), service)
    const prepared = await controller.prepareComfyStop()
    expect(prepared.allowed).toBe(false)
    expect(prepared.blockers.join('\n')).toMatch(/job is active/u)
    expect(prepared.blockers.join('\n')).toMatch(/diagnostic run is active/u)
    expect(prepared.blockers.join('\n')).toMatch(/Strata has not been restored/u)
    expect(prepared.blockers.join('\n')).toMatch(/queue is not empty/u)
  })

  it('converts a stop failure into a structured result instead of throwing from the Host', async () => {
    const service = serviceFixture('plugin-owned-live-handle') as any
    service.lifecycle.stopOwned = async () => { throw new Error('termination failed') }
    const controller = new FishDrawsSettingsController(new Context(), service)
    const prepared = await controller.prepareComfyStop()
    await expect(controller.stopComfy({ nonce: prepared.nonce! })).resolves.toMatchObject({ ok: false, code: 'INTERNAL', message: 'termination failed' })
  })
})

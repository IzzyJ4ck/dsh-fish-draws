// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Input: (props: any) => <input {...props} />,
  Switch: ({ checked, onChange, label }: any) => <button aria-pressed={checked} onClick={() => onChange(!checked)}>{label}</button>,
  SegmentedTabs: ({ items, onChange }: any) => <nav>{items.map((item: any) => <button key={item.value} onClick={() => onChange(item.value)}>{item.label}</button>)}</nav>,
}))

import { FishDrawsSettings } from '../src/client/FishDrawsSettings.js'
import { apply as applyClient, inject as clientInject } from '../src/client/index.js'
import { legacyModelProfile, type ConfigValues } from '../src/config.js'

function fixture(locale = 'en-US') {
  const profile = legacyModelProfile({}, {})
  const value: ConfigValues = {
    comfy: { root: 'E:\\ComfyUI\\ComfyUI', apiUrl: 'http://127.0.0.1:8188', autoStart: true, idleShutdownMs: 600000, startupTimeoutMs: 180000 },
    storage: { outputRoot: 'E:\\ComfyUI\\ComfyUI\\output' }, modelProfiles: [profile], currentModelProfileId: profile.id,
    models: profile.files, safety: profile.safety, strata: { handoffEnabled: true, vramEndpoint: 'http://127.0.0.1:8000', authMode: 'bearer', credentialRef: 'FISH_DRAWS_STRATA_API_KEY' }, diagnostics: { localModelRoutes: [] },
  }
  let listener = () => undefined
  const snapshot = { status: 'ready', value, revision: 1, writable: true } as const
  const form = { subscribe: (next: () => void) => { listener = next; return () => undefined }, getSnapshot: () => snapshot, mutate: vi.fn(async () => true) }
  const ok = (result: unknown) => Promise.resolve({ ok: true, value: result })
  const ctx = {
    locale: { getSnapshot: () => ({ active: locale }) },
    remote: {
      fishDrawsSettings: { overview: () => ok({ pluginVersion: '3.1.0', comfyOnline: false, comfyOwnership: 'offline', diagnosticActive: false, strataReleased: false, currentModelProfileId: profile.id, currentModelProfileName: profile.name, currentModelProfileHash: 'x', deprecatedPromptEndpointConfigured: false }) },
      credentials: { describe: () => ok({}), set: () => ok(undefined), unset: () => ok(undefined) }, session: {},
    },
  }
  return { form, ctx, listener }
}

describe('fish-draws settings client', () => {
  afterEach(() => cleanup())
  beforeEach(() => { vi.restoreAllMocks() })
  it('renders four settings tabs and keeps Host paths as ordinary validated inputs', async () => {
    const { form, ctx } = fixture()
    render(<FishDrawsSettings ctx={ctx as any} form={form as any} close={() => undefined} />)
    expect(await screen.findByText('ComfyUI')).toBeTruthy()
    expect(screen.getByText('Image model')).toBeTruthy()
    expect(screen.getByText('DSH & Strata')).toBeTruthy()
    expect(screen.getByText('Diagnostics')).toBeTruthy()
    expect(screen.getByDisplayValue('E:\\ComfyUI\\ComfyUI')).toBeTruthy()
  })

  it('does not allow deleting the current profile from the model tab', async () => {
    const { form, ctx } = fixture()
    render(<FishDrawsSettings ctx={ctx as any} form={form as any} close={() => undefined} />)
    fireEvent.click(screen.getByText('Image model'))
    expect((await screen.findByText('Delete') as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders the settings controls in Chinese when the DSH locale is Chinese', async () => {
    const { form, ctx } = fixture('zh-CN')
    render(<FishDrawsSettings ctx={ctx as any} form={form as any} close={() => undefined} />)
    expect(await screen.findByText('ComfyUI 根目录')).toBeTruthy()
    expect(screen.getByText('检查连接')).toBeTruthy()
    fireEvent.click(screen.getByText('生图模型'))
    expect(await screen.findByText('设为当前')).toBeTruthy()
  })

  it('mounts its generated Remote contribution before registering the settings section', async () => {
    const { form } = fixture()
    const disposers: Array<() => void | Promise<void>> = []
    const remoteDispose = vi.fn()
    const register = vi.fn(() => vi.fn())
    const mount = vi.fn(async (contribution: any) => {
      expect(contribution.package).toBe('@izzyj4ck/dsh-fish-draws')
      expect(contribution.descriptors).toHaveLength(14)
      return remoteDispose
    })
    const ctx: any = {
      remote: { $mount: mount },
      effect: (factory: () => void | (() => void | Promise<void>)) => { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) },
      locale: { register: () => vi.fn(), getSnapshot: () => ({ active: 'en-US' }) },
      configForms: { get: () => form, whileServed: (_names: string[], callback: () => unknown) => callback() },
      slots: { inject: (_name: string, callback: () => unknown) => callback(), register },
    }
    expect(clientInject).not.toContain('remote.fishDrawsSettings')
    await applyClient(ctx)
    expect(mount).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledOnce()
    for (const dispose of disposers.reverse()) await dispose()
    expect(remoteDispose).toHaveBeenCalledOnce()
  })
})

import { describe, expect, it } from 'vitest'
import { Config, hashLegacyMirror, legacyModelProfile, resolveConfig } from '../src/config.js'

describe('public v1 endpoint boundary', () => {
  it('activates the Settings schema with top-level volatile fields on Schemastery 3.18', () => {
    const runtime = Config({})
    expect(runtime.configSchemaVersion.get()).toBe(2)
    expect(runtime.comfy.get()).toMatchObject({ apiUrl: 'http://127.0.0.1:8188', autoStart: true })
    expect(runtime.modelProfiles.get()).toEqual([])
  })

  it('accepts a 3.0-shaped profile patch before the 3.1 migration runs', () => {
    const runtime = Config({
      comfy: { root: 'E:\\ComfyUI\\ComfyUI', apiUrl: 'http://127.0.0.1:8188' },
      models: { unetName: 'model.gguf', clipName: 'clip.safetensors', vaeName: 'vae.safetensors' },
      strata: { vramEndpoint: 'http://127.0.0.1:8000', credentialRef: 'FISH_DRAWS_STRATA_API_KEY', reserveMiB: 21_504 },
      safety: { t2iBalanced: { maxSampleWidth: 2560, maxSampleHeight: 2560, maxSamplePixels: 3_686_400, reserveMiB: 21_504, approvalSource: 'user_override' } },
    })
    const resolved = resolveConfig(runtime)
    expect(resolved.migrationRequired).toBe(true)
    expect(resolved.currentModelProfile.files.unetName).toBe('model.gguf')
  })

  it('accepts loopback and rejects remote ComfyUI/Strata URLs', () => {
    expect(resolveConfig({ comfy: { apiUrl: 'http://127.0.0.1:8188' } }).comfy.apiUrl.hostname).toBe('127.0.0.1')
    expect(() => resolveConfig({ comfy: { apiUrl: 'http://192.168.1.2:8188' } })).toThrow(/loopback/u)
    expect(() => resolveConfig({ strata: { vramEndpoint: 'http://example.com:8000' } })).toThrow(/loopback/u)
  })
  it('uses conservative defaults while accepting explicit high-resolution overrides', () => {
    const defaults = resolveConfig().safety['edit-single-balanced']
    expect(defaults.maxSamplePixels).toBe(2_400_000)
    expect(defaults.reserveMiB).toBe(21_504)
    const local = resolveConfig({ safety: { editSingleBalanced: { maxSampleWidth: 2560, maxSampleHeight: 2560, maxSamplePixels: 3_686_400, approvalSource: 'user_override' } } }).safety['edit-single-balanced']
    expect(local).toMatchObject({ maxSampleWidth: 2560, maxSamplePixels: 3_686_400, reserveMiB: 21_504, approvalSource: 'user_override' })
  })

  it('resolves a selected model profile and keeps each safety class isolated', () => {
    const first = legacyModelProfile({}, {})
    const second = { ...legacyModelProfile({}, {}), id: 'second', name: 'Second', files: { ...first.files, unetName: 'second.gguf' }, safety: { ...first.safety, editSingleBalanced: { maxSampleWidth: 2560, maxSampleHeight: 2560, maxSamplePixels: 3_686_400, reserveMiB: 22_000, approvalSource: 'user_override' as const } } }
    const value = resolveConfig({ modelProfiles: [first, second], currentModelProfileId: 'second' })
    expect(value.models.unetName).toBe('second.gguf')
    expect(value.safety['edit-single-balanced']).toMatchObject({ maxSampleWidth: 2560, reserveMiB: 22_000 })
    expect(value.safety['t2i-balanced'].maxSampleWidth).toBe(2048)
  })

  it('rejects duplicate profiles, traversal and missing bearer references', () => {
    const profile = legacyModelProfile({}, {})
    expect(() => resolveConfig({ modelProfiles: [profile, profile], currentModelProfileId: profile.id })).toThrow(/unique/u)
    expect(() => resolveConfig({ modelProfiles: [{ ...profile, files: { ...profile.files, unetName: '../escape.gguf' } }], currentModelProfileId: profile.id })).toThrow(/traversal/u)
    expect(() => resolveConfig({ strata: { authMode: 'bearer', credentialRef: '' } })).toThrow(/credentialRef/u)
    expect(resolveConfig({ strata: { authMode: 'none', credentialRef: '' } }).strata.authMode).toBe('none')
  })

  it('detects a legacy compatibility mirror changed during a 3.0 rollback', () => {
    const profile = legacyModelProfile({}, {})
    const originalModels = { ...profile.files }
    const originalSafety = { ...profile.safety }
    const stable = resolveConfig({ modelProfiles: [profile], currentModelProfileId: profile.id, models: originalModels, safety: originalSafety, migration: { legacyMirrorHash: hashLegacyMirror(originalModels, originalSafety) } })
    expect(stable.rollbackMirrorChanged).toBe(false)
    const changed = resolveConfig({ modelProfiles: [profile], currentModelProfileId: profile.id, models: { ...originalModels, unetName: 'rollback.gguf' }, safety: originalSafety, migration: { legacyMirrorHash: stable.legacyMirrorHash } })
    expect(changed.rollbackMirrorChanged).toBe(true)
    expect(changed.legacyMirror.models.unetName).toBe('rollback.gguf')
  })
})

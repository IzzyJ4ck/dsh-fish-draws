import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'

describe('public v1 endpoint boundary', () => {
  it('accepts loopback and rejects remote ComfyUI/Strata URLs', () => {
    expect(resolveConfig({ comfy: { apiUrl: 'http://127.0.0.1:8188' } }).comfy.apiUrl.hostname).toBe('127.0.0.1')
    expect(() => resolveConfig({ comfy: { apiUrl: 'http://192.168.1.2:8188' } })).toThrow(/loopback/u)
    expect(() => resolveConfig({ strata: { vramEndpoint: 'http://example.com:8000' } })).toThrow(/loopback/u)
  })
  it('uses conservative defaults while accepting explicit high-resolution overrides', () => {
    const defaults = resolveConfig().safety['edit-single-balanced']
    expect(defaults.maxSamplePixels).toBe(2_400_000)
    const local = resolveConfig({ safety: { editSingleBalanced: { maxSampleWidth: 2560, maxSampleHeight: 2560, maxSamplePixels: 3_686_400, approvalSource: 'user_override' } } }).safety['edit-single-balanced']
    expect(local).toMatchObject({ maxSampleWidth: 2560, maxSamplePixels: 3_686_400, approvalSource: 'user_override' })
  })
})

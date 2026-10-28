import { describe, expect, it } from 'vitest'
import { resolveCanvas, canvasWithinProfile, safetyProfileName } from '../src/runtime/size-resolver.js'

describe('canvas resolution', () => {
  it('uses exact output dimensions and a 16-aligned sample canvas', () => {
    expect(resolveCanvas({ mode: 'edit', references: [{ width: 800, height: 600 }], targetWidth: 1001, targetHeight: 701 }))
      .toMatchObject({ targetWidth: 1001, targetHeight: 701, sampleWidth: 1008, sampleHeight: 704, sizeSource: 'explicit', outpaintingRequired: true })
  })
  it('maps supported ratios and rejects table-external ratios', () => {
    expect(resolveCanvas({ mode: 't2i', references: [], aspectRatio: '16:9' })).toMatchObject({ targetWidth: 1920, targetHeight: 1080 })
    expect(() => resolveCanvas({ mode: 't2i', references: [], aspectRatio: '5:2' })).toThrow(/provide exact dimensions/u)
  })
  it('defaults edit output to reference one original dimensions', () => {
    expect(resolveCanvas({ mode: 'edit', references: [{ width: 1234, height: 777 }] })).toMatchObject({ targetWidth: 1234, targetHeight: 777, sampleWidth: 1248, sampleHeight: 784 })
  })
  it('checks the configured sample safety profile', () => {
    const canvas = resolveCanvas({ mode: 't2i', references: [], targetWidth: 2560, targetHeight: 1440 })
    expect(canvasWithinProfile(canvas, { maxSampleWidth: 2048, maxSampleHeight: 2048, maxSamplePixels: 2_400_000, reserveMiB: 21_504, approvalSource: 'bundled' })).toBe(false)
    expect(canvasWithinProfile(canvas, { maxSampleWidth: 2560, maxSampleHeight: 2560, maxSamplePixels: 3_686_400, reserveMiB: 21_504, approvalSource: 'user_override' })).toBe(true)
  })
  it('selects independent T2I, single-edit, multi-edit and Fast profiles', () => {
    expect(safetyProfileName('t2i', 0, 'balanced', 1)).toBe('t2i-balanced')
    expect(safetyProfileName('edit', 1, 'balanced', 1)).toBe('edit-single-balanced')
    expect(safetyProfileName('edit', 2, 'balanced', 1)).toBe('edit-multi-balanced')
    expect(safetyProfileName('edit', 1, 'fast', 1)).toBe('fast-batch')
    expect(safetyProfileName('t2i', 0, 'balanced', 4)).toBe('fast-batch')
  })
})

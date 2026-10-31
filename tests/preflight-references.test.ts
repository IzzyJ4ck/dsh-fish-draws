import { describe, expect, it } from 'vitest'
import { planPreflightReferences } from '../src/runtime/preflight-references.js'
import { resolveCanvas } from '../src/runtime/size-resolver.js'
import type { ResolvedReference } from '../src/runtime/task-state.js'

function reference(name: string, width = 800, height = 600): ResolvedReference {
  return { path: `C:\\fixtures\\${name}.png`, sha256: name.padEnd(64, '0'), width, height, imageTag: '<unassigned>' }
}

describe('preflight reference planning', () => {
  it('accepts T2I with no references and no edit-only indices', () => {
    expect(planPreflightReferences('t2i', [])).toEqual({ references: [] })
  })

  it('completes exact 1920x1080 T2I canvas preflight', () => {
    const planned = planPreflightReferences('t2i', [])
    expect(resolveCanvas({ mode: 't2i', references: planned.references, targetWidth: 1920, targetHeight: 1080 }))
      .toMatchObject({ targetWidth: 1920, targetHeight: 1080, sampleWidth: 1920, sampleHeight: 1088, sizeSource: 'explicit' })
  })

  it('defaults a single-image edit content canvas to the first image', () => {
    const first = reference('first', 1234, 777)
    const planned = planPreflightReferences('edit', [first])
    expect(planned.references).toHaveLength(1)
    expect(planned.references[0]).toMatchObject({ path: first.path, imageTag: '<image1>' })
    expect(resolveCanvas({ mode: 'edit', references: planned.references })).toMatchObject({ targetWidth: 1234, targetHeight: 777 })
  })

  it.each([-1, 1])('rejects edit content_canvas_index=%s outside a one-image input', index => {
    expect(() => planPreflightReferences('edit', [reference('first')], index)).toThrow(/content canvas index is outside/u)
  })

  it('rejects reference images and edit-only indices for T2I', () => {
    expect(() => planPreflightReferences('t2i', [reference('unexpected')])).toThrow(/does not accept reference/u)
    expect(() => planPreflightReferences('t2i', [], 0)).toThrow(/only valid for editing/u)
    expect(() => planPreflightReferences('t2i', [], undefined, 0)).toThrow(/only valid for editing/u)
  })

  it('validates size_reference_index before reordering and preserves upload-order meaning', () => {
    const first = reference('first', 800, 600)
    const second = reference('second', 1600, 900)
    const planned = planPreflightReferences('edit', [first, second], 1, 0)
    expect(planned.references.map(value => value.path)).toEqual([second.path, first.path])
    expect(planned.sizeReferenceIndex).toBe(1)
    expect(resolveCanvas({ mode: 'edit', references: planned.references, sizeReferenceIndex: planned.sizeReferenceIndex }))
      .toMatchObject({ targetWidth: 800, targetHeight: 600 })
    expect(() => planPreflightReferences('edit', [first], 0, -1)).toThrow(/size reference index is outside/u)
    expect(() => planPreflightReferences('edit', [first], 0, 1)).toThrow(/size reference index is outside/u)
  })
})

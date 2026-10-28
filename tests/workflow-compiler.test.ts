import { describe, expect, it } from 'vitest'
import { compileWorkflow, loadWorkflowTemplate } from '../src/runtime/workflow-compiler.js'
import { resolveConfig } from '../src/config.js'

describe('fixed workflow compiler', () => {
  it('keeps exact custom latent and crop isolated from 1MP reference preprocessing', async () => {
    const template = await loadWorkflowTemplate(new URL('../assets/qwen21-unified-api.json', import.meta.url))
    const graph = compileWorkflow(template, resolveConfig({ comfy: { root: 'E:\\ComfyUI\\ComfyUI' } }), {
      prompt: 'test', inputImageNames: ['fish-draws/task/input-1.png'], targetWidth: 1001, targetHeight: 701,
      sampleWidth: 1008, sampleHeight: 704, seed: 9, steps: 40, acceleration: 'balanced', filenamePrefix: 'fish-draws-staging/task/run/image-1',
    })
    expect(graph['6']?.inputs.resolution).toBe(0)
    expect(graph['7']?.inputs).toMatchObject({ width: 1008, height: 704, batch_size: 1 })
    expect(graph['8']?.inputs.latent_image).toEqual(['7', 0])
    expect(graph['10']?.inputs).toMatchObject({ width: 1001, height: 701, x: 3, y: 1 })
    expect(graph['101']?.inputs.megapixels).toBe(1)
    expect(graph['6']?.inputs['images.image_1']).toEqual(['101', 0])
    expect(Object.values(graph).some(node => node.class_type === 'ResolutionSelector')).toBe(false)
  })
  it('adds EasyCache only in fast mode', async () => {
    const template = await loadWorkflowTemplate(new URL('../assets/qwen21-unified-api.json', import.meta.url))
    const config = resolveConfig({ comfy: { root: 'E:\\ComfyUI\\ComfyUI' } })
    const base = { prompt: 'x', inputImageNames: [], targetWidth: 512, targetHeight: 512, sampleWidth: 512, sampleHeight: 512, seed: 1, steps: 25, filenamePrefix: 'x' }
    expect(compileWorkflow(template, config, { ...base, acceleration: 'balanced' })['12']).toBeUndefined()
    expect(compileWorkflow(template, config, { ...base, acceleration: 'fast' })['12']?.class_type).toBe('EasyCache')
  })
  it('compiles zero through six references without changing the sampler latent source', async () => {
    const template = await loadWorkflowTemplate(new URL('../assets/qwen21-unified-api.json', import.meta.url))
    const config = resolveConfig({ comfy: { root: 'E:\\ComfyUI\\ComfyUI' } })
    for (const count of [0, 1, 2, 6]) {
      const graph = compileWorkflow(template, config, { prompt: 'x', inputImageNames: Array.from({ length: count }, (_, index) => `input-${index + 1}.png`), targetWidth: 512, targetHeight: 512, sampleWidth: 512, sampleHeight: 512, seed: 1, steps: 40, acceleration: 'balanced', filenamePrefix: 'x' })
      expect(graph['8']?.inputs.latent_image).toEqual(['7', 0])
      expect(Object.values(graph).filter(node => node.class_type === 'LoadImage')).toHaveLength(count)
      expect(Object.values(graph).filter(node => node.class_type === 'ImageScaleToTotalPixels')).toHaveLength(count)
    }
  })
})

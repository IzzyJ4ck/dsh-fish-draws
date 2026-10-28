import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ResolvedConfig } from '../config.js'
import { FishDrawsError } from '../errors.js'
import type { Acceleration } from './size-resolver.js'

type Link = [string, number]
type Node = { inputs: Record<string, unknown>; class_type: string; _meta?: { title?: string } }
export type WorkflowGraph = Record<string, Node>

export interface CompileWorkflowInput {
  prompt: string
  inputImageNames: readonly string[]
  targetWidth: number
  targetHeight: number
  sampleWidth: number
  sampleHeight: number
  seed: number
  steps: number
  acceleration: Acceleration
  filenamePrefix: string
}

export interface WorkflowTemplate {
  graph: WorkflowGraph
  sha256: string
}

export async function loadWorkflowTemplate(url = new URL('../assets/workflows/qwen21-unified-api.json', import.meta.url)): Promise<WorkflowTemplate> {
  const bytes = await readFile(url)
  const graph = JSON.parse(bytes.toString('utf8')) as WorkflowGraph
  for (const id of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']) {
    if (graph[id] === undefined) throw new FishDrawsError(`workflow template is missing node ${id}`, 'INVALID_WORKFLOW_TEMPLATE', 'preflight')
  }
  if (Object.values(graph).some(node => ['ResolutionSelector', 'FastBypasser', 'GroupsMuter'].includes(node.class_type))) {
    throw new FishDrawsError('workflow template contains forbidden UI-only nodes', 'INVALID_WORKFLOW_TEMPLATE', 'preflight')
  }
  return { graph, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function node(graph: WorkflowGraph, id: string): Node {
  const value = graph[id]
  if (value === undefined) throw new FishDrawsError(`workflow node ${id} is unavailable`, 'INVALID_WORKFLOW_TEMPLATE', 'preflight')
  return value
}

export function compileWorkflow(template: WorkflowTemplate, config: ResolvedConfig, input: CompileWorkflowInput): WorkflowGraph {
  if (input.inputImageNames.length > 6) throw new FishDrawsError('at most six reference images are supported', 'TOO_MANY_REFERENCES', 'preflight')
  const graph = structuredClone(template.graph)
  node(graph, '1').inputs.unet_name = config.models.unetName
  node(graph, '4').inputs.clip_name = config.models.clipName
  node(graph, '5').inputs.vae_name = config.models.vaeName
  node(graph, '6').inputs.prompt = input.prompt
  node(graph, '6').inputs.resolution = 0
  node(graph, '7').inputs.width = input.sampleWidth
  node(graph, '7').inputs.height = input.sampleHeight
  node(graph, '7').inputs.batch_size = 1
  node(graph, '8').inputs.seed = input.seed
  node(graph, '8').inputs.steps = input.steps
  node(graph, '8').inputs.latent_image = ['7', 0] satisfies Link
  node(graph, '10').inputs.width = input.targetWidth
  node(graph, '10').inputs.height = input.targetHeight
  node(graph, '10').inputs.x = Math.floor((input.sampleWidth - input.targetWidth) / 2)
  node(graph, '10').inputs.y = Math.floor((input.sampleHeight - input.targetHeight) / 2)
  node(graph, '11').inputs.filename_prefix = input.filenamePrefix

  if (input.acceleration === 'fast') {
    graph['12'] = {
      inputs: { reuse_threshold: 0.15, start_percent: 0.2, end_percent: 0.95, verbose: false, model: ['3', 0] satisfies Link },
      class_type: 'EasyCache', _meta: { title: 'EasyCache fast mode' },
    }
    node(graph, '8').inputs.model = ['12', 0] satisfies Link
  } else {
    delete graph['12']
    node(graph, '8').inputs.model = ['3', 0] satisfies Link
  }

  input.inputImageNames.forEach((image, index) => {
    const loadId = String(100 + index * 2)
    const scaleId = String(101 + index * 2)
    graph[loadId] = { inputs: { image }, class_type: 'LoadImage', _meta: { title: `Reference image ${index + 1}` } }
    graph[scaleId] = {
      inputs: { upscale_method: 'lanczos', megapixels: 1, resolution_steps: 1, image: [loadId, 0] satisfies Link },
      class_type: 'ImageScaleToTotalPixels', _meta: { title: `Encode reference ${index + 1} at 1MP` },
    }
    node(graph, '6').inputs[`images.image_${index + 1}`] = [scaleId, 0] satisfies Link
  })
  return graph
}

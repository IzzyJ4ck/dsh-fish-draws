import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FishDrawsService, GenerateInput, PreflightInput, ReferenceSelector } from './service.js'
import { buildPublicResult } from './runtime/public-result.js'

const referenceSpec = {
  type: 'object' as const, additionalProperties: false,
  properties: {
    kind: { type: 'string' as const, required: true, enum: ['attachment', 'workspace_file', 'fish_draws_output'] },
    user_turn_offset: { type: 'integer' as const }, image_index: { type: 'integer' as const }, relative_path: { type: 'string' as const },
    execution_id: { type: 'string' as const }, output_index: { type: 'integer' as const, description: 'Zero-based output index within the referenced execution.' },
  },
}
const jsonOutput = { schema: { type: 'object' as const, additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }

function agent(exec: any) { if (exec.agent === undefined) throw new Error('fish-draws tools require an agent session'); return exec.agent }

export function registerTools(ctx: Context, service: FishDrawsService): void {
  ctx.tools.register(defineTool({
    name: 'fish_draws_preflight',
    description: 'Resolve trusted image references, exact canvas size, safety profile, and visual preflight facts. This does not start ComfyUI or change VRAM. Omit task_id for a new task; the Host returns a collision-free ID.',
    parameters: {
      task_id: { type: 'string', description: 'Existing Host-issued task ID, used only to continue a quality-rework cycle. Omit for a new task.' }, mode: { type: 'string', required: true, enum: ['t2i', 'edit'] }, original_prompt: { type: 'string', required: true },
      references: { type: 'array', required: true, items: referenceSpec }, target_width: { type: 'integer' }, target_height: { type: 'integer' },
      aspect_ratio: { type: 'string' }, size_reference_index: { type: 'integer' }, content_canvas_index: { type: 'integer' },
      acceleration: { type: 'string', enum: ['balanced', 'fast'] }, count: { type: 'integer' }, visual_facts: { type: 'array', items: { type: 'string' } },
      uncertainties: { type: 'array', items: { type: 'string' } }, complex_confirmation_required: { type: 'boolean' },
    }, output: jsonOutput,
    async execute(args: any, exec: any) { return service.preflight(args as PreflightInput, agent(exec), exec.signal) },
  } as any))

  ctx.tools.register(defineTool({
    name: 'fish_draws_generate',
    description: 'Start one fixed Qwen Image workflow job after a matching fish_draws_preflight. Prompt expansion must already be complete.',
    parameters: {
      task_id: { type: 'string', required: true }, preflight_digest: { type: 'string', required: true }, expanded_prompt: { type: 'string', required: true, description: 'The plain rewritten prompt text only, never the JSON expansion envelope.' },
      count: { type: 'integer' }, seed: { type: 'integer' }, steps: { type: 'integer' }, acceleration: { type: 'string', enum: ['balanced', 'fast'] },
      quality_cycle: { type: 'integer' }, complex_task_confirmed: { type: 'boolean' }, allow_oversize: { type: 'boolean' }, formal_batch: { type: 'boolean' },
      no_improvement_rounds: { type: 'integer' },
    }, output: jsonOutput,
    async execute(args: any, exec: any) { const result = await service.generate(args as GenerateInput, agent(exec), { callId: String(exec.callId), rootCallId: String(exec.rootCallId) }); return { job_id: result.jobId, task_id: result.taskId, execution_id: result.executionId, status: result.status } },
  } as any))

  ctx.tools.register(defineTool({
    name: 'fish_draws_result', description: 'Read a completed, failed, cancelled, or awaiting-selection fish-draws task and display its validated images.',
    parameters: { task_id: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value.result) }, ...(value.attachments ?? []).map((attachment: ImageAttachmentRef) => ({ type: 'image' as const, attachment }))],
    },
    async execute(args: any) {
      const manifest = await service.result(args.task_id)
      const taskDirectory = await service.taskDirectory(args.task_id)
      const result = buildPublicResult(manifest, taskDirectory)
      const attachments: ImageAttachmentRef[] = []
      for (const output of [...result.outputs, ...result.candidates]) {
        const data = await readFile(output.path)
        attachments.push(await ctx.attachments.saveImage({ data, mediaType: 'image/png', name: output.relative_path }))
      }
      return { result, attachments }
    },
  } as any))

  ctx.tools.register(defineTool({
    name: 'fish_draws_finalize_selection', description: 'Adopt, continue, or abandon a task paused for visual selection. Every output_index is zero-based within candidates from its execution_id.',
    parameters: {
      task_id: { type: 'string', required: true }, decision: { type: 'string', required: true, enum: ['adopt', 'continue', 'abandon'] },
      selected_outputs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { execution_id: { type: 'string', required: true }, output_index: { type: 'integer', required: true, description: 'Zero-based index within candidates having the specified execution_id.' } } } },
    }, output: jsonOutput,
    async execute(args: any) { return service.finalize(args.task_id, args.decision, args.selected_outputs ?? []) },
  } as any))

  ctx.tools.register(defineTool({
    name: 'fish_draws_diagnose', description: 'Return a redacted, read-only fish-draws environment and lifecycle report.', parameters: {}, output: jsonOutput,
    async execute() { return service.diagnose() },
  } as any))
}

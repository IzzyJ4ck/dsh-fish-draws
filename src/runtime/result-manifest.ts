import { open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ensureDirectoryInside } from './paths.js'
import type { TaskRecord } from './task-state.js'
import { PLUGIN_VERSION, EMBEDDED_SKILL_VERSION, WORKFLOW_VERSION } from '../version.js'

export interface ResultManifest {
  schema_version: 1
  plugin_version: string
  embedded_skill_version: string
  workflow: { version: string; sha256: string }
  task_id: string
  contract_hash: string
  execution_id: string
  task_mode: string
  status: string
  created_at_utc: string
  completed_at_utc?: string
  prompts: { original: string; expanded: string }
  references: Array<{ sha256: string; image_tag: string; width: number; height: number }>
  canvas: { target_width: number; target_height: number; sample_width: number; sample_height: number; size_source: string }
  generation: { acceleration: string; steps: number; technical_attempts: number }
  quality: { rework_occurred: boolean; rework_rounds: number; adopted_execution_id?: string }
  outputs: Array<{ relative_path: string; width: number; height: number; seed: number; sha256: string }>
  candidates: Array<{ relative_path: string; width: number; height: number; seed: number; sha256: string; execution_id: string; adopted: boolean; quality_cycle: number; candidate_kind: 'attempt' | 'rework'; candidate_index: number }>
  lifecycle: { comfy_started_by_plugin: boolean; comfy_models_unloaded: boolean; strata_restored: boolean }
  cleanup: { complete: boolean; temporary_inputs_removed: boolean; workflow_removed: boolean; queue_state_removed: boolean; residual_items: string[] }
  failure: null | { class: string; code: string; message: string }
}

export function toManifest(task: TaskRecord, workflowHash: string): ResultManifest {
  return {
    schema_version: 1, plugin_version: PLUGIN_VERSION, embedded_skill_version: EMBEDDED_SKILL_VERSION,
    workflow: { version: WORKFLOW_VERSION, sha256: workflowHash }, task_id: task.taskId, contract_hash: task.contractHash, execution_id: task.executionId,
    task_mode: task.mode, status: task.status, created_at_utc: task.createdAtUtc,
    ...(task.completedAtUtc === undefined ? {} : { completed_at_utc: task.completedAtUtc }),
    prompts: { original: task.originalPrompt, expanded: task.expandedPrompt },
    references: task.references.map(value => ({ sha256: value.sha256, image_tag: value.imageTag, width: value.width, height: value.height })),
    canvas: { target_width: task.targetWidth, target_height: task.targetHeight, sample_width: task.sampleWidth, sample_height: task.sampleHeight, size_source: task.sizeSource },
    generation: { acceleration: task.acceleration, steps: task.steps, technical_attempts: task.technicalAttempts },
    quality: { rework_occurred: task.qualityReworkOccurred, rework_rounds: task.qualityCycle, ...(task.adoptedExecutionId === undefined ? {} : { adopted_execution_id: task.adoptedExecutionId }) },
    outputs: task.outputs.map(value => ({ relative_path: value.relativePath, width: value.width, height: value.height, seed: value.seed, sha256: value.sha256 })),
    candidates: task.candidates.map(value => ({ relative_path: value.relativePath, width: value.width, height: value.height, seed: value.seed, sha256: value.sha256, execution_id: value.executionId, adopted: value.adopted, quality_cycle: value.qualityCycle, candidate_kind: value.candidateKind, candidate_index: value.candidateIndex })),
    lifecycle: { comfy_started_by_plugin: task.comfyStartedByPlugin, comfy_models_unloaded: task.comfyModelsUnloaded, strata_restored: task.strataRestored },
    cleanup: { complete: task.cleanup.complete, temporary_inputs_removed: task.cleanup.temporaryInputsRemoved, workflow_removed: task.cleanup.workflowRemoved, queue_state_removed: task.cleanup.queueStateRemoved, residual_items: [...task.cleanup.residualItems] },
    failure: task.failure === undefined ? null : { class: task.failure.class, code: task.failure.code, message: redactError(task.failure.message) },
  }
}

export function redactError(value: string): string {
  return value
    .replace(/[A-Za-z]:\\(?:[^\s"']+\\)*[^\s"']*/gu, '[local-path]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;}]+/giu, '$1=[redacted]')
}

export async function writeManifestAtomic(path: string, manifest: ResultManifest): Promise<void> {
  await ensureDirectoryInside(dirname(path), dirname(path), true)
  const temp = join(dirname(path), `.result-${process.pid}-${Date.now()}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); await handle.sync() }
  finally { await handle.close() }
  await rename(temp, path).catch(async error => { await rm(temp, { force: true }); throw error })
}

export async function readManifest(path: string): Promise<ResultManifest> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as ResultManifest
  if (parsed.schema_version !== 1 || typeof parsed.task_id !== 'string') throw new Error('invalid fish-draws result manifest')
  return parsed
}

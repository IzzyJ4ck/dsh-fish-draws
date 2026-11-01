import { access, constants, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResolvedConfig } from '../config.js'
import type { ComfyLifecycle } from './comfy-lifecycle.js'
import { PLUGIN_VERSION, EMBEDDED_SKILL_VERSION, WORKFLOW_VERSION } from '../version.js'

export async function diagnostics(config: ResolvedConfig, lifecycle: ComfyLifecycle, runtimeRoot: string): Promise<Record<string, unknown>> {
  const pathState: Record<string, boolean> = {}
  for (const [name, path] of Object.entries({ comfyRoot: config.comfy.root, outputRoot: config.storage.outputRoot })) {
    pathState[name] = path !== '' && await access(path, constants.R_OK).then(() => true, () => false)
  }
  const awaiting: string[] = []
  let taskCount = 0
  if (config.storage.outputRoot !== '') {
    const taskRoot = join(config.storage.outputRoot, 'fish-draws')
    for (const date of await readdir(taskRoot).catch(() => [])) {
      if (date === 'diagnostics') continue
      for (const task of await readdir(join(taskRoot, date)).catch(() => [])) {
        taskCount += 1
        try { const result = JSON.parse(await readFile(join(taskRoot, date, task, 'result.json'), 'utf8')) as { status?: string }; if (result.status === 'awaiting_selection') awaiting.push(task) } catch { /* diagnose counts incomplete directories separately through journals */ }
      }
    }
  }
  const requiredNodes = ['UnetLoaderGGUF', 'QwenImage21Cache', 'PathchSageAttentionKJ', 'TextEncodeQwenImage21', 'ImageScaleToTotalPixels', 'EasyCache']
  const objectInfo = await lifecycle.client.request<Record<string, unknown>>('/object_info', {}, 15_000).catch(() => undefined)
  const missingNodes = objectInfo === undefined ? undefined : requiredNodes.filter(name => objectInfo[name] === undefined)
  const cleanupJournalCount = (await readdir(join(runtimeRoot, 'cleanup-journal')).catch(() => [])).length
  const legacySkillConflict = process.env.DSH_HOME === undefined ? undefined : await access(join(process.env.DSH_HOME, 'skills', 'fish-draws', 'SKILL.md'), constants.R_OK).then(() => true, () => false)
  return {
    plugin_version: PLUGIN_VERSION, embedded_skill_version: EMBEDDED_SKILL_VERSION, workflow_version: WORKFLOW_VERSION,
    comfy_url: config.comfy.apiUrl.origin, comfy_online: await lifecycle.client.online().then(() => true, () => false), comfy_owned_by_plugin: lifecycle.owned,
    strata_configured: config.strata.vramEndpoint !== undefined, paths: pathState, output_root_configured: config.storage.outputRoot !== '',
    required_nodes_checked: objectInfo !== undefined, missing_nodes: missingNodes, current_model_profile_status: config.currentModelProfile.validation?.status ?? 'unverified',
    prompt_expansion_mode: config.promptExpansion.mode, current_agent_visual_capability: 'validated by skill preflight at task time',
    task_directories: taskCount, awaiting_selection_tasks: awaiting, cleanup_journal_items: cleanupJournalCount, legacy_skill_conflict: legacySkillConflict,
    note: 'Use fish_draws_result for task details. Absolute local paths are intentionally omitted.',
  }
}

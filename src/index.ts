import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { Config, currentProfileCompatibilityValues, legacyModelProfile, resolveConfig, type RuntimeConfig as FishDrawsConfig } from './config.js'
import { FishDrawsService } from './service.js'
import { registerTools } from './tools.js'
import { registerBundledSkill } from './skill-provider.js'
import { FishDrawsSettingsController } from './settings-remote/controller.js'
export { FishDrawsSettingsController } from './settings-remote/controller.js'
export type * from './settings-remote/types.js'

export const name = 'dsh-fish-draws'
export const inject = ['tools', 'jobs', 'attachments', 'credentials', 'skills', 'workingDirectory']
export { Config }

export async function apply(ctx: Context, input: FishDrawsConfig): Promise<void> {
  const configSource = () => resolveConfig(input)
  const config = configSource()
  const runtimeRoot = config.storage.outputRoot !== ''
    ? join(config.storage.outputRoot, '.fish-draws-runtime')
    : join(process.env.DSH_HOME ?? process.cwd(), '.fish-draws-runtime', 'dsh-fish-draws')
  await mkdir(runtimeRoot, { recursive: true })
  const service = new FishDrawsService(ctx, configSource, runtimeRoot)
  new FishDrawsSettingsController(ctx, service)
  await service.recoverLifecycle()
  registerTools(ctx, service)
  registerBundledSkill(ctx)
  const owner = ctx.fiber
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, owner))
    const current = configSource()
    if (!current.migrationRequired && !current.rollbackMirrorChanged) return
    void migrateV3Config(settingsCtx, current).catch((error: unknown) => {
      settingsCtx.logger.error(`fish-draws configuration migration failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
  ctx.effect(() => async () => { await service.dispose() })
}

async function migrateV3Config(ctx: Context, config: ReturnType<typeof resolveConfig>): Promise<void> {
  const descriptor = ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'fish-draws')
  if (descriptor === undefined || (!config.migrationRequired && !config.rollbackMirrorChanged)) return
  if (config.rollbackMirrorChanged) {
    const legacy = legacyModelProfile(config.legacyMirror.models, config.legacyMirror.safety)
    legacy.id = `rollback-v3-${config.legacyMirrorHash.slice(0, 8)}`
    legacy.name = '3.0 回退配置'
    legacy.notes = 'Detected from a legacy compatibility mirror changed while fish-draws 3.0.0 was active.'
    const profiles = config.modelProfiles.map(profile => { const { profileHash: _profileHash, ...stored } = profile; return stored }).filter(profile => profile.id !== legacy.id)
    await ctx.settings.mutate('fish-draws', [
      { op: 'set', path: ['configSchemaVersion'], value: 2 }, { op: 'set', path: ['modelProfiles'], value: [...profiles, legacy] },
      { op: 'set', path: ['currentModelProfileId'], value: legacy.id }, { op: 'set', path: ['migration', 'legacyMirrorHash'], value: config.legacyMirrorHash },
    ], descriptor.revision)
    return
  }
  const compatibility = currentProfileCompatibilityValues(config)
  await ctx.settings.mutate('fish-draws', [
    { op: 'set', path: ['configSchemaVersion'], value: 2 },
    { op: 'set', path: ['modelProfiles'], value: config.modelProfiles.map(profile => {
      const { profileHash: _profileHash, ...stored } = profile
      return stored
    }) },
    { op: 'set', path: ['currentModelProfileId'], value: config.currentModelProfileId },
    { op: 'set', path: ['models'], value: compatibility.models },
    { op: 'set', path: ['safety'], value: compatibility.safety },
    { op: 'set', path: ['strata', 'authMode'], value: 'bearer' },
    { op: 'set', path: ['migration', 'legacyMirrorHash'], value: config.legacyMirrorHash },
  ], descriptor.revision)
}

export default { name, inject, Config, apply }

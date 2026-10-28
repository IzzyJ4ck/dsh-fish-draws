import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { Config, resolveConfig, type Config as FishDrawsConfig } from './config.js'
import { FishDrawsService } from './service.js'
import { registerTools } from './tools.js'
import { registerBundledSkill } from './skill-provider.js'

export const name = 'dsh-fish-draws'
export const inject = ['tools', 'jobs', 'attachments', 'credentials', 'skills', 'workingDirectory']
export { Config }

export async function apply(ctx: Context, input: FishDrawsConfig): Promise<void> {
  const config = resolveConfig(input)
  const runtimeRoot = config.storage.outputRoot !== ''
    ? join(config.storage.outputRoot, '.fish-draws-runtime')
    : join(process.env.DSH_HOME ?? process.cwd(), '.fish-draws-runtime', 'dsh-fish-draws')
  await mkdir(runtimeRoot, { recursive: true })
  const service = new FishDrawsService(ctx, config, runtimeRoot)
  await service.recoverLifecycle()
  registerTools(ctx, service)
  registerBundledSkill(ctx)
  ctx.effect(() => async () => { await service.dispose() })
}

export default { name, inject, Config, apply }

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigValues } from '../config.js'
import { disposeClientStreams, FishDrawsSettings } from './FishDrawsSettings.js'
import { dictionaries } from './locale.js'
import './remote-types.js'

export const inject = ['slots', 'configForms', 'locale', 'remote', 'remote.fishDrawsSettings']

export function apply(ctx: Context): void {
  ctx.effect(() => () => disposeClientStreams())
  ctx.effect(() => (ctx.locale.register as any)('fish-draws.settings', dictionaries))
  const form = ctx.configForms.get<ConfigValues>('fish-draws')
  ctx.effect(() => ctx.configForms.whileServed(['fish-draws'], () =>
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        { name: 'settings.section', id: 'fish-draws', order: 450, label: ctx.locale.getSnapshot().active.toLowerCase().startsWith('zh') ? '画图设置' : 'Image Generation' },
        ({ close }: { close: () => void }) => <FishDrawsSettings ctx={ctx} form={form} close={close} /> as any,
      ),
    ),
  ))
}


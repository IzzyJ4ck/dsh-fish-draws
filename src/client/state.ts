import { useSyncExternalStore } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigValues } from '../config.js'

export type SettingsTab = 'comfy' | 'models' | 'strata' | 'diagnostics'
export interface Drafts { comfy?: ConfigValues; models?: ConfigValues; strata?: ConfigValues; diagnostics?: ConfigValues }

export function useConfigSnapshot(form: ConfigForm<ConfigValues>): ConfigFormSnapshot<ConfigValues> {
  return useSyncExternalStore(form.subscribe.bind(form), form.getSnapshot.bind(form), form.getSnapshot.bind(form))
}

export function cloneConfig(value: ConfigValues | undefined): ConfigValues | undefined { return value === undefined ? undefined : structuredClone(value) }

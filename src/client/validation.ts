import type { ConfigValues, ModelProfileConfig } from '../config.js'

export interface ValidationIssue { field: string; message: string }

export function validateComfyDraft(value: ConfigValues): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if ((value.comfy?.root ?? '').trim() === '') issues.push({ field: 'comfy.root', message: 'ComfyUI root is required.' })
  try { const url = new URL(value.comfy?.apiUrl ?? ''); if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) issues.push({ field: 'comfy.apiUrl', message: 'Only loopback URLs are allowed.' }) } catch { issues.push({ field: 'comfy.apiUrl', message: 'Enter a valid URL.' }) }
  return issues
}

export function validateProfiles(profiles: ModelProfileConfig[], current: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (new Set(profiles.map(value => value.id)).size !== profiles.length) issues.push({ field: 'modelProfiles', message: 'Profile IDs must be unique.' })
  if (!profiles.some(value => value.id === current)) issues.push({ field: 'currentModelProfileId', message: 'Select an existing profile.' })
  for (const profile of profiles) {
    for (const [name, value] of Object.entries(profile.files)) if (value === '' || /(?:^|[\\/])\.\.(?:[\\/]|$)|^[A-Za-z]:|^[\\/]/u.test(value)) issues.push({ field: `${profile.id}.${name}`, message: 'Use a relative loader filename without traversal.' })
    for (const [name, safety] of Object.entries(profile.safety)) {
      if ((safety.maxSampleWidth ?? 0) < 1 || (safety.maxSampleHeight ?? 0) < 1 || (safety.maxSamplePixels ?? 0) < 1) issues.push({ field: `${profile.id}.${name}`, message: 'Safety dimensions and pixels must be positive.' })
      if ((safety.reserveMiB ?? 0) < 1024 || (safety.reserveMiB ?? 0) > 30000) issues.push({ field: `${profile.id}.${name}.reserveMiB`, message: 'Reserve must be between 1024 and 30000 MiB.' })
    }
  }
  return issues
}

export function validateStrataDraft(value: ConfigValues): ValidationIssue[] {
  const strata = value.strata ?? {}
  const issues: ValidationIssue[] = []
  if (strata.handoffEnabled !== false) {
    if ((strata.vramEndpoint ?? '').trim() === '') issues.push({ field: 'strata.vramEndpoint', message: 'A loopback Strata endpoint is required while VRAM handoff is enabled.' })
    else if (!isLoopbackUrl(strata.vramEndpoint!)) issues.push({ field: 'strata.vramEndpoint', message: 'Only loopback URLs are allowed.' })
  }
  if ((strata.authMode ?? 'bearer') === 'bearer' && (strata.credentialRef ?? '').trim() === '') issues.push({ field: 'strata.credentialRef', message: 'A credential reference is required for bearer authentication.' })
  return issues
}

export function validateDiagnosticsDraft(value: ConfigValues): ValidationIssue[] {
  const routes = value.diagnostics?.localModelRoutes ?? []
  const keys = routes.map(route => `${route.provider}\0${route.model}\0${route.reasoningEffort ?? ''}`)
  return new Set(keys).size === keys.length ? [] : [{ field: 'diagnostics.localModelRoutes', message: 'Diagnostic routes must be unique.' }]
}

function isLoopbackUrl(value: string): boolean {
  try { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(value).hostname) } catch { return false }
}

import { FishDrawsError } from '../errors.js'

export function normalizeExpandedPrompt(input: string): string {
  const value = input.trim()
  if (value === '') throw new FishDrawsError('expanded_prompt must not be empty', 'INVALID_EXPANDED_PROMPT', 'preflight')

  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return value }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object' || !Object.prototype.hasOwnProperty.call(parsed, 'rewritten_prompt')) return value

  const rewritten = (parsed as { rewritten_prompt?: unknown }).rewritten_prompt
  if (typeof rewritten !== 'string' || rewritten.trim() === '') {
    throw new FishDrawsError('rewritten_prompt in the expansion envelope must be a non-empty string', 'INVALID_EXPANDED_PROMPT', 'preflight')
  }
  return rewritten.trim()
}

import { describe, expect, it } from 'vitest'
import { normalizeExpandedPrompt } from '../src/runtime/prompt-normalization.js'

describe('expanded prompt normalization', () => {
  it('keeps an ordinary plain prompt as plain text', () => {
    expect(normalizeExpandedPrompt('  paint the teapot cobalt blue  ')).toBe('paint the teapot cobalt blue')
  })

  it('extracts rewritten_prompt from the edit expansion envelope', () => {
    expect(normalizeExpandedPrompt(JSON.stringify({ rewritten_prompt: '将茶壶改为深钴蓝色。' }))).toBe('将茶壶改为深钴蓝色。')
  })

  it('extracts rewritten_prompt without appending T2I ratio metadata', () => {
    expect(normalizeExpandedPrompt(JSON.stringify({ rewritten_prompt: 'A rainy Tokyo alley.', wh_ratio: '16:9' }))).toBe('A rainy Tokyo alley.')
  })

  it('rejects an empty or malformed rewritten_prompt field', () => {
    expect(() => normalizeExpandedPrompt('{"rewritten_prompt":"  "}')).toThrow(/non-empty string/u)
    expect(() => normalizeExpandedPrompt('{"rewritten_prompt":42}')).toThrow(/non-empty string/u)
    expect(() => normalizeExpandedPrompt('   ')).toThrow(/must not be empty/u)
  })
})

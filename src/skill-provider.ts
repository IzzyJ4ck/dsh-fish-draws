import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'

export function registerBundledSkill(ctx: Context): void {
  const locator = fileURLToPath(new URL('./assets/skill/SKILL.md', import.meta.url))
  const base = fileURLToPath(new URL('./assets/', import.meta.url))
  const candidate: SkillCandidate = {
    name: 'fish-draws',
    description: 'Generate and edit images through the controlled local Qwen Image 2.1 ComfyUI workflow, with exact sizing, visual preflight, VRAM handoff, retries, and cleanup.',
    invocation: { modelInvocable: true, userInvocable: true }, provider: 'dsh-fish-draws', source: 'bundled', rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: base }, locator,
  }
  const provider: SkillProvider = {
    name: 'dsh-fish-draws', list: () => Promise.resolve([candidate]),
    async get(entry, options) {
      const raw = await readFile(entry.locator as string, { encoding: 'utf8', signal: options.signal })
      const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
      const { rank: _rank, locator: _locator, ...summary } = entry
      return { ...summary, content }
    },
  }
  ctx.skills.registerProvider(() => provider)
}

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('publication gate', () => {
  it('opens public redistribution only with the recorded scoped authorization', async () => {
    const status = JSON.parse(await readFile(new URL('../assets/licensing/redistribution-status.json', import.meta.url), 'utf8'))
    expect(status).toMatchObject({
      redistribution_approved: true,
      basis: 'written_permission_with_attribution',
      author: 'Zove-try',
      attribution_required: true,
      authorization_record: 'AUTHORIZATION.md',
    })
    expect(status.scope).toEqual(expect.arrayContaining(['modification', 'public_redistribution', 'github_packaging', 'npm_packaging', 'commercial_use']))
    await expect(readFile(new URL('../assets/licensing/AUTHORIZATION.md', import.meta.url), 'utf8')).resolves.toContain('Zove-try')
  })
})

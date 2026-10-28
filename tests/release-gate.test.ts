import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('publication gate', () => {
  it('keeps public redistribution blocked until evidence is recorded', async () => {
    const status = JSON.parse(await readFile(new URL('../assets/licensing/redistribution-status.json', import.meta.url), 'utf8'))
    expect(status.redistribution_approved).toBe(false)
    expect(status.authorization_record).toBeNull()
  })
})

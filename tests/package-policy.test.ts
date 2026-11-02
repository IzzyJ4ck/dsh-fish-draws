import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('package policy', () => {
  it('uses the confirmed public scoped identity without install scripts', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.name).toBe('@izzyj4ck/dsh-fish-draws')
    expect(pkg.version).toBe('3.1.1')
    expect(pkg.private).not.toBe(true)
    expect(pkg.publishConfig).toEqual({ registry: 'https://registry.npmjs.org/', access: 'public' })
    for (const key of ['prepare', 'preinstall', 'install', 'postinstall']) expect(pkg.scripts[key]).toBeUndefined()
  })
  it('publishes through an explicit allowlist', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.files).toEqual(['lib', 'cordis.patch.yml', 'README.md', 'README.en.md', 'README.zh-CN.md', 'docs/images', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'icon.svg', 'locale'])
  })
})

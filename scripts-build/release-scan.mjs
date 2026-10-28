import { access, readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
const root = new URL('../', import.meta.url)
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
if (packageJson.private === true) throw new Error('release package must not be private')
if (packageJson.name !== '@izzyj4ck/dsh-fish-draws') throw new Error('unexpected package name')
if (packageJson.scripts?.prepare !== undefined || packageJson.scripts?.preinstall !== undefined || packageJson.scripts?.install !== undefined || packageJson.scripts?.postinstall !== undefined) throw new Error('release package must not run install-time build scripts')
const licensing = JSON.parse(await readFile(new URL('assets/licensing/redistribution-status.json', root), 'utf8'))
if (licensing.redistribution_approved !== true) {
  throw new Error('PUBLIC RELEASE BLOCKED: third-party workflow/system-prompt redistribution permission is not documented; obtain written permission or independently rebuild/rewrite before npm publication')
}
for (const required of ['lib/index.js', 'lib/assets/skill/SKILL.md', 'lib/assets/references/system-prompt-t2i.md', 'lib/assets/references/system-prompt-edit.md', 'lib/assets/workflows/qwen21-unified-api.json', 'cordis.patch.yml', 'README.md', 'README.zh-CN.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'icon.svg']) {
  await access(new URL(required, root)).catch(() => { throw new Error(`required release asset is missing: ${required}`) })
}
const forbiddenNames = new Set(['.env', '.npmrc'])
const secretPattern = /(?:npm_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:api[_-]?key|token|secret)\s*[:=]\s*["'][^"']{8,}["'])/giu
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'lib'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path)
    else {
      if (forbiddenNames.has(entry.name)) throw new Error(`forbidden release file: ${relative(directory, path)}`)
      if ((await stat(path)).size <= 8 * 1024 * 1024) {
        const text = await readFile(path, 'utf8').catch(() => '')
        if (secretPattern.test(text)) throw new Error(`possible secret in ${path}`)
        secretPattern.lastIndex = 0
      }
    }
  }
}
await walk(new URL('../', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, value => value.slice(1)))
console.log('release scan passed')

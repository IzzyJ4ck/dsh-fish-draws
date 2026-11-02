import { access, readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
const root = new URL('../', import.meta.url)
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
if (packageJson.private === true) throw new Error('release package must not be private')
if (packageJson.name !== '@izzyj4ck/dsh-fish-draws') throw new Error('unexpected package name')
if (packageJson.version !== '3.1.0') throw new Error('unexpected release version')
if (packageJson.scripts?.prepare !== undefined || packageJson.scripts?.preinstall !== undefined || packageJson.scripts?.install !== undefined || packageJson.scripts?.postinstall !== undefined) throw new Error('release package must not run install-time build scripts')
const licensing = JSON.parse(await readFile(new URL('assets/licensing/redistribution-status.json', root), 'utf8'))
for (const required of ['lib/index.js', 'lib/client.js', 'lib/client.js.map', 'lib/types/client/index.d.ts', 'lib/typert.host.js', 'lib/typert.remote-client.js', 'lib/assets/skill/SKILL.md', 'lib/assets/references/system-prompt-t2i.md', 'lib/assets/references/system-prompt-edit.md', 'lib/assets/workflows/qwen21-unified-api.json', 'lib/assets/licensing/AUTHORIZATION.md', 'lib/assets/licensing/redistribution-status.json', 'cordis.patch.yml', 'README.md', 'README.zh-CN.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'icon.svg']) {
  await access(new URL(required, root)).catch(() => { throw new Error(`required release asset is missing: ${required}`) })
}
const clientBundle = await readFile(new URL('lib/client.js', root), 'utf8')
if (!clientBundle.includes('require("react")') || !clientBundle.includes('require("@deepseek-ai/dsh-client-ui-primitives")')) throw new Error('client bundle must consume DSH shared React and UI modules')
if (clientBundle.includes('react.production.min') || clientBundle.includes('ReactVersion')) throw new Error('client bundle unexpectedly contains a private React runtime')
if (!clientBundle.includes('.$mount(') || !clientBundle.includes('@izzyj4ck/dsh-fish-draws')) throw new Error('client bundle does not mount its generated fish-draws Remote contribution')
const clientInject = clientBundle.match(/const inject = \[([\s\S]*?)\];/u)?.[1] ?? ''
if (clientInject.includes('remote.fishDrawsSettings')) throw new Error('client bundle deadlocks by injecting its own Remote namespace before mounting it')
const remoteMountIndex = clientBundle.indexOf('.$mount(')
const scopedInjectIndex = clientBundle.indexOf('"remote.fishDrawsSettings"', remoteMountIndex)
const scopedInject = scopedInjectIndex < 0 ? '' : clientBundle.slice(scopedInjectIndex, scopedInjectIndex + 240)
if (scopedInjectIndex < remoteMountIndex || !scopedInject.includes('"remote.credentials"') || !scopedInject.includes('"remote.session"')) throw new Error('client bundle must mount fish-draws Remote before creating its complete dependent child scope')
const hostTypert = await import(new URL('lib/typert.host.js', root))
const remoteTypert = await import(new URL('lib/typert.remote-client.js', root))
if (!Array.isArray(hostTypert.TYPERT?.invocations) || hostTypert.TYPERT.invocations.length !== 14) throw new Error('Host Typert settings surface is incomplete')
if (remoteTypert.TYPERT_REMOTE?.descriptors?.length !== 14) throw new Error('Client Typert settings surface is incomplete')
const services = hostTypert.TYPERT?.model?.services
if (!Array.isArray(services) || services.length !== 1) throw new Error('Host Typert service model is incomplete')
const settingsService = services[0]
if (settingsService.key !== 'fishDrawsSettings' || settingsService.exportName !== 'FishDrawsSettingsController') throw new Error('Host Typert service identity is invalid')
for (const field of ['description', 'summary', 'jsDoc']) if (typeof settingsService[field] !== 'string' || settingsService[field].length === 0) throw new Error(`Host Typert service ${field} is missing`)
if (!Array.isArray(settingsService.tags) || !Array.isArray(settingsService.members) || !Array.isArray(settingsService.types)) throw new Error('Host Typert service arrays are incomplete')
if (settingsService.members.length !== 14) throw new Error('Host Typert service member documentation is incomplete')
for (const member of settingsService.members) {
  if (member.kind !== 'method' || typeof member.name !== 'string' || typeof member.signature !== 'string' || typeof member.summary !== 'string' || typeof member.jsDoc !== 'string') throw new Error(`Host Typert member documentation is invalid: ${String(member?.name)}`)
}
const forbiddenNames = new Set(['.env', '.npmrc'])
const secretPattern = /(?:npm_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:api[_-]?key|token|secret)\s*[:=]\s*["'][^"']{8,}["'])/giu
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name)) continue
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
if (licensing.redistribution_approved !== true) {
  console.log('release integrity, asset, and secret scans passed; public release remains blocked by the redistribution license gate')
  throw new Error('PUBLIC RELEASE BLOCKED: third-party workflow/system-prompt redistribution permission is not documented; obtain written permission or independently rebuild/rewrite before npm publication')
}
console.log('release scan passed')

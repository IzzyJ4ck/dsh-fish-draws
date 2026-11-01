import { build } from 'tsdown'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0))
const temporary = resolve(root, '.client-build')
await rm(temporary, { recursive: true, force: true })
await mkdir(temporary, { recursive: true })
const external = [
  'react', 'react/jsx-runtime', '@deepseek-ai/cordis', '@deepseek-ai/dsh-api-remotes/client',
  '@deepseek-ai/dsh-api-session-controller/client', '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-renderer/client', '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-typert-protocol',
]
await build({
  config: false,
  cwd: root,
  entry: { client: resolve(root, 'src/client/index.tsx') },
  platform: 'browser',
  format: 'cjs',
  deps: { neverBundle: external },
  outDir: temporary,
  outExtensions: () => ({ js: '.cjs' }),
  sourcemap: true,
  clean: true,
  dts: false,
  hash: false,
  report: false,
})
let code = await readFile(resolve(temporary, 'client.cjs'), 'utf8')
code = code.replace(/^["']use strict["'];?\s*/u, '')
const wrapped = `window.__ModuleLoader__.load({\n  id: ${JSON.stringify('@izzyj4ck/dsh-fish-draws')},\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${code.split('\n').map(line => `    ${line}`).join('\n')}\n    return module.exports;\n  }\n});\n//# sourceMappingURL=client.js.map\n`
const out = resolve(root, 'lib/client.js')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, wrapped, 'utf8')
const map = JSON.parse(await readFile(resolve(temporary, 'client.cjs.map'), 'utf8'))
map.file = 'client.js'
await writeFile(resolve(root, 'lib/client.js.map'), JSON.stringify(map), 'utf8')
await rm(temporary, { recursive: true, force: true })

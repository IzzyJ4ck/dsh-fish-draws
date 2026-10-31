import { EventEmitter } from 'node:events'
import { access, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { ComfyLifecycle, comfyLaunchArguments } from '../src/runtime/comfy-lifecycle.js'

class SignalExitedChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kills: NodeJS.Signals[] = []
  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal)
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }
}

describe('ComfyUI lifecycle shutdown', () => {
  it('starts managed ComfyUI without browser auto-launch or the shared asset database', () => {
    const args = comfyLaunchArguments(resolveConfig({ comfy: { apiUrl: 'http://127.0.0.1:9191' } }))
    expect(args).toEqual([
      '-s', 'main.py', '--windows-standalone-build', '--disable-auto-launch', '--disable-assets',
      '--listen', '127.0.0.1', '--port', '9191',
    ])
  })

  it('treats a signalCode as a completed child exit on Windows-style termination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fish-comfy-lifecycle-'))
    const ownerPath = join(root, 'comfy-owner.json')
    await writeFile(ownerPath, '{"schema_version":1,"pid":1234}')
    const lifecycle = new ComfyLifecycle(resolveConfig())
    const child = new SignalExitedChild()
    Object.assign(lifecycle as any, { child, ownerPath, managedPid: 1234, startedByPlugin: true })

    await expect(lifecycle.stopOwned()).resolves.toBeUndefined()
    expect(child.kills).toEqual(['SIGTERM'])
    expect(lifecycle.owned).toBe(false)
    await expect(access(ownerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('contains an idle-shutdown rejection instead of crashing the Host', async () => {
    const config = resolveConfig(); config.comfy.idleShutdownMs = 5
    const lifecycle = new ComfyLifecycle(config)
    Object.assign(lifecycle as any, { startedByPlugin: true })
    let unhandled = false
    const onUnhandled = (): void => { unhandled = true }
    process.once('unhandledRejection', onUnhandled)
    lifecycle.stopIfIdle = async () => { Object.assign(lifecycle as any, { startedByPlugin: false }); throw new Error('synthetic shutdown failure') }
    lifecycle.scheduleIdleShutdown()
    await new Promise(resolve => setTimeout(resolve, 25))
    process.removeListener('unhandledRejection', onUnhandled)
    expect(unhandled).toBe(false)
  })
})

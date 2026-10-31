import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { ResolvedConfig } from '../config.js'
import { FishDrawsError } from '../errors.js'
import { ComfyClient } from './comfy-client.js'

export function comfyLaunchArguments(config: ResolvedConfig): string[] {
  return [
    '-s',
    'main.py',
    '--windows-standalone-build',
    // The standalone convenience mode otherwise opens the browser and enables
    // ComfyUI's asset indexer. fish-draws uses neither feature: inputs are staged
    // directly and outputs are collected through /history. Disabling both also
    // keeps plugin-owned runs away from the shared asset SQLite database.
    '--disable-auto-launch',
    '--disable-assets',
    '--listen',
    '127.0.0.1',
    '--port',
    String(config.comfy.apiUrl.port || 8188),
  ]
}

export class ComfyLifecycle {
  readonly client: ComfyClient
  private child: ChildProcess | undefined
  private managedPid: number | undefined
  private ownerPath: string | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private startedByPlugin = false
  constructor(private readonly config: ResolvedConfig) { this.client = new ComfyClient(config.comfy.apiUrl) }
  get owned(): boolean { return this.startedByPlugin }

  async ensureOnline(runtimeRoot: string, signal?: AbortSignal): Promise<{ startedByPlugin: boolean }> {
    this.ownerPath = join(runtimeRoot, 'comfy-owner.json')
    try {
      await this.client.online(signal)
      const owner = await this.readOwner()
      if (owner !== undefined && this.pidAlive(owner.pid)) { this.managedPid = owner.pid; this.startedByPlugin = true; return { startedByPlugin: true } }
      return { startedByPlugin: false }
    } catch { /* start below */ }
    if (!this.config.comfy.autoStart) throw new FishDrawsError('ComfyUI is offline and auto-start is disabled', 'COMFY_OFFLINE', 'startup')
    if (this.config.comfy.root === '' || !existsSync(join(this.config.comfy.root, 'main.py'))) throw new FishDrawsError('comfy.root must point to a ComfyUI directory containing main.py', 'COMFY_ROOT_INVALID', 'startup')
    const python = this.discoverPython()
    const logs = join(runtimeRoot, 'logs')
    await mkdir(logs, { recursive: true })
    const logPath = join(logs, 'comfy-startup.log')
    await this.rotate(logPath)
    const log = createWriteStream(logPath, { flags: 'a', encoding: 'utf8' })
    this.child = spawn(python, comfyLaunchArguments(this.config), {
      cwd: this.config.comfy.root, shell: false, windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child.stdout?.pipe(log); this.child.stderr?.pipe(log)
    if (this.child.pid === undefined) throw new FishDrawsError('ComfyUI process did not receive a pid', 'COMFY_START_FAILED', 'startup')
    this.managedPid = this.child.pid
    await writeFile(this.ownerPath, JSON.stringify({ schema_version: 1, pid: this.child.pid, started_at_utc: new Date().toISOString() }), { encoding: 'utf8', flag: 'w', mode: 0o600 })
    const deadline = Date.now() + this.config.comfy.startupTimeoutMs
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      if (this.childExited(this.child)) { log.end(); throw new FishDrawsError(`ComfyUI exited during startup; inspect ${logPath}`, 'COMFY_START_EXITED', 'startup') }
      try { await this.client.online(signal); this.startedByPlugin = true; return { startedByPlugin: true } } catch { /* retry */ }
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    await this.stopOwned()
    throw new FishDrawsError('ComfyUI did not become ready before the startup timeout', 'COMFY_START_TIMEOUT', 'startup')
  }

  scheduleIdleShutdown(): void {
    if (!this.startedByPlugin) return
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      void this.stopIfIdle().catch(() => { if (this.startedByPlugin) this.scheduleIdleShutdown() })
    }, this.config.comfy.idleShutdownMs)
    this.idleTimer.unref()
  }
  async unloadModels(signal?: AbortSignal): Promise<boolean> {
    if (await this.client.freeModels(signal).catch(() => false)) return true
    if (!this.startedByPlugin) return false
    await this.stopOwned()
    return true
  }
  cancelIdleShutdown(): void { if (this.idleTimer !== undefined) clearTimeout(this.idleTimer); this.idleTimer = undefined }
  async stopIfIdle(): Promise<void> { if (this.startedByPlugin && await this.client.queueIdle().catch(() => false)) await this.stopOwned() }
  async stopOwned(): Promise<void> {
    this.cancelIdleShutdown()
    if (!this.startedByPlugin && this.child === undefined) return
    const child = this.child
    if (child !== undefined && !this.childExited(child)) {
      const gracefulExit = this.waitChildExit(child, 10_000)
      child.kill('SIGTERM')
      await gracefulExit
      if (!this.childExited(child)) {
        const forcedExit = this.waitChildExit(child, 5_000)
        child.kill('SIGKILL')
        await forcedExit
      }
      if (!this.childExited(child)) throw new FishDrawsError('plugin-owned ComfyUI did not exit after termination', 'COMFY_STOP_FAILED', 'lifecycle')
    }
    if (child === undefined && this.managedPid !== undefined && this.pidAlive(this.managedPid)) {
      try { process.kill(this.managedPid, 'SIGTERM') } catch { /* already gone */ }
      await this.waitPidExit(this.managedPid, 10_000)
      if (this.pidAlive(this.managedPid)) {
        try { process.kill(this.managedPid, 'SIGKILL') } catch { /* already gone */ }
        await this.waitPidExit(this.managedPid, 5_000)
      }
      if (this.pidAlive(this.managedPid)) throw new FishDrawsError('plugin-owned ComfyUI did not exit after termination', 'COMFY_STOP_FAILED', 'lifecycle')
    }
    if (this.ownerPath !== undefined) await rm(this.ownerPath, { force: true })
    this.child = undefined; this.managedPid = undefined; this.startedByPlugin = false
  }
  private discoverPython(): string {
    if (this.config.comfy.pythonPath !== '') return this.config.comfy.pythonPath
    for (const candidate of [join(this.config.comfy.root, '..', 'python_embeded', 'python.exe'), join(this.config.comfy.root, 'python_embeded', 'python.exe')]) if (existsSync(candidate)) return candidate
    return 'python'
  }
  private async rotate(logPath: string): Promise<void> {
    try { if ((await stat(logPath)).size < this.config.storage.runtimeLogMaxBytes) return } catch { return }
    for (let index = this.config.storage.runtimeLogMaxFiles - 1; index >= 1; index -= 1) {
      const source = `${logPath}.${index}`; const destination = `${logPath}.${index + 1}`
      if (index + 1 > this.config.storage.runtimeLogMaxFiles) await rm(source, { force: true })
      else await rename(source, destination).catch(() => undefined)
    }
    await rename(logPath, `${logPath}.1`).catch(() => undefined)
  }
  private async readOwner(): Promise<{ pid: number } | undefined> {
    if (this.ownerPath === undefined) return undefined
    try { const value = JSON.parse(await readFile(this.ownerPath, 'utf8')) as { schema_version?: number; pid?: number }; return value.schema_version === 1 && Number.isInteger(value.pid) ? { pid: value.pid! } : undefined } catch { return undefined }
  }
  private async waitPidExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && this.pidAlive(pid)) await new Promise(resolve => setTimeout(resolve, 100))
  }
  private async waitChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (this.childExited(child)) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, timeoutMs)
      const onExit = (): void => done()
      function done(): void { clearTimeout(timer); child.off('exit', onExit); resolve() }
      child.once('exit', onExit)
      if (this.childExited(child)) done()
    })
  }
  private childExited(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null }
  private pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
}

import { FishDrawsError, errorMessage } from '../errors.js'
import type { WorkflowGraph } from './workflow-compiler.js'

export interface ComfyImageRecord { filename: string; subfolder: string; type: string }

export interface ComfyDeviceStats {
  type?: string
  name?: string
  torch_vram_total?: number
  vram_total?: number
  vram_free?: number
}

export interface ComfySystemStats {
  devices?: ComfyDeviceStats[]
  system?: { comfyui_version?: string; python_version?: string; os?: string }
}

export interface ComfyQueueState { running: number; pending: number; idle: boolean }

const MAX_UNLOADED_TORCH_VRAM_BYTES = 512 * 1024 * 1024

export class ComfyClient {
  constructor(readonly baseUrl: URL) {}

  private url(path: string): URL { return new URL(path.replace(/^\//, ''), this.baseUrl.href.endsWith('/') ? this.baseUrl : new URL(`${this.baseUrl.href}/`)) }

  async request<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000, allowEmptyResponse = false): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init.signal == null ? timeout : AbortSignal.any([timeout, init.signal])
    let response: Response
    try { response = await fetch(this.url(path), { ...init, signal }) }
    catch (error) { throw new FishDrawsError(`ComfyUI request failed: ${errorMessage(error)}`, 'COMFY_UNREACHABLE', 'technical', true) }
    if (!response.ok) throw new FishDrawsError(`ComfyUI ${path} returned HTTP ${response.status}`, 'COMFY_HTTP', 'technical', response.status >= 500)
    const body = await response.text()
    if (body.trim() === '') {
      if (allowEmptyResponse) return undefined as T
      throw new FishDrawsError(`ComfyUI ${path} returned an empty response where JSON was required`, 'COMFY_INVALID_JSON', 'technical', true)
    }
    try { return JSON.parse(body) as T }
    catch { throw new FishDrawsError(`ComfyUI ${path} returned invalid JSON`, 'COMFY_INVALID_JSON', 'technical', true) }
  }

  online(signal?: AbortSignal): Promise<unknown> { return this.systemStats(signal) }
  systemStats(signal?: AbortSignal): Promise<ComfySystemStats> { return this.request('/system_stats', signal === undefined ? {} : { signal }, 5_000) }
  async queueState(signal?: AbortSignal): Promise<ComfyQueueState> {
    const queue = await this.request<{ queue_running?: unknown[]; queue_pending?: unknown[] }>('/queue', signal === undefined ? {} : { signal }, 15_000)
    const running = queue.queue_running?.length ?? 0
    const pending = queue.queue_pending?.length ?? 0
    return { running, pending, idle: running === 0 && pending === 0 }
  }
  async queueIdle(signal?: AbortSignal): Promise<boolean> {
    return (await this.queueState(signal)).idle
  }
  async waitIdle(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      try { if (await this.queueIdle(signal)) return true } catch { /* retry until deadline */ }
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    return false
  }
  async freeModels(signal?: AbortSignal, timeoutMs = 120_000, pollIntervalMs = 500): Promise<boolean> {
    if (!await this.waitIdle(30_000, signal)) return false
    await this.request('/free', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }), ...(signal === undefined ? {} : { signal }) }, 30_000, true)
    const deadline = Date.now() + timeoutMs
    do {
      signal?.throwIfAborted()
      try {
        const [idle, stats] = await Promise.all([this.queueIdle(signal), this.systemStats(signal)])
        if (idle && this.modelsAreUnloaded(stats)) return true
      } catch { /* the control request succeeded; tolerate brief status races while memory is released */ }
      if (Date.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    } while (true)
    return false
  }

  private modelsAreUnloaded(stats: ComfySystemStats): boolean {
    const accelerators = (stats.devices ?? []).filter(device => device.type !== 'cpu')
    return accelerators.length > 0 && accelerators.every(device =>
      typeof device.torch_vram_total === 'number'
      && device.torch_vram_total >= 0
      && device.torch_vram_total <= MAX_UNLOADED_TORCH_VRAM_BYTES)
  }
  async submit(graph: WorkflowGraph, clientId: string, signal?: AbortSignal): Promise<string> {
    const result = await this.request<{ prompt_id?: string }>('/prompt', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: clientId }), ...(signal === undefined ? {} : { signal }),
    })
    if (typeof result.prompt_id !== 'string' || result.prompt_id.length === 0) throw new FishDrawsError('ComfyUI did not return a prompt id', 'MISSING_PROMPT_ID', 'technical', true)
    return result.prompt_id
  }
  async waitResult(promptId: string, timeoutMs: number, signal?: AbortSignal): Promise<ComfyImageRecord[]> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const history = await this.request<Record<string, any>>(`/history/${encodeURIComponent(promptId)}`, signal === undefined ? {} : { signal }, 15_000)
      const entry = history[promptId]
      if (entry?.status?.completed === true) {
        if (entry.status.status_str !== 'success') throw new FishDrawsError('ComfyUI reported a failed workflow', 'WORKFLOW_FAILED', 'technical', true)
        const images = entry.outputs?.['11']?.images
        if (!Array.isArray(images) || images.length === 0) throw new FishDrawsError('ComfyUI completed without a saved image', 'NO_OUTPUT_IMAGE', 'technical', true)
        return images as ComfyImageRecord[]
      }
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    throw new FishDrawsError(`ComfyUI prompt timed out after ${Math.round(timeoutMs / 1000)} seconds`, 'COMFY_TIMEOUT', 'technical', true)
  }
  async interrupt(promptId?: string): Promise<void> {
    await Promise.allSettled([
      this.request('/interrupt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(promptId === undefined ? {} : { prompt_id: promptId }) }, 15_000, true),
      promptId === undefined ? Promise.resolve() : this.request('/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) }, 15_000, true),
    ])
  }
  async deleteHistory(promptId: string): Promise<void> {
    await this.request('/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) }, 15_000, true).catch(() => undefined)
  }
}

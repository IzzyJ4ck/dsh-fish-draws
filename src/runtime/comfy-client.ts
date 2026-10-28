import { FishDrawsError, errorMessage } from '../errors.js'
import type { WorkflowGraph } from './workflow-compiler.js'

export interface ComfyImageRecord { filename: string; subfolder: string; type: string }

export class ComfyClient {
  constructor(readonly baseUrl: URL) {}

  private url(path: string): URL { return new URL(path.replace(/^\//, ''), this.baseUrl.href.endsWith('/') ? this.baseUrl : new URL(`${this.baseUrl.href}/`)) }

  async request<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init.signal == null ? timeout : AbortSignal.any([timeout, init.signal])
    let response: Response
    try { response = await fetch(this.url(path), { ...init, signal }) }
    catch (error) { throw new FishDrawsError(`ComfyUI request failed: ${errorMessage(error)}`, 'COMFY_UNREACHABLE', 'technical', true) }
    if (!response.ok) throw new FishDrawsError(`ComfyUI ${path} returned HTTP ${response.status}`, 'COMFY_HTTP', 'technical', response.status >= 500)
    return await response.json() as T
  }

  online(signal?: AbortSignal): Promise<unknown> { return this.request('/system_stats', signal === undefined ? {} : { signal }, 5_000) }
  async queueIdle(signal?: AbortSignal): Promise<boolean> {
    const queue = await this.request<{ queue_running?: unknown[]; queue_pending?: unknown[] }>('/queue', signal === undefined ? {} : { signal }, 15_000)
    return (queue.queue_running?.length ?? 0) === 0 && (queue.queue_pending?.length ?? 0) === 0
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
  async freeModels(signal?: AbortSignal): Promise<boolean> {
    if (!await this.waitIdle(30_000, signal)) return false
    await this.request('/free', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }), ...(signal === undefined ? {} : { signal }) })
    return this.waitIdle(30_000, signal)
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
      this.request('/interrupt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(promptId === undefined ? {} : { prompt_id: promptId }) }, 15_000),
      promptId === undefined ? Promise.resolve() : this.request('/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) }, 15_000),
    ])
  }
  async deleteHistory(promptId: string): Promise<void> {
    await this.request('/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) }, 15_000).catch(() => undefined)
  }
}

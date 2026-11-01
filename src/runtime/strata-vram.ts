import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { FishDrawsError } from '../errors.js'

interface VramState {
  elastic?: boolean
  reserve_mib?: number
  expert_slots?: number
  expert_slots_full?: number
  expert_cache_mib?: number
  expert_cache_full_mib?: number
  vram_free_mib?: number
}

interface Status {
  loaded?: boolean
  busy?: boolean
  in_flight?: number
  queued?: number
  activity?: { in_flight?: number }
  vram?: VramState
}

interface VramResult extends VramState { status?: string }

const RELEASE_SHORTFALL_TOLERANCE_MIB = 512
const RESTORE_CACHE_TOLERANCE_MIB = 512

export class StrataVram {
  private priorReserve: number | undefined
  private priorExpertCacheMiB: number | undefined
  private released = false
  constructor(
    private readonly endpoint: URL | undefined,
    private readonly credentialName: string,
    private readonly credentials: CredentialProvider,
    private readonly journalPath?: string,
    private readonly authMode: 'none' | 'bearer' = 'bearer',
  ) {}
  private async headers(): Promise<Record<string, string>> {
    if (this.authMode === 'none') return { 'content-type': 'application/json' }
    const value = (await this.credentials.resolve(credentialRef(this.credentialName)))?.value
    if (value === undefined) throw new FishDrawsError('Strata credential is not configured', 'STRATA_CREDENTIAL_MISSING', 'preflight')
    return { authorization: `Bearer ${value}`, 'content-type': 'application/json' }
  }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (this.endpoint === undefined) throw new FishDrawsError('Strata VRAM endpoint is not configured', 'STRATA_ENDPOINT_MISSING', 'preflight')
    const response = await fetch(new URL(path.replace(/^\//, ''), this.endpoint.href.endsWith('/') ? this.endpoint : new URL(`${this.endpoint.href}/`)), { ...init, headers: { ...await this.headers(), ...init.headers }, signal: init.signal == null ? AbortSignal.timeout(330_000) : AbortSignal.any([AbortSignal.timeout(330_000), init.signal]) })
    if (!response.ok) throw new FishDrawsError(`Strata returned HTTP ${response.status}`, 'STRATA_HTTP', 'lifecycle', true)
    return await response.json() as T
  }
  async status(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/v1/status', signal === undefined ? {} : { signal })
  }
  async waitIdle(signal?: AbortSignal, timeoutMs = 90_000, pollIntervalMs = 1_000): Promise<Status> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const status = await this.request<Status>('/v1/status', signal === undefined ? {} : { signal })
      if ((status.activity?.in_flight ?? status.in_flight ?? 0) === 0 && status.busy !== true && (status.queued ?? 0) === 0) return status
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }
    throw new FishDrawsError('Strata still has active or queued work', 'STRATA_BUSY', 'lifecycle')
  }
  async release(reserveMiB: number, signal?: AbortSignal): Promise<void> {
    const status = await this.waitIdle(signal)
    if (status.loaded !== true || status.vram?.elastic !== true) throw new FishDrawsError('Strata is not loaded with elastic VRAM enabled', 'STRATA_NOT_ELASTIC', 'lifecycle')
    this.priorReserve = status.vram.reserve_mib
    this.priorExpertCacheMiB = status.vram.expert_cache_mib
    if (this.journalPath !== undefined) {
      await mkdir(dirname(this.journalPath), { recursive: true })
      await writeFile(this.journalPath, JSON.stringify({ schema_version: 2, state: 'releasing', prior_reserve_mib: this.priorReserve ?? null, prior_expert_cache_mib: this.priorExpertCacheMiB ?? null, updated_at_utc: new Date().toISOString() }), { encoding: 'utf8', flag: 'w', mode: 0o600 })
    }
    this.released = true
    const result = await this.request<VramResult>('/v1/vram', { method: 'POST', body: JSON.stringify({ reserve_mib: reserveMiB }), ...(signal === undefined ? {} : { signal }) })
    const actualFree = result.vram_free_mib
    if (result.status !== 'ok' || actualFree === undefined || actualFree + RELEASE_SHORTFALL_TOLERANCE_MIB < reserveMiB) {
      throw new FishDrawsError(`Strata freed ${actualFree ?? 'an unknown amount of'} MiB; ${reserveMiB} MiB was requested`, 'STRATA_RELEASE_FAILED', 'lifecycle')
    }
    if (this.journalPath !== undefined) await writeFile(this.journalPath, JSON.stringify({ schema_version: 2, state: 'released', prior_reserve_mib: this.priorReserve ?? null, prior_expert_cache_mib: this.priorExpertCacheMiB ?? null, released_vram_free_mib: actualFree, updated_at_utc: new Date().toISOString() }), { encoding: 'utf8', flag: 'w', mode: 0o600 })
  }
  async restore(signal?: AbortSignal, timeoutMs = 30_000, pollIntervalMs = 1_000): Promise<boolean> {
    if (!this.released) return true
    const deadline = Date.now() + timeoutMs
    do {
      signal?.throwIfAborted()
      const result = await this.request<VramResult>('/v1/vram', { method: 'POST', body: JSON.stringify({ reserve_mib: this.priorReserve ?? null }), ...(signal === undefined ? {} : { signal }) })
      if (result.status !== 'ok') return false
      const status = await this.waitIdle(signal)
      const vram = status.vram ?? result
      const reserveRestored = this.priorReserve === undefined || vram.reserve_mib === this.priorReserve
      const cacheRestored = this.priorExpertCacheMiB === undefined
        || (vram.expert_cache_mib !== undefined && vram.expert_cache_mib + RESTORE_CACHE_TOLERANCE_MIB >= this.priorExpertCacheMiB)
      if (reserveRestored && cacheRestored) {
        this.released = false
        if (this.journalPath !== undefined) await rm(this.journalPath, { force: true })
        return true
      }
      if (Date.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    } while (true)
    return false
  }
  async recover(signal?: AbortSignal): Promise<boolean> {
    if (this.journalPath === undefined) return true
    let value: { schema_version?: number; state?: string; prior_reserve_mib?: number | null; prior_expert_cache_mib?: number | null }
    try { value = JSON.parse(await readFile(this.journalPath, 'utf8')) as typeof value } catch { return true }
    if (![1, 2].includes(value.schema_version ?? -1) || !['releasing', 'released'].includes(value.state ?? '')) throw new FishDrawsError('Strata recovery journal is invalid', 'STRATA_JOURNAL_INVALID', 'lifecycle')
    this.priorReserve = value.prior_reserve_mib ?? undefined
    this.priorExpertCacheMiB = value.prior_expert_cache_mib ?? undefined
    this.released = true
    await this.waitIdle(signal)
    return this.restore(signal)
  }
}

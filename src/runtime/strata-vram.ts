import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { FishDrawsError } from '../errors.js'

interface Status { loaded?: boolean; busy?: boolean; in_flight?: number; queued?: number; vram?: { elastic?: boolean; reserve_mib?: number } }

export class StrataVram {
  private priorReserve: number | undefined
  private released = false
  constructor(private readonly endpoint: URL | undefined, private readonly credentialName: string, private readonly credentials: CredentialProvider, private readonly journalPath?: string) {}
  private async headers(): Promise<Record<string, string>> {
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
  async waitIdle(signal?: AbortSignal): Promise<Status> {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const status = await this.request<Status>('/v1/status', signal === undefined ? {} : { signal })
      if ((status.in_flight ?? 0) === 0 && status.busy !== true && (status.queued ?? 0) === 0) return status
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    throw new FishDrawsError('Strata still has active or queued work', 'STRATA_BUSY', 'lifecycle')
  }
  async release(reserveMiB: number, signal?: AbortSignal): Promise<void> {
    const status = await this.waitIdle(signal)
    if (status.loaded !== true || status.vram?.elastic !== true) throw new FishDrawsError('Strata is not loaded with elastic VRAM enabled', 'STRATA_NOT_ELASTIC', 'lifecycle')
    this.priorReserve = status.vram.reserve_mib
    if (this.journalPath !== undefined) {
      await mkdir(dirname(this.journalPath), { recursive: true })
      await writeFile(this.journalPath, JSON.stringify({ schema_version: 1, state: 'releasing', prior_reserve_mib: this.priorReserve ?? null, updated_at_utc: new Date().toISOString() }), { encoding: 'utf8', flag: 'w', mode: 0o600 })
    }
    this.released = true
    const result = await this.request<{ status?: string; vram_free_mib?: number }>('/v1/vram', { method: 'POST', body: JSON.stringify({ reserve_mib: reserveMiB }), ...(signal === undefined ? {} : { signal }) })
    if (result.status !== 'ok' || (result.vram_free_mib ?? 0) < reserveMiB) throw new FishDrawsError('Strata could not free the requested VRAM reserve', 'STRATA_RELEASE_FAILED', 'lifecycle')
    if (this.journalPath !== undefined) await writeFile(this.journalPath, JSON.stringify({ schema_version: 1, state: 'released', prior_reserve_mib: this.priorReserve ?? null, updated_at_utc: new Date().toISOString() }), { encoding: 'utf8', flag: 'w', mode: 0o600 })
  }
  async restore(signal?: AbortSignal): Promise<boolean> {
    if (!this.released) return true
    const result = await this.request<{ status?: string }>('/v1/vram', { method: 'POST', body: JSON.stringify({ reserve_mib: this.priorReserve ?? null }), ...(signal === undefined ? {} : { signal }) })
    if (result.status !== 'ok') return false
    this.released = false
    if (this.journalPath !== undefined) await rm(this.journalPath, { force: true })
    return true
  }
  async recover(signal?: AbortSignal): Promise<boolean> {
    if (this.journalPath === undefined) return true
    let value: { schema_version?: number; state?: string; prior_reserve_mib?: number | null }
    try { value = JSON.parse(await readFile(this.journalPath, 'utf8')) as typeof value } catch { return true }
    if (value.schema_version !== 1 || !['releasing', 'released'].includes(value.state ?? '')) throw new FishDrawsError('Strata recovery journal is invalid', 'STRATA_JOURNAL_INVALID', 'lifecycle')
    this.priorReserve = value.prior_reserve_mib ?? undefined
    this.released = true
    await this.waitIdle(signal)
    return this.restore(signal)
  }
}

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResolvedConfig } from '../config.js'
import { FishDrawsError } from '../errors.js'
import type { DiagnosticPrepareRequest, DiagnosticRunView } from './types.js'

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/u

export class DiagnosticRunner {
  private readonly runs = new Map<string, DiagnosticRunView>()
  private readonly writes = new Map<string, Promise<void>>()
  private activeRunId: string | undefined
  constructor(private readonly configSource: () => ResolvedConfig) {}

  get active(): boolean { return this.activeRunId !== undefined }
  get activeRun(): DiagnosticRunView | undefined { return this.activeRunId === undefined ? undefined : this.runs.get(this.activeRunId) }
  get lastRunId(): string | undefined { return [...this.runs.values()].sort((a, b) => b.updatedAtUtc.localeCompare(a.updatedAtUtc))[0]?.runId }

  async recover(): Promise<void> {
    const root = join(this.configSource().storage.outputRoot, 'fish-draws', 'diagnostics')
    for (const runId of await readdir(root).catch(() => [])) {
      if (!RUN_ID.test(runId)) continue
      try {
        const report = JSON.parse(await readFile(join(root, runId, 'report.json'), 'utf8')) as Record<string, unknown>
        const value = reportToView(report)
        this.runs.set(value.runId, value)
        if (['prepared', 'running', 'cancelling'].includes(value.status)) {
          await this.settle(value.runId, { status: 'failed', failureClass: 'lifecycle', error: 'DSH restarted before the diagnostic reached a terminal state; resources were recovered during startup.' })
        }
      } catch { /* keep malformed reports for diagnose/manual inspection */ }
    }
    this.activeRunId = undefined
  }

  async prepare(request: DiagnosticPrepareRequest): Promise<DiagnosticRunView> {
    if (!RUN_ID.test(request.runId)) throw new FishDrawsError('diagnostic run id is invalid', 'INVALID_DIAGNOSTIC_RUN', 'preflight')
    if (this.activeRunId !== undefined) throw new FishDrawsError('another diagnostic is active', 'DIAGNOSTIC_BUSY', 'preflight')
    const config = this.configSource()
    const route = config.diagnostics.localModelRoutes.find(value => value.provider === request.provider && value.model === request.model && (value.reasoningEffort ?? '') === (request.reasoningEffort ?? ''))
    if (route === undefined || route.userConfirmedLocal !== true || route.status === 'unavailable') throw new FishDrawsError('diagnostic route is not an available user-confirmed local route', 'DIAGNOSTIC_ROUTE_NOT_ALLOWED', 'preflight')
    const profile = config.modelProfiles.find(value => value.id === request.profileId)
    if (profile === undefined) throw new FishDrawsError('diagnostic model profile was not found', 'DIAGNOSTIC_PROFILE_NOT_FOUND', 'preflight')
    const now = new Date().toISOString()
    const view: DiagnosticRunView = {
      runId: request.runId, sessionId: request.sessionId, status: 'prepared', profileId: profile.id,
      profileName: profile.name, profileHash: profile.profileHash,
      route: { provider: request.provider, model: request.model, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) },
      createdAtUtc: now, updatedAtUtc: now, stages: [{ name: 'prepared', startedAtUtc: now }],
    }
    this.runs.set(view.runId, view); this.activeRunId = view.runId
    await this.persist(view)
    return structuredClone(view)
  }

  forSession(sessionId: string): DiagnosticRunView | undefined {
    const active = this.activeRun
    return active?.sessionId === sessionId ? structuredClone(active) : undefined
  }

  forTask(taskId: string): DiagnosticRunView | undefined {
    const value = [...this.runs.values()].find(run => run.taskId === taskId)
    return value === undefined ? undefined : structuredClone(value)
  }

  async update(runId: string, patch: Partial<Omit<DiagnosticRunView, 'runId' | 'sessionId' | 'profileId' | 'profileName' | 'profileHash' | 'route' | 'createdAtUtc'>>): Promise<void> {
    const value = this.runs.get(runId)
    if (value === undefined) return
    Object.assign(value, patch, { updatedAtUtc: new Date().toISOString() })
    if (['completed', 'warning', 'failed', 'cancelled'].includes(value.status)) this.activeRunId = undefined
    await this.enqueuePersist(value)
  }

  stage(runId: string, name: string, detail?: string): void {
    const value = this.runs.get(runId)
    if (value === undefined) return
    const now = new Date(); const stages = value.stages ?? []
    const previous = stages.at(-1)
    if (previous !== undefined && previous.completedAtUtc === undefined) {
      previous.completedAtUtc = now.toISOString(); previous.durationMs = Math.max(0, now.getTime() - Date.parse(previous.startedAtUtc))
    }
    stages.push({ name, startedAtUtc: now.toISOString(), ...(detail === undefined ? {} : { detail: redact(detail) }) })
    value.stages = stages; value.updatedAtUtc = now.toISOString(); void this.enqueuePersist(value)
  }

  async settle(runId: string, patch: Partial<Omit<DiagnosticRunView, 'runId' | 'sessionId' | 'profileId' | 'profileName' | 'profileHash' | 'route' | 'createdAtUtc'>>): Promise<DiagnosticRunView> {
    const value = this.runs.get(runId)
    if (value === undefined) throw new FishDrawsError('diagnostic run was not found', 'DIAGNOSTIC_NOT_FOUND', 'preflight')
    const previous = value.stages?.at(-1); const now = new Date()
    if (previous !== undefined && previous.completedAtUtc === undefined) { previous.completedAtUtc = now.toISOString(); previous.durationMs = Math.max(0, now.getTime() - Date.parse(previous.startedAtUtc)) }
    Object.assign(value, patch, { updatedAtUtc: now.toISOString() })
    if (['completed', 'warning', 'failed', 'cancelled'].includes(value.status)) this.activeRunId = undefined
    await this.enqueuePersist(value)
    return structuredClone(value)
  }

  async status(runId: string): Promise<DiagnosticRunView> {
    if (!RUN_ID.test(runId)) throw new FishDrawsError('diagnostic run id is invalid', 'INVALID_DIAGNOSTIC_RUN', 'preflight')
    const memory = this.runs.get(runId)
    if (memory !== undefined) return structuredClone(memory)
    const config = this.configSource()
    const path = join(config.storage.outputRoot, 'fish-draws', 'diagnostics', runId, 'report.json')
    const report = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    return reportToView(report)
  }

  async cancel(runId: string): Promise<DiagnosticRunView> {
    const value = await this.status(runId)
    if (!['prepared', 'running'].includes(value.status)) return value
    await this.update(runId, { status: 'cancelling' })
    return this.status(runId)
  }

  async delete(runId: string): Promise<void> {
    const value = await this.status(runId)
    if (['prepared', 'running', 'cancelling'].includes(value.status)) throw new FishDrawsError('an active diagnostic cannot be deleted', 'DIAGNOSTIC_ACTIVE', 'preflight')
    const root = join(this.configSource().storage.outputRoot, 'fish-draws', 'diagnostics')
    const directory = join(root, runId)
    if (!directory.startsWith(`${root}\\`) && !directory.startsWith(`${root}/`)) throw new FishDrawsError('diagnostic path escaped its root', 'PATH_ESCAPE', 'preflight')
    await rm(directory, { recursive: true, force: true }); this.runs.delete(runId)
  }

  private async persist(value: DiagnosticRunView): Promise<void> {
    const root = join(this.configSource().storage.outputRoot, 'fish-draws', 'diagnostics', value.runId)
    await mkdir(root, { recursive: true })
    const report = {
      schema_version: 1, plugin_version: '3.1.0', run_id: value.runId, session_id: value.sessionId, status: value.status,
      route: value.route, model_profile: { id: value.profileId, name: value.profileName, sha256: value.profileHash },
      created_at_utc: value.createdAtUtc, updated_at_utc: value.updatedAtUtc,
      total_duration_ms: Math.max(0, Date.parse(value.updatedAtUtc) - Date.parse(value.createdAtUtc)),
      ...(value.taskId === undefined ? {} : { task_id: value.taskId }), ...(value.executionId === undefined ? {} : { execution_id: value.executionId }),
      ...(value.jobId === undefined ? {} : { job_id: value.jobId }),
      ...(value.expandedPrompt === undefined ? {} : { expanded_prompt: value.expandedPrompt }),
      ...(value.imageRelativePath === undefined ? {} : { image_relative_path: value.imageRelativePath }),
      ...(value.canvas === undefined ? {} : { canvas: value.canvas }), ...(value.stages === undefined ? {} : { stages: value.stages }),
      ...(value.lifecycle === undefined ? {} : { lifecycle: value.lifecycle }),
      ...(value.archivedManifest === undefined ? {} : { result_manifest: value.archivedManifest }),
      ...(value.failureClass === undefined ? {} : { failure_class: value.failureClass }), ...(value.error === undefined ? {} : { error: redact(value.error) }),
      report_sha256: createHash('sha256').update(JSON.stringify({ runId: value.runId, status: value.status, profileHash: value.profileHash })).digest('hex'),
    }
    const temporary = join(root, `.report-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
    const destination = join(root, 'report.json')
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try { await rename(temporary, destination) }
    catch { await rm(destination, { force: true }); await rename(temporary, destination) }
  }

  private enqueuePersist(value: DiagnosticRunView): Promise<void> {
    const snapshot = structuredClone(value)
    const previous = this.writes.get(value.runId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.persist(snapshot))
    this.writes.set(value.runId, current)
    void current.finally(() => { if (this.writes.get(value.runId) === current) this.writes.delete(value.runId) }).catch(() => undefined)
    return current
  }
}

function redact(value: string): string {
  return value.replace(/[A-Za-z]:\\[^\s"']+/gu, '<local-path>').replace(/Bearer\s+\S+/giu, 'Bearer <redacted>')
}

function reportToView(report: Record<string, unknown>): DiagnosticRunView {
  const profile = report.model_profile as Record<string, unknown>
  const route = report.route as DiagnosticRunView['route']
  const canvas = typeof report.canvas === 'object' && report.canvas !== null ? report.canvas as NonNullable<DiagnosticRunView['canvas']> : undefined
  const stages = Array.isArray(report.stages) ? report.stages as NonNullable<DiagnosticRunView['stages']> : undefined
  const lifecycle = typeof report.lifecycle === 'object' && report.lifecycle !== null ? report.lifecycle as NonNullable<DiagnosticRunView['lifecycle']> : undefined
  const archivedManifest = typeof report.result_manifest === 'object' && report.result_manifest !== null ? report.result_manifest as NonNullable<DiagnosticRunView['archivedManifest']> : undefined
  return {
    runId: String(report.run_id), sessionId: String(report.session_id ?? ''), status: report.status as DiagnosticRunView['status'],
    profileId: String(profile.id), profileName: String(profile.name), profileHash: String(profile.sha256), route,
    createdAtUtc: String(report.created_at_utc), updatedAtUtc: String(report.updated_at_utc),
    ...(typeof report.task_id === 'string' ? { taskId: report.task_id } : {}),
    ...(typeof report.execution_id === 'string' ? { executionId: report.execution_id } : {}),
    ...(typeof report.job_id === 'string' ? { jobId: report.job_id } : {}),
    ...(typeof report.expanded_prompt === 'string' ? { expandedPrompt: report.expanded_prompt } : {}),
    ...(typeof report.image_relative_path === 'string' ? { imageRelativePath: report.image_relative_path } : {}),
    ...(canvas === undefined ? {} : { canvas }), ...(stages === undefined ? {} : { stages }), ...(lifecycle === undefined ? {} : { lifecycle }),
    ...(archivedManifest === undefined ? {} : { archivedManifest }),
    ...(typeof report.failure_class === 'string' ? { failureClass: report.failure_class } : {}),
    ...(typeof report.error === 'string' ? { error: report.error } : {}),
  }
}

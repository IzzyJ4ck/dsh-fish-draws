import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { DiagnosticRunner } from '../src/settings-remote/diagnostics-runner.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('isolated diagnostic registry', () => {
  it('accepts only an exact user-confirmed local route and persists a redacted report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fish-diagnostic-')); roots.push(root)
    const config = resolveConfig({
      storage: { outputRoot: root },
      diagnostics: { localModelRoutes: [{ provider: 'local', model: 'strata', userConfirmedLocal: true, status: 'unverified' }] },
    })
    const runner = new DiagnosticRunner(() => config)
    await expect(runner.prepare({ runId: 'diag-12345678', sessionId: 'session-1', provider: 'cloud', model: 'strata', profileId: config.currentModelProfileId })).rejects.toThrow(/not an available/u)
    const prepared = await runner.prepare({ runId: 'diag-12345678', sessionId: 'session-1', provider: 'local', model: 'strata', profileId: config.currentModelProfileId })
    expect(prepared.status).toBe('prepared')
    const archivedManifest = { schema_version: 1, task_id: 'diag-task-1', outputs: [{ relative_path: 'image.png', width: 1024, height: 1024, seed: 7, sha256: 'image-hash' }] } as any
    await runner.settle(prepared.runId, { status: 'failed', failureClass: 'technical', error: `failed at ${join(root, 'secret')} Bearer should-not-leak`, taskId: 'diag-task-1', archivedManifest })
    const reportPath = join(root, 'fish-draws', 'diagnostics', prepared.runId, 'report.json')
    const report = await readFile(reportPath, 'utf8')
    expect(report).toContain('<local-path>')
    expect(report).toContain('Bearer <redacted>')
    expect(report).not.toContain('should-not-leak')
    await expect(runner.status(prepared.runId)).resolves.toMatchObject({ status: 'failed', sessionId: 'session-1' })
    const recovered = new DiagnosticRunner(() => config); await recovered.recover()
    expect(recovered.forTask('diag-task-1')?.archivedManifest?.outputs[0]).toMatchObject({ relative_path: 'image.png', seed: 7 })
    await runner.delete(prepared.runId)
  })

  it('refuses deletion while a diagnostic is active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fish-diagnostic-')); roots.push(root)
    const config = resolveConfig({ storage: { outputRoot: root }, diagnostics: { localModelRoutes: [{ provider: 'local', model: 'strata', userConfirmedLocal: true, status: 'unverified' }] } })
    const runner = new DiagnosticRunner(() => config)
    const prepared = await runner.prepare({ runId: 'diag-active-01', sessionId: 'session-2', provider: 'local', model: 'strata', profileId: config.currentModelProfileId })
    await expect(runner.delete(prepared.runId)).rejects.toThrow(/active diagnostic/u)
  })
})

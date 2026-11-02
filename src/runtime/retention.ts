import { constants } from 'node:fs'
import { copyFile, mkdir, open, rename, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { FishDrawsError } from '../errors.js'
import { readValidatedPng } from './image-metadata.js'
import { safeRelativePath } from './paths.js'
import type { CandidateRecord, OutputRecord } from './task-state.js'

async function sha(path: string): Promise<string> { return createHash('sha256').update(await readFile(path)).digest('hex') }

const transientWindowsFileErrors = new Set(['EBUSY', 'EACCES', 'EPERM'])
const promotionRetryDelaysMs = [50, 100, 250, 500, 1_000, 2_000]

function isTransientFileError(error: unknown): boolean {
  return transientWindowsFileErrors.has((error as NodeJS.ErrnoException | undefined)?.code ?? '')
}

async function retryTransient<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= promotionRetryDelaysMs.length; attempt += 1) {
    try { return await operation() }
    catch (error) {
      lastError = error
      if (!isTransientFileError(error) || attempt === promotionRetryDelaysMs.length) throw error
      await new Promise(resolve => setTimeout(resolve, promotionRetryDelaysMs[attempt]))
    }
  }
  throw lastError
}

async function copyVerified(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.partial-${process.pid}-${Date.now()}`
  try {
    await retryTransient(() => copyFile(source, temporary, constants.COPYFILE_EXCL))
    // Windows rejects FlushFileBuffers/fsync for a read-only handle.  Open the
    // private temporary copy read-write so durability works on every supported
    // platform without changing its bytes.
    const handle = await open(temporary, 'r+'); try { await handle.sync() } finally { await handle.close() }
    if (await sha(source) !== await sha(temporary)) throw new FishDrawsError('output copy failed hash verification', 'OUTPUT_COPY_MISMATCH', 'cleanup')
    await retryTransient(() => rename(temporary, destination))
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  // The authoritative output is already durable and hash-verified.  A transient
  // lock on the staging copy must not turn a successful generation into a lost
  // result; executor cleanup/journaling owns any source that remains locked.
  await retryTransient(() => rm(source, { force: true })).catch(() => undefined)
}

async function moveVerified(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  try { await retryTransient(() => rename(source, destination)); return }
  catch (error: any) {
    if (error?.code !== 'EXDEV' && !isTransientFileError(error)) throw error
  }
  // EXDEV requires copying.  On Windows, antivirus/indexing/preview handlers can
  // hold a newly-created ComfyUI PNG without delete sharing, making rename fail
  // while ordinary reads are already safe.  The same verified-copy path handles
  // that transient condition without rerunning the expensive generation.
  await copyVerified(source, destination)
}

export async function promoteOutput(input: {
  source: string; taskDirectory: string; outputIndex: number; seed: number; executionId: string; targetWidth: number; targetHeight: number
}): Promise<OutputRecord> {
  const metadata = await readValidatedPng(input.source)
  if (metadata.width !== input.targetWidth || metadata.height !== input.targetHeight) throw new FishDrawsError(`generated PNG is ${metadata.width}x${metadata.height}; expected ${input.targetWidth}x${input.targetHeight}`, 'OUTPUT_SIZE_MISMATCH', 'technical')
  const destination = join(input.taskDirectory, `image-${input.outputIndex}.png`)
  await moveVerified(input.source, destination)
  return { path: destination, relativePath: safeRelativePath(destination, input.taskDirectory), width: metadata.width, height: metadata.height, seed: input.seed, sha256: metadata.sha256, executionId: input.executionId, adopted: true }
}

export async function preserveCandidate(input: {
  source: string; taskDirectory: string; candidateIndex: number; outputIndex: number; seed: number; executionId: string; qualityCycle: number; targetWidth: number; targetHeight: number
}): Promise<CandidateRecord> {
  const metadata = await readValidatedPng(input.source)
  if (metadata.width !== input.targetWidth || metadata.height !== input.targetHeight) throw new FishDrawsError('candidate dimensions do not match target', 'OUTPUT_SIZE_MISMATCH', 'technical')
  const kind = input.qualityCycle > 0 ? 'rework' : 'attempt'
  const name = `${kind}-${String(input.candidateIndex).padStart(2, '0')}-image-${String(input.outputIndex).padStart(2, '0')}-seed-${input.seed}.png`
  const destination = join(input.taskDirectory, 'candidates', name)
  await moveVerified(input.source, destination)
  return { path: destination, relativePath: safeRelativePath(destination, input.taskDirectory), width: metadata.width, height: metadata.height, seed: input.seed, sha256: metadata.sha256, executionId: input.executionId, adopted: false, qualityCycle: input.qualityCycle, candidateKind: kind, candidateIndex: input.candidateIndex }
}

export async function removeManagedFile(path: string, taskDirectory: string): Promise<void> {
  const rel = safeRelativePath(path, taskDirectory)
  if (!rel.startsWith('candidates/') && !/^image-\d+\.png$/u.test(rel)) throw new FishDrawsError('refusing to remove an unmanaged task file', 'UNMANAGED_DELETE', 'cleanup')
  await rm(path, { force: true })
}

export async function cleanupEmptyCandidates(taskDirectory: string): Promise<void> {
  const directory = join(taskDirectory, 'candidates')
  try { if ((await stat(directory)).isDirectory()) await rmdir(directory) } catch { /* non-empty or absent */ }
}

export async function cleanupEmptyManagedDirectory(directory: string): Promise<boolean> {
  try { await rmdir(directory); return true }
  catch (error: any) {
    if (error?.code === 'ENOENT') return true
    if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return false
    throw error
  }
}

export function sourceFilename(record: { filename: string }): string { return basename(record.filename) }

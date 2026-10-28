import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { FishDrawsError } from '../errors.js'

function normalized(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export function isPathInside(candidate: string, root: string, allowRoot = false): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  if (rel === '') return allowRoot
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export async function canonicalExistingPath(path: string): Promise<string> {
  return realpath(resolve(path))
}

export async function assertExistingPathInside(candidate: string, root: string, label: string): Promise<string> {
  const [realCandidate, realRoot] = await Promise.all([
    canonicalExistingPath(candidate),
    canonicalExistingPath(root),
  ])
  if (!isPathInside(realCandidate, realRoot, false)) {
    throw new FishDrawsError(`${label} is outside its allowed root`, 'PATH_OUTSIDE_ROOT', 'preflight')
  }
  return realCandidate
}

export async function ensureDirectoryInside(candidate: string, root: string, allowRoot = false): Promise<string> {
  const absoluteRoot = resolve(root)
  const absoluteCandidate = resolve(candidate)
  if (!isPathInside(absoluteCandidate, absoluteRoot, allowRoot)) {
    throw new FishDrawsError('refusing to create a directory outside its allowed root', 'PATH_OUTSIDE_ROOT', 'preflight')
  }
  await mkdir(absoluteRoot, { recursive: true })
  const realRoot = await realpath(absoluteRoot)
  const rel = relative(absoluteRoot, absoluteCandidate)
  let cursor = absoluteRoot
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment)
    await mkdir(cursor, { recursive: true })
    const stat = await lstat(cursor)
    if (stat.isSymbolicLink()) {
      throw new FishDrawsError('reparse points are not allowed in managed paths', 'REPARSE_POINT', 'preflight')
    }
    const currentReal = await realpath(cursor)
    if (!isPathInside(currentReal, realRoot, true)) {
      throw new FishDrawsError('managed path escaped through a reparse point', 'PATH_OUTSIDE_ROOT', 'preflight')
    }
  }
  return realpath(absoluteCandidate)
}

export function assertRelativeUserPath(value: string): void {
  if (value.trim() === '' || isAbsolute(value)) {
    throw new FishDrawsError('workspace_file paths must be non-empty relative paths', 'INVALID_RELATIVE_PATH', 'preflight')
  }
  const parts = value.replaceAll('\\', '/').split('/')
  if (parts.some(part => part === '..' || part === '')) {
    throw new FishDrawsError('workspace_file paths cannot contain empty or parent segments', 'INVALID_RELATIVE_PATH', 'preflight')
  }
}

export function safeRelativePath(path: string, root: string): string {
  const rel = relative(resolve(root), resolve(path)).replaceAll('\\', '/')
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new FishDrawsError('path cannot be represented inside task directory', 'PATH_OUTSIDE_ROOT', 'cleanup')
  }
  return rel
}

export function samePath(left: string, right: string): boolean {
  return normalized(resolve(left)) === normalized(resolve(right))
}

export function nearestParent(path: string): string {
  return dirname(resolve(path))
}


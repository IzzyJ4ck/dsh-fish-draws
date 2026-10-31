import { constants } from 'node:fs'
import { access, lstat, mkdir, realpath, rename } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

export interface GitWorktreeEntry {
  path: string
  head?: string
  branch?: string
  detached: boolean
  bare: boolean
}

export interface LegacyRepositoryInspection {
  exists: boolean
  isGitRepository: boolean
  dirty: boolean | null
  gitCommonDirectory?: string
  isLinkedWorktree: boolean
  ownsCommonDirectory: boolean
  worktrees: GitWorktreeEntry[]
  migrationSafe: boolean
  unsafeReasons: string[]
}

export interface MigrationPaths {
  dshHome: string
  skill: string
  archive: string
}

export function migrationPaths(dshHome: string): MigrationPaths {
  const root = resolve(dshHome)
  return {
    dshHome: root,
    skill: join(root, 'skills', 'fish-draws'),
    archive: join(root, 'skills-archive', 'fish-draws-v2.2-93a7a6d'),
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(() => true, () => false)
}

function git(path: string, args: string[]): string {
  // Scope the ownership exception to this one fixed migration target and this
  // one Git process. This avoids mutating the user's global safe.directory
  // configuration while still allowing --check under a sandboxed Host user.
  const result = spawnSync('git', ['-c', `safe.directory=${resolve(path)}`, '-C', path, ...args], { encoding: 'utf8', shell: false })
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function parseWorktrees(value: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = []
  let current: GitWorktreeEntry | undefined
  for (const line of value.split(/\r?\n/u)) {
    if (line.startsWith('worktree ')) {
      if (current !== undefined) entries.push(current)
      current = { path: line.slice('worktree '.length), detached: false, bare: false }
    } else if (current !== undefined && line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    else if (current !== undefined && line.startsWith('branch ')) current.branch = line.slice('branch '.length)
    else if (current !== undefined && line === 'detached') current.detached = true
    else if (current !== undefined && line === 'bare') current.bare = true
  }
  if (current !== undefined) entries.push(current)
  return entries
}

function samePath(left: string, right: string): boolean {
  return resolve(left).replaceAll('\\', '/').toLowerCase() === resolve(right).replaceAll('\\', '/').toLowerCase()
}

export async function inspectLegacyRepository(path: string): Promise<LegacyRepositoryInspection> {
  if (!await exists(path)) {
    return { exists: false, isGitRepository: false, dirty: null, isLinkedWorktree: false, ownsCommonDirectory: false, worktrees: [], migrationSafe: false, unsafeReasons: ['legacy repository does not exist'] }
  }
  try {
    const topLevel = git(path, ['rev-parse', '--show-toplevel'])
    const commonDirectory = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    const worktrees = parseWorktrees(git(path, ['worktree', 'list', '--porcelain']))
    const dotGit = join(topLevel, '.git')
    const dotGitStat = await lstat(dotGit)
    const isLinkedWorktree = dotGitStat.isFile()
    const ownsCommonDirectory = dotGitStat.isDirectory() && samePath(commonDirectory, dotGit)
    const dirty = git(path, ['status', '--porcelain']) !== ''
    const unsafeReasons: string[] = []
    if (!samePath(topLevel, path)) unsafeReasons.push('the migration target is not the worktree root')
    if (dirty) unsafeReasons.push('the legacy repository has uncommitted changes')
    if (isLinkedWorktree) unsafeReasons.push('the legacy skill itself is a linked worktree and cannot be moved with a filesystem rename')
    if (worktrees.length > 1) unsafeReasons.push(`the repository has ${worktrees.length} registered worktrees; moving its common directory would invalidate linked worktree metadata`)
    if (!ownsCommonDirectory && !isLinkedWorktree) unsafeReasons.push('the Git common directory ownership could not be established')
    return {
      exists: true,
      isGitRepository: true,
      dirty,
      gitCommonDirectory: await realpath(commonDirectory).catch(() => resolve(commonDirectory)),
      isLinkedWorktree,
      ownsCommonDirectory,
      worktrees,
      migrationSafe: unsafeReasons.length === 0,
      unsafeReasons,
    }
  } catch {
    return { exists: true, isGitRepository: false, dirty: null, isLinkedWorktree: false, ownsCommonDirectory: false, worktrees: [], migrationSafe: false, unsafeReasons: ['legacy skill is not a readable Git worktree'] }
  }
}

function unsafeMigrationMessage(action: 'archive' | 'restore', inspection: LegacyRepositoryInspection): string {
  const reasons = inspection.unsafeReasons.join('; ')
  return `${action} refused: ${reasons}. Resolve or remove linked worktrees through Git first; the migration tool will not move a Git common directory and leave other worktrees broken.`
}

export async function applyLegacyMigration(dshHome: string): Promise<MigrationPaths> {
  const paths = migrationPaths(dshHome)
  if (await exists(paths.archive)) throw new Error('archive destination already exists')
  const inspection = await inspectLegacyRepository(paths.skill)
  if (!inspection.isGitRepository) throw new Error('legacy skill is not a Git repository')
  if (!inspection.migrationSafe) throw new Error(unsafeMigrationMessage('archive', inspection))
  await mkdir(dirname(paths.archive), { recursive: true })
  await rename(paths.skill, paths.archive)
  return paths
}

export async function restoreLegacyMigration(dshHome: string): Promise<MigrationPaths> {
  const paths = migrationPaths(dshHome)
  if (await exists(paths.skill)) throw new Error('skills/fish-draws already exists; disable the bundle and remove the conflict first')
  const inspection = await inspectLegacyRepository(paths.archive)
  if (!inspection.isGitRepository) throw new Error('legacy archive is not a Git repository')
  if (!inspection.migrationSafe) throw new Error(unsafeMigrationMessage('restore', inspection))
  await mkdir(dirname(paths.skill), { recursive: true })
  await rename(paths.archive, paths.skill)
  return paths
}

export async function migrationCheck(dshHome: string): Promise<Record<string, unknown>> {
  const paths = migrationPaths(dshHome)
  const skillExists = await exists(paths.skill)
  const archiveExists = await exists(paths.archive)
  const inspectionTarget = skillExists ? 'skill' : archiveExists ? 'archive' : null
  const repository = inspectionTarget === null
    ? await inspectLegacyRepository(paths.skill)
    : await inspectLegacyRepository(inspectionTarget === 'skill' ? paths.skill : paths.archive)
  return {
    dshHome: paths.dshHome,
    skillExists,
    archiveExists,
    inspectionTarget,
    repository,
    localSafetyOverride: {
      note: 'User-approved migration values for the previously calibrated local 32 GiB machine; do not treat as public defaults.',
      t2iBalanced: { maxSampleWidth: 2560, maxSampleHeight: 2560, maxSamplePixels: 3_686_400, reserveMiB: 21_504, approvalSource: 'user_override' },
      editSingleBalanced: { maxSampleWidth: 2560, maxSampleHeight: 2560, maxSamplePixels: 3_686_400, reserveMiB: 21_504, approvalSource: 'user_override' },
      editMultiBalanced: { maxSampleWidth: 2560, maxSampleHeight: 2560, maxSamplePixels: 3_686_400, reserveMiB: 21_504, approvalSource: 'user_override' },
      fastBatch: { maxSampleWidth: 2560, maxSampleHeight: 2560, maxSamplePixels: 3_686_400, reserveMiB: 21_504, approvalSource: 'user_override' },
    },
  }
}

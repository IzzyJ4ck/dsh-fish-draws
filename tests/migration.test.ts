import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { applyLegacyMigration, inspectLegacyRepository, migrationCheck, migrationPaths } from '../src/migration.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

async function createRepository(withLinkedWorktree: boolean): Promise<{ dshHome: string; repository: string; linked?: string }> {
  const dshHome = await mkdtemp(join(tmpdir(), 'fish-draws-migrate-'))
  roots.push(dshHome)
  const repository = migrationPaths(dshHome).skill
  await mkdir(repository, { recursive: true })
  git(repository, 'init')
  git(repository, 'config', 'user.name', 'fish-draws test')
  git(repository, 'config', 'user.email', 'fish-draws-test@example.invalid')
  await writeFile(join(repository, 'SKILL.md'), '# legacy\n', 'utf8')
  git(repository, 'add', 'SKILL.md')
  git(repository, 'commit', '-m', 'fixture')
  if (!withLinkedWorktree) return { dshHome, repository }
  const linked = join(dshHome, 'v3-worktree')
  git(repository, 'worktree', 'add', '-b', 'feat/v3-test', linked)
  return { dshHome, repository, linked }
}

describe('legacy skill migration worktree safety', () => {
  it('recognizes a Git common directory with a linked worktree', async () => {
    const fixture = await createRepository(true)
    const inspection = await inspectLegacyRepository(fixture.repository)
    expect(inspection).toMatchObject({ isGitRepository: true, ownsCommonDirectory: true, isLinkedWorktree: false, migrationSafe: false })
    expect(inspection.worktrees).toHaveLength(2)
    expect(inspection.unsafeReasons.join(' ')).toMatch(/registered worktrees/u)
    const check = await migrationCheck(fixture.dshHome) as { repository: { worktrees: unknown[]; migrationSafe: boolean } }
    expect(check.repository.worktrees).toHaveLength(2)
    expect(check.repository.migrationSafe).toBe(false)
  })

  it('refuses apply before moving a common directory used by linked worktrees', async () => {
    const fixture = await createRepository(true)
    await expect(applyLegacyMigration(fixture.dshHome)).rejects.toThrow(/moving its common directory would invalidate linked worktree metadata/u)
    expect(await readFile(join(fixture.repository, 'SKILL.md'), 'utf8')).toContain('legacy')
    expect(git(fixture.linked!, 'status', '--porcelain')).toBe('')
  })

  it('archives a clean standalone repository', async () => {
    const fixture = await createRepository(false)
    const paths = await applyLegacyMigration(fixture.dshHome)
    expect(await readFile(join(paths.archive, 'SKILL.md'), 'utf8')).toContain('legacy')
    expect(git(paths.archive, 'status', '--porcelain')).toBe('')
  })
})

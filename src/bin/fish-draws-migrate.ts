#!/usr/bin/env node
import { constants } from 'node:fs'
import { access, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const action = process.argv[2]
if (!['--check', '--apply', '--restore'].includes(action ?? '')) {
  process.stderr.write('Usage: fish-draws-migrate --check|--apply|--restore\n'); process.exitCode = 2
} else {
  const dshHome = resolve(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'))
  const skill = join(dshHome, 'skills', 'fish-draws')
  const archive = join(dshHome, 'skills-archive', 'fish-draws-v2.2-93a7a6d')
  const exists = async (path: string) => access(path, constants.F_OK).then(() => true, () => false)
  const dirty = () => spawnSync('git', ['-C', skill, 'status', '--porcelain'], { encoding: 'utf8', shell: false }).stdout.trim() !== ''
  if (action === '--check') {
    process.stdout.write(`${JSON.stringify({
      dshHome, skillExists: await exists(skill), archiveExists: await exists(archive), dirty: await exists(join(skill, '.git')) ? dirty() : null,
      localSafetyOverride: {
        note: 'User-approved migration values for the previously calibrated local 32 GiB machine; do not treat as public defaults.',
        t2iBalanced: { maxSampleWidth: 2560, maxSampleHeight: 2560, maxSamplePixels: 3_686_400, reserveMiB: 21_504, approvalSource: 'user_override' },
        editSingleBalanced: { maxSampleWidth: 2560, maxSampleHeight: 2560, maxSamplePixels: 3_686_400, reserveMiB: 21_504, approvalSource: 'user_override' },
        editMultiBalanced: { maxSampleWidth: 2560, maxSampleHeight: 2560, maxSamplePixels: 3_686_400, reserveMiB: 21_504, approvalSource: 'user_override' },
        fastBatch: { maxSampleWidth: 2560, maxSampleHeight: 2560, maxSamplePixels: 3_686_400, reserveMiB: 21_504, approvalSource: 'user_override' },
      },
    }, null, 2)}\n`)
  } else if (action === '--apply') {
    if (!await exists(skill)) throw new Error('legacy skill does not exist')
    if (!await exists(join(skill, '.git'))) throw new Error('legacy skill is not a Git repository')
    if (dirty()) throw new Error('legacy skill has uncommitted changes; migration refused')
    if (await exists(archive)) throw new Error('archive destination already exists')
    await mkdir(join(dshHome, 'skills-archive'), { recursive: true }); await rename(skill, archive)
    process.stdout.write(`Archived legacy skill at ${archive}\n`)
  } else {
    if (!await exists(archive)) throw new Error('legacy archive does not exist')
    if (await exists(skill)) throw new Error('skills/fish-draws already exists; disable the bundle and remove the conflict first')
    await mkdir(join(dshHome, 'skills'), { recursive: true }); await rename(archive, skill)
    process.stdout.write(`Restored legacy skill at ${skill}\n`)
  }
}

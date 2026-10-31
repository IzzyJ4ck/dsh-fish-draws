#!/usr/bin/env node
import { join, resolve } from 'node:path'
import { applyLegacyMigration, migrationCheck, restoreLegacyMigration } from '../migration.js'

const action = process.argv[2]
if (!['--check', '--apply', '--restore'].includes(action ?? '')) {
  process.stderr.write('Usage: fish-draws-migrate --check|--apply|--restore\n'); process.exitCode = 2
} else {
  const dshHome = resolve(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'))
  if (action === '--check') {
    process.stdout.write(`${JSON.stringify(await migrationCheck(dshHome), null, 2)}\n`)
  } else if (action === '--apply') {
    const paths = await applyLegacyMigration(dshHome)
    process.stdout.write(`Archived legacy skill at ${paths.archive}\n`)
  } else {
    const paths = await restoreLegacyMigration(dshHome)
    process.stdout.write(`Restored legacy skill at ${paths.skill}\n`)
  }
}

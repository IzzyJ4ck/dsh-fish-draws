import { deflateSync } from 'node:zlib'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rename: vi.fn() }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  mocks.rename.mockImplementation(actual.rename)
  return { ...actual, rename: mocks.rename }
})

import { promoteOutput } from '../src/runtime/retention.js'

function png(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const chunk = (type: string, data: Buffer) => Buffer.concat([Buffer.from([(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255]), Buffer.from(type), data, Buffer.alloc(4)])
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  const rows = Buffer.alloc((width * 4 + 1) * height)
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

describe('Windows output promotion locks', () => {
  it('retries EBUSY without regenerating or losing the verified PNG', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const root = await mkdtemp(join(tmpdir(), 'fish-retention-lock-'))
    const staging = join(root, 'stage.png')
    await writeFile(staging, png(24, 12))
    let transientFailures = 2
    mocks.rename.mockImplementation(async (source, destination) => {
      if (source === staging && transientFailures > 0) {
        transientFailures -= 1
        throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' })
      }
      return actual.rename(source, destination)
    })

    const output = await promoteOutput({ source: staging, taskDirectory: root, outputIndex: 1, seed: 11, executionId: 'run', targetWidth: 24, targetHeight: 12 })

    expect(mocks.rename).toHaveBeenCalledTimes(3)
    expect(output.relativePath).toBe('image-1.png')
    expect(await readdir(root)).toEqual(['image-1.png'])
  })

  it('falls back to a hash-verified copy when the staging file remains rename-locked', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const root = await mkdtemp(join(tmpdir(), 'fish-retention-copy-'))
    const staging = join(root, 'stage.png')
    await writeFile(staging, png(40, 20))
    mocks.rename.mockImplementation(async (source, destination) => {
      if (source === staging) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' })
      return actual.rename(source, destination)
    })

    const output = await promoteOutput({ source: staging, taskDirectory: root, outputIndex: 1, seed: 12, executionId: 'run', targetWidth: 40, targetHeight: 20 })

    expect(output.relativePath).toBe('image-1.png')
    expect(await readdir(root)).toEqual(['image-1.png'])
  }, 10_000)
})

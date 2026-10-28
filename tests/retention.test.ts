import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { promoteOutput, preserveCandidate } from '../src/runtime/retention.js'

function png(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const chunk = (type: string, data: Buffer) => Buffer.concat([Buffer.from([(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255]), Buffer.from(type), data, Buffer.alloc(4)])
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  const rows = Buffer.alloc((width * 4 + 1) * height)
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

describe('authoritative retention', () => {
  it('promotes one validated PNG to the task root without a duplicate source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fish-retention-')); const staging = join(root, 'stage.png'); await writeFile(staging, png(32, 16))
    const output = await promoteOutput({ source: staging, taskDirectory: root, outputIndex: 1, seed: 7, executionId: 'run', targetWidth: 32, targetHeight: 16 })
    expect(output.relativePath).toBe('image-1.png')
    expect(await readdir(root)).toEqual(['image-1.png'])
    expect(output.sha256).toBe(createHash('sha256').update(await readFile(join(root, 'image-1.png'))).digest('hex'))
  })
  it('retains only fully valid candidates under candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fish-candidate-')); const staging = join(root, 'stage.png'); await writeFile(staging, png(16, 16))
    const candidate = await preserveCandidate({ source: staging, taskDirectory: root, candidateIndex: 1, outputIndex: 1, seed: 3, executionId: 'run', qualityCycle: 1, targetWidth: 16, targetHeight: 16 })
    expect(candidate.relativePath).toMatch(/^candidates\/rework-01-image-01-seed-3\.png$/u)
  })
})

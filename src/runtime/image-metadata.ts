import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { FishDrawsError } from '../errors.js'

export interface ImageMetadata {
  width: number
  height: number
  sha256: string
  format: 'png' | 'jpeg' | 'gif' | 'webp'
  bytes: number
  hasAlpha?: boolean
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_IMAGE_BYTES = 256 * 1024 * 1024

function u24le(buffer: Buffer, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16)
}

function pngMetadata(buffer: Buffer): Omit<ImageMetadata, 'sha256' | 'bytes'> {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new FishDrawsError('invalid PNG signature', 'INVALID_IMAGE', 'preflight')
  }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const bitDepth = buffer[24]
  const colorType = buffer[25]
  if (width < 1 || height < 1 || bitDepth === undefined || colorType === undefined) {
    throw new FishDrawsError('invalid PNG dimensions', 'INVALID_IMAGE', 'preflight')
  }
  let offset = 8
  let sawIhdr = false
  let sawIend = false
  let hasTrns = false
  const idat: Buffer[] = []
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) throw new FishDrawsError('truncated PNG chunk', 'INVALID_IMAGE', 'preflight')
    if (type === 'IHDR') sawIhdr = true
    if (type === 'tRNS') hasTrns = true
    if (type === 'IDAT') idat.push(buffer.subarray(dataStart, dataEnd))
    if (type === 'IEND') {
      sawIend = true
      if (dataEnd + 4 !== buffer.length) {
        const trailing = buffer.subarray(dataEnd + 4)
        if (trailing.some(value => value !== 0)) throw new FishDrawsError('unexpected bytes after PNG IEND', 'INVALID_IMAGE', 'preflight')
      }
      break
    }
    offset = dataEnd + 4
  }
  if (!sawIhdr || !sawIend || idat.length === 0) throw new FishDrawsError('incomplete PNG', 'INVALID_IMAGE', 'preflight')
  try {
    inflateSync(Buffer.concat(idat), { finishFlush: 4 })
  } catch {
    throw new FishDrawsError('PNG pixel stream is damaged', 'INVALID_IMAGE', 'preflight')
  }
  return { width, height, format: 'png', hasAlpha: colorType === 4 || colorType === 6 || hasTrns }
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new FishDrawsError('invalid JPEG signature', 'INVALID_IMAGE', 'preflight')
  }
  let offset = 2
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue }
    const marker = buffer[offset + 1]!
    offset += 2
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > buffer.length) break
    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > buffer.length) break
    if (sof.has(marker)) {
      if (length < 7) break
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) }
    }
    offset += length
  }
  throw new FishDrawsError('JPEG has no supported frame header', 'INVALID_IMAGE', 'preflight')
}

function webpDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    throw new FishDrawsError('invalid WebP header', 'INVALID_IMAGE', 'preflight')
  }
  const chunk = buffer.toString('ascii', 12, 16)
  if (chunk === 'VP8X') return { width: 1 + u24le(buffer, 24), height: 1 + u24le(buffer, 27) }
  if (chunk === 'VP8 ' && buffer.length >= 30) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  throw new FishDrawsError('unsupported WebP frame', 'INVALID_IMAGE', 'preflight')
}

export async function readImageMetadata(path: string): Promise<ImageMetadata> {
  const info = await stat(path)
  if (!info.isFile() || info.size < 10 || info.size > MAX_IMAGE_BYTES) {
    throw new FishDrawsError('image is missing, empty, or exceeds 256 MiB', 'INVALID_IMAGE', 'preflight')
  }
  const buffer = await readFile(path)
  let parsed: Omit<ImageMetadata, 'sha256' | 'bytes'>
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    parsed = pngMetadata(buffer)
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    parsed = { ...jpegDimensions(buffer), format: 'jpeg' }
  } else if (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a') {
    parsed = { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), format: 'gif' }
  } else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    parsed = { ...webpDimensions(buffer), format: 'webp' }
  } else {
    throw new FishDrawsError('unsupported image format', 'UNSUPPORTED_IMAGE', 'preflight')
  }
  if (parsed.width < 1 || parsed.height < 1) throw new FishDrawsError('image has invalid dimensions', 'INVALID_IMAGE', 'preflight')
  return {
    ...parsed,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

export async function readValidatedPng(path: string): Promise<ImageMetadata & { format: 'png' }> {
  const metadata = await readImageMetadata(path)
  if (metadata.format !== 'png') throw new FishDrawsError('generated output must be PNG', 'INVALID_OUTPUT_FORMAT', 'technical')
  return metadata as ImageMetadata & { format: 'png' }
}


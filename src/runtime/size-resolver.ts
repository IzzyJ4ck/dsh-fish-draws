import type { ResolvedConfig, ResolvedSafetyProfile } from '../config.js'
import { FishDrawsError } from '../errors.js'

export type TaskMode = 't2i' | 'edit'
export type Acceleration = 'balanced' | 'fast'

export interface ReferenceDimension {
  width: number
  height: number
}

export const RATIO_SIZES: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  '1:1': [1440, 1440],
  '3:2': [1728, 1152],
  '2:3': [1152, 1728],
  '4:3': [1664, 1248],
  '3:4': [1248, 1664],
  '5:4': [1600, 1280],
  '4:5': [1280, 1600],
  '16:10': [1792, 1120],
  '10:16': [1120, 1792],
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '2:1': [2048, 1024],
  '1:2': [1024, 2048],
  '21:9': [2016, 864],
  '9:21': [864, 2016],
  '3:1': [2040, 680],
  '1:3': [680, 2040],
})

export interface SizeRequest {
  mode: TaskMode
  references: readonly ReferenceDimension[]
  targetWidth?: number
  targetHeight?: number
  aspectRatio?: string
  sizeReferenceIndex?: number
}

export interface ResolvedCanvas {
  targetWidth: number
  targetHeight: number
  sampleWidth: number
  sampleHeight: number
  sizeSource: string
  outpaintingRequired: boolean
}

export function sampleDimension(value: number): number {
  return Math.ceil(value / 16) * 16
}

function aspectChanged(left: ReferenceDimension, right: ReferenceDimension): boolean {
  return Math.abs(left.width * right.height - right.width * left.height) > Math.max(left.width * right.height, right.width * left.height) * 0.001
}

export function resolveCanvas(request: SizeRequest): ResolvedCanvas {
  const exactSupplied = request.targetWidth !== undefined || request.targetHeight !== undefined
  let targetWidth: number
  let targetHeight: number
  let sizeSource: string
  if (exactSupplied) {
    if (request.targetWidth === undefined || request.targetHeight === undefined) {
      throw new FishDrawsError('target_width and target_height must be supplied together', 'INCOMPLETE_SIZE', 'preflight')
    }
    targetWidth = request.targetWidth
    targetHeight = request.targetHeight
    sizeSource = 'explicit'
  } else if (request.sizeReferenceIndex !== undefined) {
    if (request.mode !== 'edit') throw new FishDrawsError('size_reference_index is only valid for editing', 'INVALID_SIZE_SOURCE', 'preflight')
    const reference = request.references[request.sizeReferenceIndex]
    if (reference === undefined) throw new FishDrawsError('size reference is outside the supplied image range', 'INVALID_SIZE_REFERENCE', 'preflight')
    targetWidth = reference.width
    targetHeight = reference.height
    sizeSource = `reference:${request.sizeReferenceIndex + 1}`
  } else if (request.aspectRatio !== undefined && request.aspectRatio.trim() !== '') {
    const size = RATIO_SIZES[request.aspectRatio]
    if (size === undefined) {
      throw new FishDrawsError(`unsupported aspect ratio ${request.aspectRatio}; provide exact dimensions`, 'UNSUPPORTED_RATIO', 'preflight')
    }
    ;[targetWidth, targetHeight] = size
    sizeSource = `ratio:${request.aspectRatio}`
  } else if (request.mode === 'edit') {
    const first = request.references[0]
    if (first === undefined) throw new FishDrawsError('editing requires at least one reference image', 'MISSING_REFERENCE', 'preflight')
    targetWidth = first.width
    targetHeight = first.height
    sizeSource = 'reference:1-default'
  } else {
    throw new FishDrawsError('text-to-image requires a supported aspect ratio or exact dimensions', 'MISSING_SIZE', 'preflight')
  }
  if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight) || targetWidth < 16 || targetHeight < 16 || targetWidth > 100_000 || targetHeight > 100_000) {
    throw new FishDrawsError('target dimensions must be integers between 16 and 100000', 'INVALID_SIZE', 'preflight')
  }
  const target = { width: targetWidth, height: targetHeight }
  return {
    targetWidth,
    targetHeight,
    sampleWidth: sampleDimension(targetWidth),
    sampleHeight: sampleDimension(targetHeight),
    sizeSource,
    outpaintingRequired: request.mode === 'edit' && request.references[0] !== undefined
      ? aspectChanged(request.references[0], target)
      : false,
  }
}

export type SafetyProfileName = keyof ResolvedConfig['safety']

export function safetyProfileName(mode: TaskMode, inputCount: number, acceleration: Acceleration, count: number): SafetyProfileName {
  if (acceleration === 'fast' || count > 1) return 'fast-batch'
  if (mode === 't2i') return 't2i-balanced'
  return inputCount > 1 ? 'edit-multi-balanced' : 'edit-single-balanced'
}

export function canvasWithinProfile(canvas: ResolvedCanvas, profile: ResolvedSafetyProfile): boolean {
  return canvas.sampleWidth <= profile.maxSampleWidth
    && canvas.sampleHeight <= profile.maxSampleHeight
    && canvas.sampleWidth * canvas.sampleHeight <= profile.maxSamplePixels
}


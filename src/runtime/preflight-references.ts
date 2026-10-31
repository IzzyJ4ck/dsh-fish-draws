import { FishDrawsError } from '../errors.js'
import type { ResolvedReference } from './task-state.js'
import type { TaskMode } from './size-resolver.js'

export interface PlannedReferences {
  references: ResolvedReference[]
  sizeReferenceIndex?: number
}

function assertReferenceIndex(value: number, length: number, label: 'content canvas' | 'size reference', code: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= length) {
    throw new FishDrawsError(`${label} index is outside the reference range`, code, 'preflight')
  }
}

/**
 * Validate task-specific reference indices, normalize the content image to
 * <image1>, and preserve the upload-order meaning of size_reference_index.
 */
export function planPreflightReferences(
  mode: TaskMode,
  references: readonly ResolvedReference[],
  contentCanvasIndex?: number,
  sizeReferenceIndex?: number,
): PlannedReferences {
  if (mode === 't2i') {
    if (references.length !== 0) {
      throw new FishDrawsError('t2i does not accept reference images', 'UNEXPECTED_REFERENCE', 'preflight')
    }
    if (contentCanvasIndex !== undefined) {
      throw new FishDrawsError('content_canvas_index is only valid for editing', 'INVALID_CONTENT_CANVAS', 'preflight')
    }
    if (sizeReferenceIndex !== undefined) {
      throw new FishDrawsError('size_reference_index is only valid for editing', 'INVALID_SIZE_SOURCE', 'preflight')
    }
    return { references: [] }
  }

  const contentIndex = contentCanvasIndex ?? 0
  assertReferenceIndex(contentIndex, references.length, 'content canvas', 'INVALID_CONTENT_CANVAS')
  if (sizeReferenceIndex !== undefined) {
    assertReferenceIndex(sizeReferenceIndex, references.length, 'size reference', 'INVALID_SIZE_REFERENCE')
  }

  const originalIndices = [contentIndex, ...references.map((_, index) => index).filter(index => index !== contentIndex)]
  const normalized = originalIndices.map((originalIndex, normalizedIndex) => ({
    ...references[originalIndex]!,
    imageTag: `<image${normalizedIndex + 1}>`,
  }))
  if (sizeReferenceIndex === undefined) return { references: normalized }

  const normalizedSizeReferenceIndex = originalIndices.indexOf(sizeReferenceIndex)
  if (normalizedSizeReferenceIndex < 0) {
    throw new FishDrawsError('size reference index is outside the reference range', 'INVALID_SIZE_REFERENCE', 'preflight')
  }
  return { references: normalized, sizeReferenceIndex: normalizedSizeReferenceIndex }
}

import { isAbsolute, resolve } from 'node:path'
import { FishDrawsError } from '../errors.js'
import type { ResultManifest } from './result-manifest.js'
import { isPathInside } from './paths.js'

function managedOutputPath(taskDirectory: string, relativePath: string): string {
  if (relativePath.trim() === '' || isAbsolute(relativePath)) throw new FishDrawsError('result manifest contains a non-relative output path', 'UNSAFE_RESULT_PATH', 'cleanup')
  const path = resolve(taskDirectory, relativePath)
  if (!isPathInside(path, taskDirectory)) throw new FishDrawsError('result manifest output escaped its task directory', 'UNSAFE_RESULT_PATH', 'cleanup')
  return path
}

export function buildPublicResult(manifest: ResultManifest, taskDirectory: string) {
  const outputs = manifest.outputs.map(output => ({ ...output, path: managedOutputPath(taskDirectory, output.relative_path) }))
  const candidates = manifest.candidates.map(candidate => ({ ...candidate, path: managedOutputPath(taskDirectory, candidate.relative_path) }))
  return { ...manifest, images: outputs.map(output => output.path), outputs, candidates }
}

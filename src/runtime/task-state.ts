import type { FailureClass } from '../errors.js'
import type { Acceleration, TaskMode } from './size-resolver.js'

export type TaskStatus =
  | 'prepared'
  | 'queued'
  | 'running'
  | 'awaiting_selection'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed'
  | 'cancelled'

export interface ReferenceRecord {
  sha256: string
  imageTag: string
  width: number
  height: number
  normalizedFromOriginal?: boolean
}

export interface OutputRecord {
  path: string
  relativePath: string
  width: number
  height: number
  seed: number
  sha256: string
  executionId: string
  adopted: boolean
}

export interface CandidateRecord extends OutputRecord {
  qualityCycle: number
  candidateKind: 'attempt' | 'rework'
  candidateIndex: number
}

export interface CleanupRecord {
  complete: boolean
  temporaryInputsRemoved: boolean
  workflowRemoved: boolean
  queueStateRemoved: boolean
  residualItems: string[]
}

export interface TaskRecord {
  taskId: string
  contractHash: string
  executionId: string
  mode: TaskMode
  status: TaskStatus
  createdAtUtc: string
  completedAtUtc?: string
  originalPrompt: string
  expandedPrompt: string
  references: ReferenceRecord[]
  targetWidth: number
  targetHeight: number
  sampleWidth: number
  sampleHeight: number
  sizeSource: string
  outpaintingRequired: boolean
  acceleration: Acceleration
  steps: number
  technicalAttempts: number
  qualityCycle: number
  qualityReworkOccurred: boolean
  adoptedExecutionId?: string
  outputs: OutputRecord[]
  candidates: CandidateRecord[]
  comfyStartedByPlugin: boolean
  comfyModelsUnloaded: boolean
  strataRestored: boolean
  cleanup: CleanupRecord
  failure?: { class: FailureClass; code: string; message: string }
}

export interface ResolvedReference {
  path: string
  sha256: string
  width: number
  height: number
  imageTag: string
}

export interface TechnicalAttemptState {
  executionId: string
  attempt: number
  startedAtUtc: string
  completed: boolean
  error?: string
}


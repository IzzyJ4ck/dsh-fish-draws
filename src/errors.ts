export type FailureClass =
  | 'startup'
  | 'preflight'
  | 'technical'
  | 'quality'
  | 'lifecycle'
  | 'cleanup'
  | 'cancelled'

export class FishDrawsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly failureClass: FailureClass,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'FishDrawsError'
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return '[unrenderable error]'
  }
}


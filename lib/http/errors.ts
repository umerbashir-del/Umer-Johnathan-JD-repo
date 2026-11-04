export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details?: Record<string, unknown>) { super(code); }
}

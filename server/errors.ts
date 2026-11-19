// An error the HTTP layer reports to the client as `{ code, message, ...extra }` with
// `status`. Anything that is not an ApiError is a bug and becomes a 500.
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly extra: Record<string, unknown>;

  constructor(code: string, status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

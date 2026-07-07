export class StraddleApiError extends Error {
  readonly status: number;
  readonly errorBody: unknown;
  readonly path: string;
  readonly retryable: boolean;
  readonly requestId?: string;

  constructor(args: {
    status: number;
    errorBody: unknown;
    path: string;
    message: string;
    retryable?: boolean;
    requestId?: string;
    cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = "StraddleApiError";
    this.status = args.status;
    this.errorBody = args.errorBody;
    this.path = args.path;
    this.retryable = args.retryable ?? (args.status === 429 || args.status >= 500);
    if (args.requestId !== undefined) this.requestId = args.requestId;
  }
}

export function isStraddleApiError(error: unknown): error is StraddleApiError {
  return (
    error instanceof StraddleApiError ||
    (typeof error === "object" &&
      error !== null &&
      "status" in error &&
      "errorBody" in error &&
      "path" in error &&
      "retryable" in error)
  );
}

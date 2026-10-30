/** Answers the request with this status and message. */
export class AddonError extends Error {
  readonly status: number;
  /** Seconds, sent as `Retry-After`. */
  readonly retryAfter?: number;

  constructor(
    status: number,
    message: string,
    options?: { retryAfter?: number; cause?: unknown }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'AddonError';
    this.status = status;
    this.retryAfter = options?.retryAfter;
  }
}

export function notFound(message = 'Not found'): never {
  throw new AddonError(404, message);
}

/** The definition contradicts its manifest. */
export class AddonDefinitionError extends Error {
  override name = 'AddonDefinitionError';
}

/** A response a client would reject or misread. */
export class ResponseValidationError extends Error {
  override name = 'ResponseValidationError';

  constructor(
    readonly resource: string,
    readonly issues: string
  ) {
    super(`${resource} response: ${issues}`);
  }
}

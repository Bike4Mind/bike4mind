export class LocalRuntimeError extends Error {
  constructor(
    message: string,
    readonly runtimeId: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'LocalRuntimeError';
  }
}

export class RuntimeUnsupportedError extends LocalRuntimeError {
  constructor(
    runtimeId: string,
    readonly operation: string
  ) {
    super(`${runtimeId} does not support ${operation}`, runtimeId);
    this.name = 'RuntimeUnsupportedError';
  }
}

export class RuntimeHttpError extends LocalRuntimeError {
  constructor(
    message: string,
    runtimeId: string,
    readonly status: number,
    /** The JSON `error` (OpenAI/Ollama) or string `detail` (FastAPI); null for unsupported bodies. */
    readonly detail: string | null = null
  ) {
    super(message, runtimeId);
    this.name = 'RuntimeHttpError';
  }
}

/** No HTTP answer: refused, reset, unresolvable host, or timed out. The underlying error is `cause`. */
export class RuntimeConnectionError extends LocalRuntimeError {
  constructor(message: string, runtimeId: string, options: { cause: unknown }) {
    super(message, runtimeId, options);
    this.name = 'RuntimeConnectionError';
  }
}

/** The runtime answered, but not in the shape its API documents. */
export class RuntimeProtocolError extends LocalRuntimeError {
  constructor(message: string, runtimeId: string, options?: { cause?: unknown }) {
    super(message, runtimeId, options);
    this.name = 'RuntimeProtocolError';
  }
}

/**
 * Hugging Face refused a repo: `'gated'` until the token holder accepts its terms, `'unauthorized'` for a missing
 * or rejected token, or a private repo the token cannot read.
 */
export class HubAccessError extends RuntimeHttpError {
  constructor(
    message: string,
    runtimeId: string,
    status: number,
    readonly repo: string,
    readonly reason: 'gated' | 'unauthorized'
  ) {
    super(message, runtimeId, status);
    this.name = 'HubAccessError';
  }
}

export class HubRateLimitError extends RuntimeHttpError {
  constructor(
    message: string,
    runtimeId: string,
    /** From `Retry-After`, else the `RateLimit` reset; null when neither is sent. */
    readonly retryAfterMs: number | null
  ) {
    super(message, runtimeId, 429);
    this.name = 'HubRateLimitError';
  }
}

export class ModelNotFoundError extends LocalRuntimeError {
  constructor(
    runtimeId: string,
    readonly model: string,
    options?: { cause?: unknown }
  ) {
    super(`${runtimeId} has no model named ${model}`, runtimeId, options);
    this.name = 'ModelNotFoundError';
  }
}

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
    /** The `error` message of an OpenAI/Ollama-style JSON body; null when the body was not that shape. */
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

export type GgufFormatErrorReason = 'truncated' | 'unsupported' | 'invalid' | 'limit';

/** A GGUF header that is truncated, malformed, in an unsupported version or byte order, or past a read limit. */
export class GgufFormatError extends LocalRuntimeError {
  constructor(
    message: string,
    readonly reason: GgufFormatErrorReason
  ) {
    super(message, 'gguf');
    this.name = 'GgufFormatError';
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

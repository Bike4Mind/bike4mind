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

/** A downloaded file whose size or sha256 does not match; the partial file has been deleted. */
export class DownloadVerificationError extends LocalRuntimeError {
  constructor(
    message: string,
    runtimeId: string,
    readonly check: 'size' | 'sha256',
    readonly expected: string,
    readonly actual: string
  ) {
    super(message, runtimeId);
    this.name = 'DownloadVerificationError';
  }
}

/** A managed llama-server process that exited before it was ready. `log` holds its last output lines. */
export class LlamaServerExitError extends LocalRuntimeError {
  constructor(
    message: string,
    readonly code: number | null,
    readonly signal: string | null,
    readonly portInUse: boolean,
    readonly log: readonly string[]
  ) {
    super(message, 'llama-server');
    this.name = 'LlamaServerExitError';
  }
}

/** A llama-server binary older than the build whose flags this package relies on. */
export class LlamaServerVersionError extends LocalRuntimeError {
  constructor(
    readonly path: string,
    /** Null when the binary's version line carries no build number. */
    readonly found: number | null,
    readonly required: number
  ) {
    super(
      `llama-server at ${path} is ${found === null ? 'an unnumbered build' : `build ${found}`}; build ${required} or newer is required`,
      'llama-server'
    );
    this.name = 'LlamaServerVersionError';
  }
}

/** A local file operation failed (disk full, permission, missing directory). `code` is the errno code. */
export class RuntimeStorageError extends LocalRuntimeError {
  constructor(
    message: string,
    runtimeId: string,
    readonly path: string,
    readonly code: string | null,
    options: { cause: unknown }
  ) {
    super(message, runtimeId, options);
    this.name = 'RuntimeStorageError';
  }
}

/** Another download or copy, in this process or another, is writing the same model file. */
export class ModelFileBusyError extends LocalRuntimeError {
  constructor(
    runtimeId: string,
    readonly path: string,
    /** The lock holder's pid, when the lock file names one. */
    readonly pid: number | null
  ) {
    super(`${path} is being written by another download or copy${pid ? ` (pid ${pid})` : ''}`, runtimeId);
    this.name = 'ModelFileBusyError';
  }
}

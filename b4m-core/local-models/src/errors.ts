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

/** A pull whose stream stayed open but sent nothing for `idleTimeoutMs`, as when the network drops quietly. */
export class PullIdleTimeoutError extends LocalRuntimeError {
  constructor(
    runtimeId: string,
    readonly ref: string,
    readonly idleTimeoutMs: number
  ) {
    super(`${runtimeId} sent nothing for ${idleTimeoutMs}ms while pulling ${ref}`, runtimeId);
    this.name = 'PullIdleTimeoutError';
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

/** A managed llama-server process that exited, or could not be spawned, before it was ready. */
export class LlamaServerExitError extends LocalRuntimeError {
  constructor(
    message: string,
    readonly code: number | null,
    readonly signal: string | null,
    readonly portInUse: boolean,
    /** The last lines it printed. */
    readonly log: readonly string[],
    options?: { cause?: unknown }
  ) {
    super(message, 'llama-server', options);
    this.name = 'LlamaServerExitError';
  }
}

/**
 * A started llama-server stopped as unusable: it printed nothing for the start timeout, answered without its API
 * key (a launcher dropped the environment), or its port served another model.
 */
export class LlamaServerStartError extends LocalRuntimeError {
  constructor(
    message: string,
    /**
     * `socket-unreadable` and `other-namespace`: Linux could not confirm the port is the server's (no `/proc/net/tcp`,
     * hidden file descriptors, or a server in another network namespace); `no-port`: it loaded but named no port.
     */
    readonly reason:
      'timeout' | 'unauthenticated' | 'wrong-server' | 'socket-unreadable' | 'other-namespace' | 'no-port',
    readonly log: readonly string[]
  ) {
    super(message, 'llama-server');
    this.name = 'LlamaServerStartError';
  }
}

/** A binary path this package will not run, such as a Windows batch file. */
export class LlamaServerBinaryError extends LocalRuntimeError {
  constructor(
    message: string,
    readonly path: string
  ) {
    super(message, 'llama-server');
    this.name = 'LlamaServerBinaryError';
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
    readonly operation: 'read' | 'write',
    options: { cause: unknown }
  ) {
    super(message, runtimeId, options);
    this.name = 'RuntimeStorageError';
  }
}

/**
 * Another download, copy or removal, in this process or another, holds the model file's lock, or took it over
 * from this one. `force` on `remove` and `discardPartial` overrides it.
 */
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

/** A model name that is not a usable relative path of portable GGUF file names. */
export class InvalidModelNameError extends LocalRuntimeError {
  constructor(
    runtimeId: string,
    readonly modelName: string
  ) {
    super(`${JSON.stringify(modelName)} is not a usable GGUF file name`, runtimeId);
    this.name = 'InvalidModelNameError';
  }
}

/**
 * A file already in the models directory that the operation will not replace: `'exists'` for a copy, `'size'` or
 * `'sha256'` for a download whose file is present with other bytes.
 */
export class ModelFileConflictError extends LocalRuntimeError {
  constructor(
    runtimeId: string,
    readonly path: string,
    readonly reason: 'exists' | 'size' | 'sha256'
  ) {
    super(
      reason === 'exists'
        ? `${path} already exists in the models directory`
        : `${path} already exists with a different ${reason === 'size' ? 'size' : 'sha256'}`,
      runtimeId
    );
    this.name = 'ModelFileConflictError';
  }
}

/** A split model with shards missing, so it cannot be copied or served. */
export class ModelIncompleteError extends LocalRuntimeError {
  constructor(
    runtimeId: string,
    readonly model: string,
    /** The missing shard file names. */
    readonly missing: readonly string[]
  ) {
    super(`${model} is missing shards: ${missing.join(', ')}`, runtimeId);
    this.name = 'ModelIncompleteError';
  }
}

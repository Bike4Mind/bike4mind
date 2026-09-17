/**
 * A provider rejected an embedding request for an authentication/authorization reason (a 401):
 * a missing, invalid, expired, or endpoint-scoped key. Distinct from a transient failure (429/5xx)
 * or an input failure (token limit) so a caller can tell "an operator must fix a credential" apart
 * from "retry later" - the two want opposite handling.
 *
 * The `message` stays operator-actionable (it names what to set) because that is what lands in the
 * logs. User-facing surfaces must NOT render it verbatim - it leaks operator instructions
 * (OPENAI_API_KEY / OLLAMA_BASE_URL) that an end user can neither see nor act on. They should map
 * this error to their own concise copy (see fabFileVectorize).
 *
 * Detected by `name`, not `instanceof`: the error is thrown in fab-pipeline and caught in
 * apps/client, and a bundler that duplicates the class across that boundary would break an
 * `instanceof` check while the name stays stable.
 */
export class EmbeddingAuthError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmbeddingAuthError';
    this.provider = provider;
  }
}

export function isEmbeddingAuthError(error: unknown): error is EmbeddingAuthError {
  return error instanceof Error && error.name === 'EmbeddingAuthError';
}

/**
 * A vectorize message resolved an embedding model that would put a SECOND vector space into a file
 * that already holds vectors in another one. Thrown instead of embedding: a query embedded in one
 * space cannot score against vectors in the other (different geometry, often a different width), so
 * a split file loses its file-level label and can only be consolidated by re-embedding it in full.
 * Refusing costs one redelivery; proceeding costs the whole file's embedding spend twice over.
 *
 * Raised when the model a message actually resolved diverges from the space its file is already in,
 * which happens in BOTH directions - a credential lapsing mid-ingest substitutes the keyless model
 * for the requested one, and a credential appearing mid-ingest stops substituting it. See
 * resolveEmbeddingWithKeylessFallback for why the substitution is resolved per message at all.
 *
 * Like EmbeddingAuthError: `message` is operator detail (it names both spaces) and must NOT be
 * rendered verbatim to an end user, and detection is by `name` rather than `instanceof` because the
 * error crosses the fab-pipeline -> apps/client bundler boundary.
 */
export class EmbeddingSpaceConflictError extends Error {
  readonly attemptedModel: string;
  readonly existingModels: string[];

  constructor(attemptedModel: string, existingModels: readonly string[], options?: { cause?: unknown }) {
    super(
      `Refusing to embed with ${attemptedModel}: this file already holds vectors in ` +
        `${existingModels.join(', ')}. A second embedding space costs the file its file-level ` +
        `label and can only be consolidated by re-embedding it in full.`,
      options
    );
    this.name = 'EmbeddingSpaceConflictError';
    this.attemptedModel = attemptedModel;
    this.existingModels = [...existingModels];
  }
}

export function isEmbeddingSpaceConflictError(error: unknown): error is EmbeddingSpaceConflictError {
  return error instanceof Error && error.name === 'EmbeddingSpaceConflictError';
}

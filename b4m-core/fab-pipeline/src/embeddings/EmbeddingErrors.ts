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

import { ModelBackend } from '@bike4mind/common';
import type { EmbeddingConfig } from './EmbeddingFactory';

/**
 * Credential fields the embedding providers draw on, as returned by
 * `getEffectiveLLMApiKeys`.
 *
 * Declared structurally rather than imported from `@bike4mind/auth` so this package
 * keeps no dependency on the auth layer; every caller's table is assignable to it.
 */
export type EmbeddingKeyTable = {
  openai?: string | null;
  voyageai?: string | null;
  /** Ollama base URL, not a secret - self-host resolves it through the same table. */
  ollama?: string | null;
};

/** Credential an embedding provider needs. Bedrock is absent on purpose - it has none. */
export type EmbeddingCredential = 'openai' | 'voyageai' | 'ollama';

export type ResolvedEmbeddingConfig = {
  /** Config to hand to `new EmbeddingFactory(...)`. Empty for keyless providers. */
  config: EmbeddingConfig;
  /**
   * Credential the provider requires but the table did not supply, or null when the
   * config is ready to embed with. Callers decide how to fail: the API routes return
   * 4xx/5xx, the services throw, the background jobs warn and skip.
   */
  missing: EmbeddingCredential | null;
};

/** Providers `getProviderFromModel` can return. */
type EmbeddingProvider = ModelBackend.OpenAI | ModelBackend.VoyageAI | ModelBackend.Bedrock | ModelBackend.Ollama;

/**
 * `getEffectiveLLMApiKeys` returns the literal string `'expired'` in a key slot when the user's
 * per-provider key has passed its expiry. Every other LLM consumer special-cases this sentinel
 * (llm-adapters, image-gen, modelDiscoveryService's EXPIRED_KEY_SENTINEL) so it never reaches a
 * provider as a bearer token. Embeddings must do the same: an unnormalized `'expired'` is truthy
 * and not a placeholder, so it would sail through as a real key and come back as an opaque 401
 * ("OpenAI rejected the embedding request") instead of the actionable missing-credential path.
 */
const EXPIRED_KEY_SENTINEL = 'expired';
const usableKey = (value: string | null | undefined): string | null =>
  value && value !== EXPIRED_KEY_SENTINEL ? value : null;

/**
 * Map an embedding provider plus the caller's resolved key table to the config
 * `EmbeddingFactory` expects, and report which credential is missing if any.
 *
 * Exists because provider-to-config mapping was open-coded at 13 call sites in four
 * different shapes, and two of those shapes are hostile to keyless providers:
 *
 *   - a catch-all `else` that assumes any unrecognised provider needs an OpenAI or
 *     VoyageAI key, so Bedrock resolved a key it never needed and the request failed;
 *   - a `if (config.openaiApiKey || config.voyageApiKey || config.ollamaBaseUrl)` gate
 *     used as a proxy for "can embed", which is false for a provider that correctly
 *     populates none of them, so embedding was skipped with only a warning.
 *
 * Both are absent here by construction: a provider needing no credential returns an
 * empty config with `missing: null`, and that is a state callers must treat as ready
 * rather than as "no credentials found".
 *
 * Adding a provider means editing this function and its table test, not auditing
 * every call site.
 */
export function resolveEmbeddingConfig(
  provider: EmbeddingProvider,
  keyTable: EmbeddingKeyTable | null | undefined
): ResolvedEmbeddingConfig {
  switch (provider) {
    case ModelBackend.OpenAI: {
      const key = usableKey(keyTable?.openai);
      return key ? { config: { openaiApiKey: key }, missing: null } : { config: {}, missing: 'openai' };
    }

    case ModelBackend.VoyageAI: {
      const key = usableKey(keyTable?.voyageai);
      return key ? { config: { voyageApiKey: key }, missing: null } : { config: {}, missing: 'voyageai' };
    }

    case ModelBackend.Ollama:
      return keyTable?.ollama
        ? { config: { ollamaBaseUrl: keyTable.ollama }, missing: null }
        : { config: {}, missing: 'ollama' };

    case ModelBackend.Bedrock:
      // Authenticates through the AWS credential chain on the executing role, so an
      // empty config IS the ready state. Never report a missing credential here.
      return { config: {}, missing: null };
  }
}

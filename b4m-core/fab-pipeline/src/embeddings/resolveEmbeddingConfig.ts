import {
  BedrockEmbeddingModel,
  hasKeylessCloudEmbedder,
  ModelBackend,
  type SupportedEmbeddingModel,
} from '@bike4mind/common';
import type { EmbeddingConfig } from './EmbeddingFactory';
import { getProviderFromModel } from './getProviderFromModel';

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
 * The slot is missing because THIS CALLER's key expired, not because the deployment holds none.
 * Bedrock has no credential and Ollama's base URL carries no expiry, so only the two keyed cloud
 * providers can be in this state. See the keyless-fallback doc comment for why it matters.
 */
const isExpiredCallerKey = (
  missing: EmbeddingCredential | null,
  keyTable: EmbeddingKeyTable | null | undefined
): boolean =>
  (missing === 'openai' && keyTable?.openai === EXPIRED_KEY_SENTINEL) ||
  (missing === 'voyageai' && keyTable?.voyageai === EXPIRED_KEY_SENTINEL);

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

/**
 * Resolve a config for `model`, falling back to keyless Bedrock when this deployment holds no
 * credential for the provider `model` needs but can reach Bedrock with its own AWS role.
 *
 * WHY THIS EXISTS HERE and not in `defaultEmbeddingModelForEnv`: "does this deployment have a
 * cloud embedding key" is unanswerable from process.env on a hosted stage - an SST secret arrives
 * as a linked Resource, so OPENAI_API_KEY is absent on production exactly as it is on a preview.
 * The key table passed in here is the first point that actually knows, which is why the decision
 * belongs at this seam.
 *
 * Related to but NOT the same as EmbeddingFactory.getDefaultEmbeddingModel, which ranks providers
 * from scratch (OpenAI > VoyageAI > Ollama > Bedrock). This keeps the model the admin asked for
 * whenever it is reachable and only substitutes the keyless one otherwise - so a deployment
 * holding only a Voyage key still falls back to Bedrock here, where the factory would pick
 * voyage-3. Deliberate: this is a reachability backstop, not a second opinion on the setting.
 *
 * ONLY FOR CALLERS FREE TO CHOOSE THE MODEL - i.e. the model came from the `defaultEmbeddingModel`
 * admin setting. A caller that must hit one specific vector space MUST keep using
 * `resolveEmbeddingConfig` and fail, because a fallback there would silently compare or write
 * across incompatible spaces:
 *   - V2 mementos are pinned to MEMENTO_EMBEDDING_MODEL at 512 truncated dims (see embedding.ts);
 *   - V1 mementos (mementoEmbedding.ts, getRelevantMementos.ts) read the admin default and so LOOK
 *     free to choose, but neither live write path stamps `Memento.embeddingModel` - only the
 *     reembedMementos backfill does. Their vectors are ranked by in-process cosine with no width
 *     guard and no Atlas index, so a substitution here would drop 1024-dim vectors into a field
 *     holding 1536-dim ones with nothing recording which is which, and nothing able to tell them
 *     apart afterwards. Stamping V1 is the prerequisite for including it, not this helper.
 *   - alternateModelAnn embeds one query per model bucket to match each chunk's recorded stamp.
 *
 * Returns the model actually used, so callers stamp what they embedded with rather than what they
 * asked for - that is what keeps `fabFileChunk`'s recorded `embeddingModel` honest.
 *
 * TWO credential states are deliberately NOT treated as "this deployment is keyless":
 *   - `missing: 'ollama'` - a self-host that set no OLLAMA_BASE_URL has no AWS role either, and
 *     OPENAI_KEY_MISSING_MESSAGE naming OPENAI_API_KEY / OLLAMA_BASE_URL is the actionable error
 *     there. `hasKeylessCloudEmbedder()` already excludes self-host; this is belt-and-braces.
 *   - an EXPIRED caller key. `getEffectiveLLMApiKeys` returns the `'expired'` sentinel instead of
 *     falling through to the platform demo key, deliberately, so the user is told their key
 *     expired rather than silently moved onto the platform's (see the reasoning in the
 *     reactivate-collateral-deactivated-api-keys migration). `usableKey` normalizes that to null
 *     for the CREDENTIAL check, which is right - but read as "this deployment holds no key" it
 *     would substitute Titan for that one caller on keyed production, querying a vector space the
 *     corpus was never written in. The deployment's own key state is unchanged by one expiry, so
 *     the requested model is returned and the actionable expired-key error stands.
 */
export function resolveEmbeddingWithKeylessFallback(
  model: SupportedEmbeddingModel,
  keyTable: EmbeddingKeyTable | null | undefined
): ResolvedEmbeddingConfig & { model: SupportedEmbeddingModel } {
  const resolved = resolveEmbeddingConfig(getProviderFromModel(model), keyTable);
  if (
    !resolved.missing ||
    resolved.missing === 'ollama' ||
    isExpiredCallerKey(resolved.missing, keyTable) ||
    !hasKeylessCloudEmbedder()
  ) {
    return { ...resolved, model };
  }
  return {
    ...resolveEmbeddingConfig(ModelBackend.Bedrock, null),
    model: BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2,
  };
}

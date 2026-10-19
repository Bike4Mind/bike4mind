import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { isSupportedEmbeddingModel, type SupportedEmbeddingModel } from '@bike4mind/common';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames, resolveEmbeddingWithKeylessFallback } from '@bike4mind/utils';

type LLMApiKeyTable = Awaited<ReturnType<typeof apiKeyService.getEffectiveLLMApiKeys>>;

/**
 * The embedding model this deployment will REALLY embed with for a given caller: the configured
 * `defaultEmbeddingModel` put through the same credential-table seam the ingest and search paths
 * resolve at (`resolveEmbeddingWithKeylessFallback`), rather than read raw.
 *
 * The advertised setting and the effective model diverge on any stage holding no key for the
 * configured model: the vectorizer falls back to the keyless cloud embedder and stamps the corpus
 * with the model it fell back TO, so comparing a stored label against the advertised setting makes
 * every correctly-embedded file look like it lives in a foreign vector space. Whoever compares
 * labels must compare against this.
 *
 * `undefined` means "no space to compare against", and callers must treat it as a reason to STOP
 * comparing rather than as a reason to fall back to the advertised setting. It covers three
 * distinct situations, deliberately collapsed here because every caller owes them the same answer:
 * the setting is unset or names an unregistered model; the credential the resolver needs is absent
 * or expired (`missing !== null`), so no query vector can be produced at all; or a lookup threw.
 * Never throws - the callers are a config route that also serves the websocket URL and a
 * memory-recall path, and neither should die over a label comparison.
 *
 * Resolved per CALLER, not per deployment, because `getEffectiveLLMApiKeys` honours a personal key:
 * two users on one stage can legitimately embed in different spaces.
 */
export async function resolveEffectiveEmbeddingModel(
  userId: string | null | undefined,
  /**
   * `llmKeys` is a RESOLVED table only. A table with no usable key is a real answer ("this caller
   * holds none"), and the resolver acts on it by substituting the keyless embedder - so a caller
   * whose own lookup FAILED must omit it rather than inject the failure, or an unavailable Mongo
   * turns into a confident Titan on a fully keyed stage. That is why the option is not nullable.
   */
  options: { llmKeys?: LLMApiKeyTable } = {}
): Promise<SupportedEmbeddingModel | undefined> {
  try {
    const configured = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
    if (typeof configured !== 'string' || !isSupportedEmbeddingModel(configured)) return undefined;
    // Injected rather than looked up when the caller already has the table; omitted -> resolve it.
    const apiKeyTable =
      options.llmKeys ??
      (await apiKeyService.getEffectiveLLMApiKeys(userId ?? null, {
        db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
        getSettingsByNames,
      }));
    const { model, missing } = resolveEmbeddingWithKeylessFallback(configured, apiKeyTable);
    return missing === null ? model : undefined;
  } catch {
    return undefined;
  }
}

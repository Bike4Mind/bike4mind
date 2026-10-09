import { buildApiKeyTable, getAvailableModels, getSupersededModels } from '@bike4mind/llm-adapters';
import { apiKeyService } from '@bike4mind/services';
import { apiKeyRepository, adminSettingsRepository, cacheRepository } from '@bike4mind/database';
import { getSettingsByNames } from '@bike4mind/utils';
import { getImageModelCapabilities, isImageModel, type ModelInfo, type SupersededModelInfo } from '@bike4mind/common';
import { CacheKeys } from '@server/utils/cacheKeys';
import { modelCatalogListingOptions } from '@server/utils/modelCatalogOptions';

/**
 * The models one caller can use, shared by `GET /api/models` (internal shape, SPA + CLI) and
 * `GET /api/v1/models` (public projection) so the two can never disagree on which models exist.
 */
export type CallerModelList = { models: ModelInfo[]; supersededModels: SupersededModelInfo[] };

// Short floor for cross-tab / fresh page loads. The dominant repeat-open case is
// already absorbed by useModelInfo's 1h client staleTime; this just bounds how
// often the multi-backend fan-out runs server-side.
const MODELS_CACHE_TTL_MS = 60_000;

// Cache identity for a caller with no session. Distinct from any real user id and
// from the ids system callers use, so an anonymous page load can never be served
// a list assembled from someone else's keys.
const ANONYMOUS_CACHE_ID = 'anonymous';

// Self-hosted `local-image/*` checkpoints are discovered at runtime and carry no known rules.
function withImageCapabilities(model: ModelInfo): ModelInfo {
  if (!isImageModel(model.id)) return model;
  return { ...model, image: getImageModelCapabilities(model.id) };
}

async function buildCallerModelList(userId: string | null): Promise<CallerModelList> {
  const dbAdapters = { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames };
  const coreKeys = await apiKeyService.getEffectiveLLMApiKeys(userId, dbAdapters);

  // Keyed by ModelBackend, which is what the shared listing gate reads. Built by
  // the shared helper rather than a literal here: this list is the picker, so a
  // provider missing from the table is a provider no user can select.
  const apiKeys = buildApiKeyTable(coreKeys);

  const listedModels = await getAvailableModels(apiKeys, modelCatalogListingOptions());
  const models = listedModels.map(withImageCapabilities);

  // Superseded pins the client can offer to upgrade, resolved by llm-adapters
  // through the same catalog-overlay-then-static-map chain a pinned request takes.
  // Reads the fan-out getAvailableModels just did, so it costs no extra work.
  return { models, supersededModels: getSupersededModels(listedModels) };
}

export async function getCallerModelList(
  userId: string | null,
  logger: { log: (message: string) => void }
): Promise<CallerModelList> {
  const cacheKey = CacheKeys.modelList(userId ?? ANONYMOUS_CACHE_ID);

  const cached = await cacheRepository.findOne({ key: cacheKey });
  if (cached) {
    logger.log(`Cache hit for key: ${cacheKey}`);
    return cached.result as CallerModelList;
  }

  logger.log(`Cache miss for key: ${cacheKey}`);
  const payload = await buildCallerModelList(userId);

  // Don't cache an empty result. If every backend timed out (network blip, all
  // providers slow at once), caching `{ models: [] }` for 60s would hide healthy
  // backends from the next request until expiry.
  //
  // INVARIANT: this function is the only writer of `model-list:*`. The entries
  // are per-caller views built from that caller's keys, so background jobs (model
  // discovery included) must bust these keys, never populate them.
  if (payload.models.length > 0) {
    await cacheRepository.createOrUpdate({
      key: cacheKey,
      result: payload,
      expiresAt: new Date(Date.now() + MODELS_CACHE_TTL_MS),
    });
  }

  return payload;
}

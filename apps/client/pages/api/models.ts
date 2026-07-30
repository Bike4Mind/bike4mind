import { buildApiKeyTable, getAvailableModels } from '@bike4mind/llm-adapters';
import { baseApi } from '@server/middlewares/baseApi';
import { apiKeyService } from '@bike4mind/services';
import { apiKeyRepository, adminSettingsRepository, cacheRepository } from '@bike4mind/database';
import { CacheKeys } from '@server/utils/cacheKeys';
import { getSettingsByNames } from '@bike4mind/utils';

const BACKEND_TIMEOUT_MS = 2_000;

// Short floor for cross-tab / fresh page loads. The dominant repeat-open case is
// already absorbed by useModelInfo's 1h client staleTime; this just bounds how
// often the multi-backend fan-out runs server-side.
const MODELS_CACHE_TTL_MS = 60_000;

// Cache identity for a caller with no session. Distinct from any real user id and
// from the ids system callers use, so an anonymous page load can never be served
// a list assembled from someone else's keys.
const ANONYMOUS_CACHE_ID = 'anonymous';

async function buildModelsResponse(userId: string | null) {
  const dbAdapters = { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames };
  const coreKeys = await apiKeyService.getEffectiveLLMApiKeys(userId, dbAdapters);

  // Keyed by ModelBackend, which is what the shared listing gate reads. Built by
  // the shared helper rather than a literal here: this route is the picker, so a
  // provider missing from the table is a provider no user can select.
  const apiKeys = buildApiKeyTable(coreKeys);

  const models = await getAvailableModels(apiKeys, {
    perBackendTimeoutMs: BACKEND_TIMEOUT_MS,
    // The picker is the one consumer that must not see private models; every
    // other getAvailableModels caller resolves pinned private models by id.
    includePrivate: false,
    isSelfHost: process.env.B4M_SELF_HOST === 'true',
  });

  return { models };
}

const handler = baseApi().get(async (req, res) => {
  const userId = req.user?.id ?? null;
  const cacheKey = CacheKeys.modelList(userId ?? ANONYMOUS_CACHE_ID);

  const cached = await cacheRepository.findOne({ key: cacheKey });
  if (cached) {
    req.logger.log(`Cache hit for key: ${cacheKey}`);
    return res.status(200).json(cached.result);
  }

  req.logger.log(`Cache miss for key: ${cacheKey}`);
  const payload = await buildModelsResponse(userId);

  // Don't cache an empty result. If every backend timed out (network blip, all
  // providers slow at once), caching `{ models: [] }` for 60s would hide healthy
  // backends from the next request until expiry.
  //
  // INVARIANT: this request path is the only writer of `model-list:*`. The entries
  // are per-caller views built from that caller's keys, so background jobs (model
  // discovery included) must bust these keys, never populate them.
  if (payload.models.length > 0) {
    await cacheRepository.createOrUpdate({
      key: cacheKey,
      result: payload,
      expiresAt: new Date(Date.now() + MODELS_CACHE_TTL_MS),
    });
  }

  return res.status(200).json(payload);
});

export default handler;

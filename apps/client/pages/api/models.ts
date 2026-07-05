import {
  AnthropicBackend,
  UndifferentiatedBedrockBackend,
  GeminiBackend,
  OllamaBackend,
  OpenAIBackend,
  BFLBackend,
  XAIBackend,
  AWSBackend,
} from '@bike4mind/llm-adapters';
import { ModelBackend } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { apiKeyService } from '@bike4mind/services';
import { apiKeyRepository, adminSettingsRepository, cacheRepository } from '@bike4mind/database';
import { CacheKeys } from '@server/utils/cacheKeys';
import type { Logger } from '@bike4mind/observability';
import { getSettingsByNames } from '@bike4mind/utils';

const BACKEND_TIMEOUT_MS = 2_000;

// Short floor for cross-tab / fresh page loads. The dominant repeat-open case is
// already absorbed by useModelInfo's 1h client staleTime; this just bounds how
// often the multi-backend fan-out runs server-side.
const MODELS_CACHE_TTL_MS = 60_000;

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

async function buildModelsResponse(userId: string, logger: Logger) {
  const dbAdapters = { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames };
  const coreKeys = await apiKeyService.getEffectiveLLMApiKeys(userId, dbAdapters);

  // Convert to ApiKeyTable format for backward compatibility
  const apiKeys = {
    openai: coreKeys.openai || undefined,
    anthropic: coreKeys.anthropic || undefined,
    gemini: coreKeys.gemini || undefined,
    bfl: coreKeys.bfl || undefined,
    ollama: coreKeys.ollama || undefined,
    xai: coreKeys.xai || undefined,
  };

  const backends = {
    [ModelBackend.OpenAI]: apiKeys.openai ? new OpenAIBackend(apiKeys.openai, logger) : null,
    [ModelBackend.Anthropic]: apiKeys.anthropic ? new AnthropicBackend(apiKeys.anthropic, logger) : null,
    [ModelBackend.Bedrock]: /* TODO: feature flag */ new UndifferentiatedBedrockBackend(),
    [ModelBackend.Gemini]: apiKeys.gemini ? new GeminiBackend(apiKeys.gemini) : null,
    [ModelBackend.Ollama]: apiKeys.ollama ? new OllamaBackend(apiKeys.ollama) : null,
    [ModelBackend.BFL]: apiKeys.bfl ? new BFLBackend(apiKeys.bfl) : new BFLBackend('demo-key'), // Always create BFL backend for testing
    [ModelBackend.XAI]: apiKeys.xai ? new XAIBackend(apiKeys.xai, logger) : null,
    [ModelBackend.AWS]: new AWSBackend(),
  } as const;

  const backendPromises = Object.entries(backends).map(async ([backendName, backend]) => {
    if (!backend) return { backendName, models: [] };

    try {
      const models = (await withTimeout(backend.getModelInfo(), BACKEND_TIMEOUT_MS, backendName)).filter(
        m => !m.private
      );
      return { backendName, models };
    } catch (error: any) {
      logger.warn(`[/api/models] ${backendName}: ${error?.message || error}`);
      return { backendName, models: [], error };
    }
  });

  const results = await Promise.allSettled(backendPromises);

  const models = results
    .map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value.models;
      } else {
        const backendName = Object.keys(backends)[index];
        logger.error('[/api/models] Failed to get models from %s:', backendName, result.reason);
        return [];
      }
    })
    .flat()
    // Filter out models that are deprecated as of today (inclusive)
    .filter(m => {
      if (!m.deprecationDate) return true;
      const today = new Date(new Date().toISOString().slice(0, 10));
      const cutoff = new Date(m.deprecationDate + 'T00:00:00Z');
      return today.getTime() < cutoff.getTime();
    });

  return { models };
}

const handler = baseApi().get(async (req, res) => {
  const userId = req.user?.id || 'system';
  const cacheKey = CacheKeys.modelList(userId);

  const cached = await cacheRepository.findOne({ key: cacheKey });
  if (cached) {
    req.logger.log(`Cache hit for key: ${cacheKey}`);
    return res.status(200).json(cached.result);
  }

  req.logger.log(`Cache miss for key: ${cacheKey}`);
  const payload = await buildModelsResponse(userId, req.logger);

  // Don't cache an empty result. If every backend timed out (network blip, all
  // providers slow at once), caching `{ models: [] }` for 60s would hide healthy
  // backends from the next request until expiry.
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

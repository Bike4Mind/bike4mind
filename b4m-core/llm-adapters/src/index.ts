import {
  ChatModels,
  IModelPrice,
  ModelBackend,
  ModelInfo,
  applyModelPriceCatalog,
  isModelDeprecated,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { AnthropicBackend } from './anthropicBackend';
import { AWSBackend } from './awsBackend';
import { ICompletionBackend } from './backend';
import { toProviderEndUserId } from './endUserId';
import AnthropicBedrockBackend from './bedrockBackend/anthropic';
import DeepSeekBedrockBackend from './bedrockBackend/deepseek';
import JurassicTwoBedrockBackend from './bedrockBackend/jurassicTwo';
import LlamaBedrockBackend from './bedrockBackend/llama';
import TitanBedrockBackend from './bedrockBackend/titan';
import { UndifferentiatedBedrockBackend } from './bedrockBackend/undifferentiated';
import { BFLBackend } from './bflBackend';
import { GeminiBackend } from './geminiBackend';
import { OllamaBackend } from './ollamaBackend';
import { OpenAIBackend } from './openaiBackend';
import { XAIBackend } from './xaiBackend';

export type ApiKeyTable = {
  [key in ModelBackend]?: string | null;
};

export function getLlmByModel(
  apiKeyTable: ApiKeyTable,
  options: {
    modelInfo?: ModelInfo;
    logger: Logger;
    /**
     * Internal id of the end user this request is on behalf of. Forwarded to
     * direct Anthropic/OpenAI calls (hashed to an opaque, non-PII identifier) so
     * provider abuse enforcement is scoped to the individual user instead of the
     * whole shared platform key. Omit for system-initiated traffic with no end
     * user. See `toProviderEndUserId`.
     */
    endUserId?: string | null;
  }
): ICompletionBackend | null {
  const { modelInfo } = options;

  const logger = options.logger ?? new Logger();

  // Hash once here so both direct-provider backends receive the same opaque id.
  const providerEndUserId = toProviderEndUserId(options.endUserId);

  if (!modelInfo) {
    return null;
  }

  if (isModelDeprecated(modelInfo)) {
    Logger.globalInstance.warn(
      `[model-sunset] getLlmByModel invoked with deprecated model: ${modelInfo.id} (deprecationDate: ${modelInfo.deprecationDate})`
    );
  }

  let backend: ICompletionBackend | null = null;

  switch (modelInfo.backend) {
    case 'openai':
      if (apiKeyTable.openai === 'expired') throw new Error('OpenAI API key is expired');
      backend = apiKeyTable.openai ? new OpenAIBackend(apiKeyTable.openai, logger, providerEndUserId) : null;
      break;
    case 'bedrock':
      switch (modelInfo.id) {
        case ChatModels.CLAUDE_3_HAIKU_BEDROCK:
        case ChatModels.CLAUDE_3_5_HAIKU_BEDROCK:
        case ChatModels.CLAUDE_3_5_SONNET_BEDROCK:
        case ChatModels.CLAUDE_3_5_SONNET_V2_BEDROCK:
        case ChatModels.CLAUDE_3_7_SONNET_BEDROCK:
        case ChatModels.CLAUDE_4_OPUS_BEDROCK:
        case ChatModels.CLAUDE_4_1_OPUS_BEDROCK:
        case ChatModels.CLAUDE_4_SONNET_BEDROCK:
        case ChatModels.CLAUDE_4_5_SONNET_BEDROCK:
        case ChatModels.CLAUDE_4_5_HAIKU_BEDROCK:
        case ChatModels.CLAUDE_4_5_OPUS_BEDROCK:
        case ChatModels.CLAUDE_4_6_SONNET_BEDROCK:
        case ChatModels.CLAUDE_5_SONNET_BEDROCK:
        case ChatModels.CLAUDE_4_6_OPUS_BEDROCK:
        case ChatModels.CLAUDE_4_7_OPUS_BEDROCK:
        case ChatModels.CLAUDE_4_8_OPUS_BEDROCK:
          return new AnthropicBedrockBackend();
        case ChatModels.LLAMA3_INSTRUCT_8B_V1:
        case ChatModels.LLAMA3_INSTRUCT_70B_V1:
        case ChatModels.LLAMA4_MAVERICK_17B_INSTRUCT_BEDROCK:
        case ChatModels.LLAMA4_SCOUT_17B_INSTRUCT_BEDROCK:
          backend = new LlamaBedrockBackend();
          break;
        case ChatModels.JURASSIC2_MID:
        case ChatModels.JURASSIC2_ULTRA:
          backend = new JurassicTwoBedrockBackend();
          break;
        case ChatModels.TITAN_TEXT_G1_LITE:
        case ChatModels.TITAN_TEXT_G1_EXPRESS:
          backend = new TitanBedrockBackend();
          break;
        case ChatModels.DEEPSEEK_R1_BEDROCK:
        case ChatModels.DEEPSEEK_V3_1:
          backend = new DeepSeekBedrockBackend();
          break;
        default:
          backend = null;
      }
      break;
    case 'anthropic':
      if (apiKeyTable.anthropic === 'expired') throw new Error('Anthropic API key is expired');
      backend = apiKeyTable.anthropic ? new AnthropicBackend(apiKeyTable.anthropic, logger, providerEndUserId) : null;
      break;
    case 'gemini':
      if (apiKeyTable.gemini === 'expired') throw new Error('Gemini API key is expired');
      backend = apiKeyTable.gemini ? new GeminiBackend(apiKeyTable.gemini) : null;
      break;
    case 'ollama':
      if (apiKeyTable.ollama === 'expired') throw new Error('Ollama API key is expired');
      backend = apiKeyTable.ollama ? new OllamaBackend(apiKeyTable.ollama) : null;
      break;
    case 'bfl':
      if (apiKeyTable.bfl === 'expired') throw new Error('BFL API key is expired');
      backend = apiKeyTable.bfl ? new BFLBackend(apiKeyTable.bfl) : new BFLBackend('demo-key');
      break;
    case 'xai':
      if (apiKeyTable.xai === 'expired') throw new Error('xAI API key is expired');
      backend = apiKeyTable.xai ? new XAIBackend(apiKeyTable.xai) : null;
      break;
    case 'aws':
      backend = new AWSBackend();
      break;
    default:
      backend = null;
  }

  return backend;
}

// Module-level TTL cache for getAvailableModels.
// 7/8 backends return hardcoded static arrays; only Ollama does a network call.
// Model lists almost never change between deploys, so a 5-minute TTL is safe and keeps
// warm Lambda instances from re-fetching every request (admin model changes still take
// effect within 5 minutes, and a cold start always rebuilds the list).
const MODEL_CACHE_TTL_MS = 5 * 60_000;
// When the price-catalog fetch fails, cache the literal-priced fallback only
// briefly: a transient DB blip should cost seconds of superseded prices, not
// a full TTL window.
const MODEL_CACHE_RETRY_TTL_MS = 30_000;
let _modelCache: { key: string; models: ModelInfo[]; expiresAt: number } | null = null;

/**
 * Optional versioned-price-catalog hook. This package cannot depend on the
 * database, so the app layer injects a rows provider (one DB read per model
 * cache rebuild, i.e. per TTL window / cold start). Unset provider or a
 * failing fetch = adapter price literals, which keeps zero-config self-host
 * deployments working.
 */
export type ModelPriceRowsProvider = () => Promise<IModelPrice[]>;
let _priceRowsProvider: ModelPriceRowsProvider | null = null;

export function setModelPriceRowsProvider(provider: ModelPriceRowsProvider | null): void {
  _priceRowsProvider = provider;
  // Rebuild on next call so freshly wired prices don't wait out a stale TTL.
  _modelCache = null;
}

function getModelCacheKey(apiKeys: ApiKeyTable | null): string {
  if (!apiKeys) return 'null';
  return Object.keys(apiKeys)
    .sort()
    .map(k => `${k}:${apiKeys[k as keyof ApiKeyTable] ? '1' : '0'}`)
    .join(',');
}

// Given Settings data, return a list of models that are available.  In the
// future, we might consider using this to filter based on capability.
// Only meant to be called from the server.
export const getAvailableModels = async (apiKeys: ApiKeyTable | null): Promise<ModelInfo[]> => {
  // Check module-level cache first
  const cacheKey = getModelCacheKey(apiKeys);
  if (_modelCache && _modelCache.key === cacheKey && Date.now() < _modelCache.expiresAt) {
    return _modelCache.models;
  }

  const backends = {
    [ModelBackend.OpenAI]: apiKeys?.openai ? new OpenAIBackend(apiKeys.openai) : null,
    [ModelBackend.Anthropic]: apiKeys?.anthropic ? new AnthropicBackend(apiKeys.anthropic) : null,
    [ModelBackend.Bedrock]: /* TODO: feature flag */ new UndifferentiatedBedrockBackend(),
    [ModelBackend.Gemini]: apiKeys?.gemini ? new GeminiBackend(apiKeys.gemini) : null,
    [ModelBackend.Ollama]: apiKeys?.ollama ? new OllamaBackend(apiKeys.ollama) : null,
    [ModelBackend.BFL]: apiKeys?.bfl ? new BFLBackend(apiKeys.bfl) : new BFLBackend('demo-key'),
    [ModelBackend.XAI]: apiKeys?.xai ? new XAIBackend(apiKeys.xai) : null,
    [ModelBackend.AWS]: new AWSBackend(),
  } as const;

  const backendPromises = Object.entries(backends).map(async ([backendName, backend]) => {
    if (!backend) return { backendName, models: [] };

    try {
      const models = await backend.getModelInfo();
      return { backendName, models };
    } catch (error) {
      Logger.globalInstance.error(`[getAvailableModels] Error fetching models from ${backendName}:`, error);
      return { backendName, models: [], error };
    }
  });

  const results = await Promise.allSettled(backendPromises);

  const backendModels = results
    .map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value.models;
      } else {
        const backendName = Object.keys(backends)[index];
        Logger.globalInstance.error(`[getAvailableModels] Failed to get models from ${backendName}:`, result.reason);
        return [];
      }
    })
    .flat();

  // Filter out models that have reached their deprecation date (inclusive)
  const today = new Date(new Date().toISOString().slice(0, 10));
  const filtered = backendModels.filter(m => {
    if (!m.deprecationDate) return true;
    const cutoff = new Date(m.deprecationDate + 'T00:00:00Z');
    return today.getTime() < cutoff.getTime();
  });

  // Overlay versioned catalog prices when the app wired a provider.
  let priced = filtered;
  let catalogFetchFailed = false;
  if (_priceRowsProvider) {
    try {
      const rows = await _priceRowsProvider();
      priced = applyModelPriceCatalog(filtered, rows);
      const overlaid = priced.filter((m, i) => m !== filtered[i]).length;
      Logger.globalInstance.info(`[getAvailableModels] price catalog applied to ${overlaid}/${filtered.length} models`);
    } catch (error) {
      catalogFetchFailed = true;
      Logger.globalInstance.warn('[getAvailableModels] price catalog unavailable; using adapter literals', error);
    }
  }

  // Store in module-level cache (short-lived when the catalog fetch failed).
  const ttl = catalogFetchFailed ? MODEL_CACHE_RETRY_TTL_MS : MODEL_CACHE_TTL_MS;
  _modelCache = { key: cacheKey, models: priced, expiresAt: Date.now() + ttl };

  return priced;
};

// Types and core utils:
export * from './backend';
export * from './endUserId';

// Implementations:
export * from './anthropicBackend';
export * from './anthropicBatchService';
export * from './awsBackend';
export * from './bedrockBackend/base';
export * from './bedrockBackend/undifferentiated';
export * from './bflBackend';
export * from './geminiBackend';
export * from './ollamaBackend';
export * from './openaiBackend';
export * from './xaiBackend';

export {
  AnthropicBedrockBackend,
  DeepSeekBedrockBackend,
  JurassicTwoBedrockBackend,
  LlamaBedrockBackend,
  TitanBedrockBackend,
};

export * from './PipelineTimer';
export * from './resolveDeprecatedModel';
export * from './deprecationHorizon';
export * from './toolPairingUtils';

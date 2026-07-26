import {
  ChatModels,
  IModelCatalogRow,
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
import { resolveListingKey } from './backendGate';
import type { ApiKeyTable, BackendGateContext } from './backendGate';
import { toProviderEndUserId } from './endUserId';
import { mergeCatalog } from './mergeCatalog';
import AnthropicBedrockBackend from './bedrockBackend/anthropic';
import DeepSeekBedrockBackend from './bedrockBackend/deepseek';
import JurassicTwoBedrockBackend from './bedrockBackend/jurassicTwo';
import LlamaBedrockBackend from './bedrockBackend/llama';
import TitanBedrockBackend from './bedrockBackend/titan';
import { UndifferentiatedBedrockBackend } from './bedrockBackend/undifferentiated';
import { BFLBackend } from './bflBackend';
import { GeminiBackend } from './geminiBackend';
import { LocalImageBackend } from './localImageBackend';
import { OllamaBackend } from './ollamaBackend';
import { OpenAIBackend } from './openaiBackend';
import { XAIBackend } from './xaiBackend';

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

/**
 * Optional model-catalog hook, the availability/capability twin of the price
 * provider above: this package cannot depend on the database, so the app layer
 * injects the rows-in-force reader. Unset provider or a failing fetch = the
 * adapter tables alone, which is exactly today's behavior.
 */
export type ModelCatalogProvider = () => Promise<IModelCatalogRow[]>;
let _catalogProvider: ModelCatalogProvider | null = null;

export function setModelCatalogProvider(provider: ModelCatalogProvider | null): void {
  _catalogProvider = provider;
  // Both providers null the same cache. That is idempotent and intentional:
  // whichever is wired second simply rebuilds again on the next call.
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

  // Every listing credential comes from resolveListingKey, the same predicate
  // the catalog merge gates catalog-only records with, so the two tiers cannot
  // disagree about which backends this caller can reach. The local-image env
  // fallback and BFL's demo key live in that predicate for the same reason.
  const gateCtx: BackendGateContext = { apiKeys, isSelfHost: process.env.B4M_SELF_HOST === 'true' };
  const openaiKey = resolveListingKey(ModelBackend.OpenAI, gateCtx);
  const anthropicKey = resolveListingKey(ModelBackend.Anthropic, gateCtx);
  const geminiKey = resolveListingKey(ModelBackend.Gemini, gateCtx);
  const ollamaKey = resolveListingKey(ModelBackend.Ollama, gateCtx);
  const bflKey = resolveListingKey(ModelBackend.BFL, gateCtx);
  const xaiKey = resolveListingKey(ModelBackend.XAI, gateCtx);
  const localImageBaseUrl = resolveListingKey(ModelBackend.LocalImage, gateCtx);

  const backends = {
    [ModelBackend.OpenAI]: openaiKey ? new OpenAIBackend(openaiKey) : null,
    [ModelBackend.Anthropic]: anthropicKey ? new AnthropicBackend(anthropicKey) : null,
    [ModelBackend.Bedrock]: /* TODO: feature flag */ new UndifferentiatedBedrockBackend(),
    [ModelBackend.Gemini]: geminiKey ? new GeminiBackend(geminiKey) : null,
    [ModelBackend.Ollama]: ollamaKey ? new OllamaBackend(ollamaKey) : null,
    [ModelBackend.BFL]: bflKey ? new BFLBackend(bflKey) : null,
    [ModelBackend.XAI]: xaiKey ? new XAIBackend(xaiKey) : null,
    [ModelBackend.AWS]: new AWSBackend(),
    [ModelBackend.LocalImage]: localImageBaseUrl
      ? new LocalImageBackend(localImageBaseUrl, Logger.globalInstance)
      : null,
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

  let catalogFetchFailed = false;

  // Overlay the model catalog when the app wired a provider. An empty or absent
  // catalog returns the assembled list unchanged - that is the no-behavior-change
  // property this overlay is built on.
  let merged = backendModels;
  if (_catalogProvider) {
    try {
      const rows = await _catalogProvider();
      merged = mergeCatalog(backendModels, rows, gateCtx);
      Logger.globalInstance.info(
        `[getAvailableModels] model catalog applied: ${rows.length} rows over ${backendModels.length} assembled models -> ${merged.length}`
      );
    } catch (error) {
      catalogFetchFailed = true;
      Logger.globalInstance.warn('[getAvailableModels] model catalog unavailable; using adapter tables', error);
    }
  }

  // Overlay versioned catalog prices when the app wired a provider.
  let priced = merged;
  if (_priceRowsProvider) {
    try {
      const rows = await _priceRowsProvider();
      priced = applyModelPriceCatalog(merged, rows);
      const overlaid = priced.filter((m, i) => m !== merged[i]).length;
      Logger.globalInstance.info(`[getAvailableModels] price catalog applied to ${overlaid}/${merged.length} models`);
    } catch (error) {
      catalogFetchFailed = true;
      Logger.globalInstance.warn('[getAvailableModels] price catalog unavailable; using adapter literals', error);
    }
  }

  // Filter out models that have reached their deprecation date (inclusive).
  // RELOCATED: this ran before the price overlay until the catalog landed. It
  // has to run after the merge for catalog lifecycle to drive it; the filter is
  // a subset operation over an independent field, so moving it past the price
  // overlay leaves the output set identical.
  const today = new Date(new Date().toISOString().slice(0, 10));
  const filtered = priced.filter(m => {
    if (!m.deprecationDate) return true;
    const cutoff = new Date(m.deprecationDate + 'T00:00:00Z');
    return today.getTime() < cutoff.getTime();
  });

  // Store in module-level cache (short-lived when a catalog fetch failed).
  const ttl = catalogFetchFailed ? MODEL_CACHE_RETRY_TTL_MS : MODEL_CACHE_TTL_MS;
  _modelCache = { key: cacheKey, models: filtered, expiresAt: Date.now() + ttl };

  return filtered;
};

// Types and core utils:
export * from './backend';
export * from './backendGate';
export * from './endUserId';
export * from './mergeCatalog';

// Implementations:
export * from './anthropicBackend';
export * from './anthropicBatchService';
export * from './awsBackend';
export * from './bedrockBackend/base';
export * from './bedrockBackend/undifferentiated';
export * from './bflBackend';
export * from './geminiBackend';
export * from './localImageBackend';
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
export * from './realtimeVoicePricing';
export * from './resolveDeprecatedModel';
export * from './deprecationHorizon';
export * from './toolPairingUtils';

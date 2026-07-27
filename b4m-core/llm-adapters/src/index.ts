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
import { backendForAdapterFamily } from './adapterFamilyDispatch';
import { AnthropicBackend } from './anthropicBackend';
import { AWSBackend } from './awsBackend';
import { ICompletionBackend } from './backend';
import { isBackendUsable, resolveListingKey } from './backendGate';
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

  // A record the catalog resolved routes on its family; everything else falls
  // through to the id switch below, which is why no currently-dispatched id
  // changes behavior. The family path is the only one that can fail loudly:
  // an unknown family throws instead of returning the null that would be
  // indistinguishable from a missing credential (sec 9 item 3).
  if (modelInfo.adapterFamily) {
    backend = backendForAdapterFamily(modelInfo.adapterFamily, {
      apiKeyTable,
      modelId: String(modelInfo.id),
      logger,
      providerEndUserId,
    });
    backend?.setDispatchModel?.(modelInfo);
    return backend;
  }

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
          backend = new AnthropicBedrockBackend();
          break;
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

  // The seeded tier gets the record too: its thinking style and slow-model flag
  // are catalog-owned once a row claims those groups, and a builder that finds
  // the id in its own table still prefers the table (no behavior change).
  backend?.setDispatchModel?.(modelInfo);

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

/**
 * Backends whose credential is a base URL. Presence is not identity for these:
 * two self-host callers pointing at different Ollama hosts serve different model
 * lists, so the key hashes the value instead of collapsing it to a bit.
 */
const URL_VALUED_BACKENDS: readonly string[] = [ModelBackend.Ollama, ModelBackend.LocalImage];

/** FNV-1a, so a base URL that embeds basic-auth credentials never lands in the key verbatim. */
function hashKeyValue(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Cache identity for one assembled model list. `includePrivate` is deliberately
 * absent: the cache holds the private-inclusive list and the filter is applied on
 * read, so the picker route and the private-model consumers share one entry
 * instead of evicting each other's rebuild.
 */
function getModelCacheKey(
  apiKeys: ApiKeyTable | null,
  gate: { isSelfHost: boolean; perBackendTimeoutMs?: number }
): string {
  // isSelfHost decides which backends get constructed and perBackendTimeoutMs
  // decides what a slow one contributes, so both are part of the identity.
  const suffix = `|selfHost:${gate.isSelfHost ? '1' : '0'}|timeout:${gate.perBackendTimeoutMs ?? 0}`;
  if (!apiKeys) return `null${suffix}`;
  const keys = Object.keys(apiKeys)
    .sort()
    .map(k => {
      const value = apiKeys[k as keyof ApiKeyTable];
      if (value && URL_VALUED_BACKENDS.includes(k)) return `${k}:#${hashKeyValue(value)}`;
      return `${k}:${value ? '1' : '0'}`;
    })
    .join(',');
  return `${keys}${suffix}`;
}

export interface GetAvailableModelsOptions {
  /**
   * Deadline for one backend's listing call, in ms. A backend that misses it
   * contributes nothing instead of holding up the whole fan-out. Omitted means no
   * deadline, which is what every caller but the picker route wants.
   */
  perBackendTimeoutMs?: number;
  /**
   * Emit models flagged `private`. Defaults to true because the settlement and
   * agent consumers resolve pinned private models by id and must keep seeing
   * them; only /api/models, which feeds the picker, passes false.
   */
  includePrivate?: boolean;
  /** Deployment self-host flag; defaults to B4M_SELF_HOST. See BackendGateContext. */
  isSelfHost?: boolean;
}

/**
 * Bound one backend's listing call. Rejects rather than resolving empty so the
 * fan-out's existing catch performs the degradation and names the slow backend.
 */
function withListingTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** The caller's view of a cached list; the cache itself always holds every model. */
const applyPrivateVisibility = (models: ModelInfo[], includePrivate: boolean): ModelInfo[] =>
  includePrivate ? models : models.filter(m => !m.private);

// Given Settings data, return a list of models that are available.  In the
// future, we might consider using this to filter based on capability.
// Only meant to be called from the server.
export const getAvailableModels = async (
  apiKeys: ApiKeyTable | null,
  options: GetAvailableModelsOptions = {}
): Promise<ModelInfo[]> => {
  const { perBackendTimeoutMs } = options;
  const includePrivate = options.includePrivate ?? true;
  const isSelfHost = options.isSelfHost ?? process.env.B4M_SELF_HOST === 'true';

  // Check module-level cache first
  const cacheKey = getModelCacheKey(apiKeys, { isSelfHost, perBackendTimeoutMs });
  if (_modelCache && _modelCache.key === cacheKey && Date.now() < _modelCache.expiresAt) {
    return applyPrivateVisibility(_modelCache.models, includePrivate);
  }

  // Every listing credential comes from resolveListingKey, the same predicate
  // the catalog merge gates catalog-only records with, so the two tiers cannot
  // disagree about which backends this caller can reach. The local-image env
  // fallback and BFL's demo key live in that predicate for the same reason.
  const gateCtx: BackendGateContext = { apiKeys, isSelfHost };
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
    // The keyless AWS-credentialed pair goes through isBackendUsable so the
    // self-host cutoff is stated once, in the same predicate the catalog tier
    // reads, instead of once here and once in /api/models.
    [ModelBackend.Bedrock]: isBackendUsable(ModelBackend.Bedrock, gateCtx)
      ? new UndifferentiatedBedrockBackend()
      : null,
    [ModelBackend.Gemini]: geminiKey ? new GeminiBackend(geminiKey) : null,
    [ModelBackend.Ollama]: ollamaKey ? new OllamaBackend(ollamaKey) : null,
    [ModelBackend.BFL]: bflKey ? new BFLBackend(bflKey) : null,
    [ModelBackend.XAI]: xaiKey ? new XAIBackend(xaiKey) : null,
    [ModelBackend.AWS]: isBackendUsable(ModelBackend.AWS, gateCtx) ? new AWSBackend() : null,
    [ModelBackend.LocalImage]: localImageBaseUrl
      ? new LocalImageBackend(localImageBaseUrl, Logger.globalInstance)
      : null,
  } as const;

  const backendPromises = Object.entries(backends).map(async ([backendName, backend]) => {
    if (!backend) return { backendName, models: [] };

    try {
      const listing = backend.getModelInfo();
      const models = await (perBackendTimeoutMs
        ? withListingTimeout(listing, perBackendTimeoutMs, backendName)
        : listing);
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

  // Store in module-level cache (short-lived when a catalog fetch failed). The
  // cached list is always private-inclusive; see getModelCacheKey.
  const ttl = catalogFetchFailed ? MODEL_CACHE_RETRY_TTL_MS : MODEL_CACHE_TTL_MS;
  _modelCache = { key: cacheKey, models: filtered, expiresAt: Date.now() + ttl };

  return applyPrivateVisibility(filtered, includePrivate);
};

// Types and core utils:
export * from './adapterFamilyDispatch';
export * from './backend';
export * from './backendGate';
export * from './dispatchModel';
export * from './dispatchResolver';
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

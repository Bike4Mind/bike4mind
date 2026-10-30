import {
  ChatModels,
  IModelCatalogRow,
  IModelPrice,
  ModelBackend,
  ModelInfo,
  SupersededModelInfo,
  applyModelPriceCatalog,
  bedrockClientCredentials,
  isModelDeprecated,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { backendForAdapterFamily } from './adapterFamilyDispatch';
import { ANTHROPIC_FEDERATED_KEY, AnthropicBackend } from './anthropicBackend';
import { AWSBackend } from './awsBackend';
import { ICompletionBackend } from './backend';
import { isBackendUsable, resolveListingKey } from './backendGate';
import type { ApiKeyTable, BackendGateContext } from './backendGate';
import { catalogLifecycles } from './deprecationHorizon';
import { toProviderEndUserId } from './endUserId';
import { mergeCatalog } from './mergeCatalog';
import { federatedSharedKeyProviders, resolveProviderCredential } from './providerAuth';
import { alignRouteTwinNames } from './routeTwinNames';
import { buildSupersededIndex, catalogSuccessors, updateReplacedByOverlay } from './resolveDeprecatedModel';
import AnthropicBedrockBackend from './bedrockBackend/anthropic';
import ConverseBedrockBackend, { isConverseBedrockModel } from './bedrockBackend/converse';
import DeepSeekBedrockBackend from './bedrockBackend/deepseek';
import JurassicTwoBedrockBackend from './bedrockBackend/jurassicTwo';
import LlamaBedrockBackend from './bedrockBackend/llama';
import MoonshotBedrockBackend from './bedrockBackend/moonshot';
import TitanBedrockBackend from './bedrockBackend/titan';
import { UndifferentiatedBedrockBackend } from './bedrockBackend/undifferentiated';
import { BFLBackend } from './bflBackend';
import { DeepSeekBackend } from './deepseekBackend';
import { GeminiBackend } from './geminiBackend';
import { KimiBackend } from './kimiBackend';
import { LocalImageBackend } from './localImageBackend';
import { OllamaBackend } from './ollamaBackend';
import { OPENAI_FEDERATED_KEY, OpenAIBackend } from './openaiBackend';
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

  // No id resolution here: callers complete() with the id they passed, so a
  // record swapped in at this point would drop the catalog dispatch profile for
  // the id actually sent. Resolution belongs at the call sites, which already do
  // it through resolveDeprecatedModelId (now catalog-backed).
  // Rarely reached: getAvailableModels drops anything at or past its
  // deprecationDate, so a deprecated record here means a hand-built ModelInfo or
  // a model that expired inside the 5-minute model cache. The alarmable signal
  // lives in resolveDeprecatedModelId, which still sees the id the caller asked
  // for; see modelSunsetMetrics.
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
  // MUST STAY IN SYNC WITH servedByDirectAnthropic and servedByClaudeAdapter in @bike4mind/common
  // (claudeToolCapabilities.ts), which restates this family-then-backend routing.
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
      backend = apiKeyTable.openai
        ? new OpenAIBackend(
            resolveProviderCredential(
              federatedSharedKeyProviders(apiKeyTable)?.openai ? OPENAI_FEDERATED_KEY : apiKeyTable.openai,
              OPENAI_FEDERATED_KEY
            ),
            logger,
            providerEndUserId
          )
        : null;
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
        case ChatModels.CLAUDE_5_5_SONNET_BEDROCK:
        case ChatModels.CLAUDE_4_6_OPUS_BEDROCK:
        case ChatModels.CLAUDE_4_7_OPUS_BEDROCK:
        case ChatModels.CLAUDE_4_8_OPUS_BEDROCK:
        case ChatModels.CLAUDE_FABLE_5_BEDROCK:
        case ChatModels.CLAUDE_FABLE_5_1_BEDROCK:
        case ChatModels.CLAUDE_5_OPUS_BEDROCK:
        case ChatModels.CLAUDE_5_5_OPUS_BEDROCK:
        case ChatModels.CLAUDE_5_5_HAIKU_BEDROCK:
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
        case ChatModels.KIMI_K2_5_BEDROCK:
        case ChatModels.KIMI_K2_THINKING_BEDROCK:
          backend = new MoonshotBedrockBackend();
          break;
        default:
          backend = isConverseBedrockModel(String(modelInfo.id)) ? new ConverseBedrockBackend() : null;
      }
      break;
    case 'anthropic':
      if (apiKeyTable.anthropic === 'expired') throw new Error('Anthropic API key is expired');
      backend = apiKeyTable.anthropic
        ? new AnthropicBackend(
            resolveProviderCredential(
              federatedSharedKeyProviders(apiKeyTable)?.anthropic ? ANTHROPIC_FEDERATED_KEY : apiKeyTable.anthropic,
              ANTHROPIC_FEDERATED_KEY
            ),
            logger,
            providerEndUserId
          )
        : null;
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
      backend = apiKeyTable.bfl ? new BFLBackend(apiKeyTable.bfl) : null;
      break;
    case 'xai':
      if (apiKeyTable.xai === 'expired') throw new Error('xAI API key is expired');
      backend = apiKeyTable.xai ? new XAIBackend(apiKeyTable.xai) : null;
      break;
    case 'kimi':
      if (apiKeyTable.kimi === 'expired') throw new Error('Moonshot API key is expired');
      backend = apiKeyTable.kimi ? new KimiBackend(apiKeyTable.kimi, logger) : null;
      break;
    case 'deepseek':
      if (apiKeyTable.deepseek === 'expired') throw new Error('DeepSeek API key is expired');
      backend = apiKeyTable.deepseek ? new DeepSeekBackend(apiKeyTable.deepseek, logger) : null;
      break;
    case 'aws':
      backend = new AWSBackend();
      break;
    case 'local-image': {
      // Discovered at runtime by LocalImageBackend.getModelInfo, which sets no
      // adapterFamily (see mergeCatalog's DISPATCHABLE_ADAPTER_FAMILIES comment) -
      // this legacy switch is the only path these records reach.
      const localImageBaseUrl = apiKeyTable['local-image'];
      backend = localImageBaseUrl ? new LocalImageBackend(localImageBaseUrl) : null;
      break;
    }
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
// Most backends return static arrays; Ollama and LocalImage query a live server and reject when it is down.
// Model lists almost never change between deploys, so a 5-minute TTL is safe and keeps
// warm Lambda instances from re-fetching every request (admin model changes still take
// effect within 5 minutes, and a cold start always rebuilds the list).
const MODEL_CACHE_TTL_MS = 5 * 60_000;
// When a backend listing or a catalog/price read fails, cache the degraded list
// only briefly: a transient blip or a missed perBackendTimeoutMs should cost
// seconds of a short list or superseded prices, not a full TTL window.
const MODEL_CACHE_RETRY_TTL_MS = 30_000;
// Default listing deadline for runtime-discovered backends; matches LocalImageBackend's axios
// timeout and bounds an Ollama host that drops packets (undici's connect timeout is ~10s).
const RUNTIME_LISTING_DEFAULT_TIMEOUT_MS = 4_000;
// preFilterModels keeps the merged list from before the deprecation filter. It is
// never returned to a caller; getSupersededModels reads it to put a display name
// on a pin the filter has already hidden.
let _modelCache: {
  key: string;
  models: ModelInfo[];
  preFilterModels: ModelInfo[];
  failedListings: ModelBackend[];
  expiresAt: number;
} | null = null;

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

/** Whether a catalog provider is wired on THIS module instance; see esmWorkspacePackages.mjs in apps/client. */
export function hasModelCatalogProvider(): boolean {
  return _catalogProvider !== null;
}

/**
 * Backends whose credential is a base URL (the cache key hashes it, since two hosts serve different
 * lists) and whose models exist only in the live listing, so a failed listing hides ids no catalog knows.
 */
export const RUNTIME_DISCOVERED_BACKENDS: readonly ModelBackend[] = [ModelBackend.Ollama, ModelBackend.LocalImage];

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
  gate: { isSelfHost: boolean; bedrockReachable: boolean; perBackendTimeoutMs?: number }
): string {
  // isSelfHost and bedrockReachable decide which backends get constructed and
  // perBackendTimeoutMs decides what a slow one contributes, so all are part of the identity.
  const suffix =
    `|selfHost:${gate.isSelfHost ? '1' : '0'}|bedrock:${gate.bedrockReachable ? '1' : '0'}` +
    `|timeout:${gate.perBackendTimeoutMs ?? 0}`;
  if (!apiKeys) return `null${suffix}`;
  const keys = Object.keys(apiKeys)
    .sort()
    .map(k => {
      const value = apiKeys[k as keyof ApiKeyTable];
      if (typeof value === 'symbol') {
        if (k === ModelBackend.OpenAI && value === OPENAI_FEDERATED_KEY) return `${k}:federated-symbol`;
        if (k === ModelBackend.Anthropic && value === ANTHROPIC_FEDERATED_KEY) return `${k}:federated-symbol`;
        throw new TypeError('Unrecognized federated provider credential');
      }
      if (value && RUNTIME_DISCOVERED_BACKENDS.includes(k as ModelBackend)) return `${k}:#${hashKeyValue(value)}`;
      return `${k}:${value ? '1' : '0'}`;
    })
    .join(',');
  return `${keys}${suffix}`;
}

export interface GetAvailableModelsOptions {
  /**
   * Deadline for one backend's listing call, in ms. A backend that misses it
   * contributes nothing instead of holding up the whole fan-out. Omitted means no
   * deadline for static backends; runtime-discovered ones (RUNTIME_DISCOVERED_BACKENDS)
   * then get RUNTIME_LISTING_DEFAULT_TIMEOUT_MS.
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
  /** Bedrock credentials are present; defaults to bedrockClientCredentials(). See BackendGateContext. */
  bedrockReachable?: boolean;
  /**
   * Receives the backends whose listing threw or timed out while building the returned list (a
   * cached list replays its own), so a caller can tell "not served" from "could not ask".
   */
  onFailedListings?: (backends: readonly ModelBackend[]) => void;
}

/**
 * Listing options every user-facing model picker passes (the web picker via
 * /api/models, the Slack model dropdowns). Shared so they stay on one cache slot:
 * getModelCacheKey folds perBackendTimeoutMs into the key, so a picker with a
 * different deadline could observe a different list.
 */
export const PICKER_LISTING_OPTIONS = {
  perBackendTimeoutMs: 2_000,
  includePrivate: false,
} as const satisfies GetAvailableModelsOptions;

/**
 * Deadline for the catalog and price reads. Deliberately NOT tied to
 * `perBackendTimeoutMs`: that option is opt-in and only the picker route passes
 * it, while a stalled DB read hurts the callers that omit it (chat turns) most.
 * Mongo's own socketTimeoutMS bounds a stall at ~45s, far past any caller's
 * budget for a model list, so these reads carry their own deadline.
 */
const CATALOG_READ_TIMEOUT_MS = 5_000;

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

/** A throwing callback is the caller's bug and must not cost it the model list. */
function reportFailedListings(options: GetAvailableModelsOptions, failed: readonly ModelBackend[]): void {
  try {
    options.onFailedListings?.(failed);
  } catch (error) {
    Logger.globalInstance.error('[getAvailableModels] onFailedListings callback threw:', error);
  }
}

/** The caller's view of a cached list; the cache itself always holds every model. */
const applyPrivateVisibility = (models: ModelInfo[], includePrivate: boolean): ModelInfo[] =>
  includePrivate ? models : models.filter(m => !m.private);

/** Evaluated under the effective isSelfHost, so an isSelfHost override cannot list Bedrock off hosted defaults. */
function resolveGateContext(
  apiKeys: ApiKeyTable | null,
  overrides: { isSelfHost?: boolean; bedrockReachable?: boolean } = {}
): BackendGateContext {
  const isSelfHost = overrides.isSelfHost ?? process.env.B4M_SELF_HOST === 'true';
  const bedrockReachable =
    overrides.bedrockReachable ??
    bedrockClientCredentials({ ...process.env, B4M_SELF_HOST: isSelfHost ? 'true' : undefined }) !== null;
  return { apiKeys, isSelfHost, bedrockReachable };
}

// Given Settings data, return a list of models that are available.
// Only meant to be called from the server.
export const getAvailableModels = async (
  apiKeys: ApiKeyTable | null,
  options: GetAvailableModelsOptions = {}
): Promise<ModelInfo[]> => {
  const { perBackendTimeoutMs } = options;
  const includePrivate = options.includePrivate ?? true;
  const gateCtx = resolveGateContext(apiKeys, options);
  const { isSelfHost, bedrockReachable } = gateCtx;

  // Check module-level cache first
  const cacheKey = getModelCacheKey(apiKeys, { isSelfHost, bedrockReachable, perBackendTimeoutMs });
  if (_modelCache && _modelCache.key === cacheKey && Date.now() < _modelCache.expiresAt) {
    reportFailedListings(options, _modelCache.failedListings);
    return applyPrivateVisibility(_modelCache.models, includePrivate);
  }

  // Every listing credential comes from resolveListingKey, the same predicate
  // the catalog merge gates catalog-only records with, so the two tiers cannot
  // disagree about which backends this caller can reach. The local-image env
  // fallback lives in that predicate for the same reason.
  const openaiKey = resolveListingKey(ModelBackend.OpenAI, gateCtx);
  const anthropicKey = resolveListingKey(ModelBackend.Anthropic, gateCtx);
  const geminiKey = resolveListingKey(ModelBackend.Gemini, gateCtx);
  const ollamaKey = resolveListingKey(ModelBackend.Ollama, gateCtx);
  const bflKey = resolveListingKey(ModelBackend.BFL, gateCtx);
  const xaiKey = resolveListingKey(ModelBackend.XAI, gateCtx);
  const kimiKey = resolveListingKey(ModelBackend.Kimi, gateCtx);
  const deepseekKey = resolveListingKey(ModelBackend.DeepSeek, gateCtx);
  const localImageBaseUrl = resolveListingKey(ModelBackend.LocalImage, gateCtx);

  const backends = {
    [ModelBackend.OpenAI]: openaiKey
      ? new OpenAIBackend(resolveProviderCredential(openaiKey, OPENAI_FEDERATED_KEY))
      : null,
    [ModelBackend.Anthropic]: anthropicKey
      ? new AnthropicBackend(resolveProviderCredential(anthropicKey, ANTHROPIC_FEDERATED_KEY))
      : null,
    // The keyless AWS-credentialed pair goes through isBackendUsable so the
    // self-host rules (Bedrock needs BEDROCK_AWS_*, AWS is hosted-only) are stated
    // once, in the same predicate the catalog tier reads, instead of once here and once in /api/models.
    [ModelBackend.Bedrock]: isBackendUsable(ModelBackend.Bedrock, gateCtx)
      ? new UndifferentiatedBedrockBackend()
      : null,
    [ModelBackend.Gemini]: geminiKey ? new GeminiBackend(geminiKey) : null,
    [ModelBackend.Ollama]: ollamaKey ? new OllamaBackend(ollamaKey) : null,
    [ModelBackend.BFL]: bflKey ? new BFLBackend(bflKey) : null,
    [ModelBackend.XAI]: xaiKey ? new XAIBackend(xaiKey) : null,
    [ModelBackend.Kimi]: kimiKey ? new KimiBackend(kimiKey) : null,
    [ModelBackend.DeepSeek]: deepseekKey ? new DeepSeekBackend(deepseekKey) : null,
    [ModelBackend.AWS]: isBackendUsable(ModelBackend.AWS, gateCtx) ? new AWSBackend() : null,
    [ModelBackend.LocalImage]: localImageBaseUrl ? new LocalImageBackend(localImageBaseUrl) : null,
  } as const;

  const backendPromises = Object.entries(backends).map(async ([backendName, backend]) => {
    if (!backend) return { backendName, models: [] };

    const live = RUNTIME_DISCOVERED_BACKENDS.includes(backendName as ModelBackend);
    const timeoutMs = perBackendTimeoutMs || (live ? RUNTIME_LISTING_DEFAULT_TIMEOUT_MS : 0);
    try {
      const listing = backend.getModelInfo();
      const models = await (timeoutMs ? withListingTimeout(listing, timeoutMs, backendName) : listing);
      return { backendName, models };
    } catch (error) {
      const message = `[getAvailableModels] Error fetching models from ${backendName}:`;
      if (live) Logger.globalInstance.warn(message, error instanceof Error ? error.message : error);
      else Logger.globalInstance.error(message, error);
      return { backendName, models: [], error };
    }
  });

  const results = await Promise.all(backendPromises);
  const failedListings = results.filter(r => 'error' in r).map(r => r.backendName as ModelBackend);
  const backendModels = results.flatMap(r => r.models);

  let catalogFetchFailed = false;

  // Overlay the model catalog when the app wired a provider. An empty or absent
  // catalog returns the assembled list unchanged - that is the no-behavior-change
  // property this overlay is built on.
  let merged = backendModels;
  if (_catalogProvider) {
    try {
      const rows = await withListingTimeout(_catalogProvider(), CATALOG_READ_TIMEOUT_MS, 'model catalog read');
      merged = mergeCatalog(backendModels, rows, gateCtx);
      // Catalog successors take precedence over the static sunset map (sec
      // 5.10). Refreshed here, so before the first catalog read - cold start,
      // no provider wired - resolution falls back to the static map alone.
      // Skipped on an empty read, mirroring mergeCatalog's early return: no rows
      // is no information, and wiping the overlay would strand every
      // catalog-sourced successor until the next non-empty read.
      if (rows.length > 0) updateReplacedByOverlay(catalogSuccessors(catalogLifecycles(rows)));
      Logger.globalInstance.info(
        `[getAvailableModels] model catalog applied: ${rows.length} rows over ${backendModels.length} assembled models -> ${merged.length}`
      );
    } catch (error) {
      catalogFetchFailed = true;
      // The replacedBy overlay is deliberately left as it was: yesterday's
      // successors beat none while the catalog is unreachable.
      Logger.globalInstance.warn('[getAvailableModels] model catalog unavailable; using adapter tables', error);
    }
  }

  merged = await alignRouteTwinNames(merged);

  // Overlay versioned catalog prices when the app wired a provider.
  let priced = merged;
  if (_priceRowsProvider) {
    try {
      const rows = await withListingTimeout(_priceRowsProvider(), CATALOG_READ_TIMEOUT_MS, 'price catalog read');
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
  const filtered = priced.filter(m => !isModelDeprecated(m));

  // Store in module-level cache (short-lived when a listing or catalog fetch
  // failed). The cached list is always private-inclusive; see getModelCacheKey.
  const ttl = failedListings.length > 0 || catalogFetchFailed ? MODEL_CACHE_RETRY_TTL_MS : MODEL_CACHE_TTL_MS;
  _modelCache = {
    key: cacheKey,
    models: filtered,
    preFilterModels: priced,
    failedListings,
    expiresAt: Date.now() + ttl,
  };

  reportFailedListings(options, failedListings);
  return applyPrivateVisibility(filtered, includePrivate);
};

/**
 * Can this caller reach a static-table backend that serves `modelId`? Reads the adapter tables, not the live
 * listing; an id no static table names (an Ollama pull, a catalog-only row) answers false.
 */
export async function isModelProviderConfigured(modelId: string, apiKeys: ApiKeyTable | null): Promise<boolean> {
  const ctx = resolveGateContext(apiKeys);
  const placeholder = 'static-listing';
  const statics: Array<[ModelBackend, () => ICompletionBackend]> = [
    [ModelBackend.OpenAI, () => new OpenAIBackend(placeholder)],
    [ModelBackend.Anthropic, () => new AnthropicBackend(placeholder)],
    [ModelBackend.Gemini, () => new GeminiBackend(placeholder)],
    [ModelBackend.XAI, () => new XAIBackend(placeholder)],
    [ModelBackend.Kimi, () => new KimiBackend(placeholder)],
    [ModelBackend.DeepSeek, () => new DeepSeekBackend(placeholder)],
    [ModelBackend.Bedrock, () => new UndifferentiatedBedrockBackend()],
  ];
  for (const [backend, build] of statics) {
    if (isBackendUsable(backend, ctx) && (await build().getModelInfo()).some(m => m.id === modelId)) return true;
  }
  return false;
}

/**
 * Superseded pins the given caller can be upgraded off, for clients that must
 * recognize a session pinned to a model the picker no longer lists.
 *
 * Call it AFTER getAvailableModels with that call's result: the display names for
 * hidden pins come from the pre-filter list the fan-out cached, and the catalog
 * successor overlay is refreshed by the same call. Before any fan-out has run in
 * this process, hidden pins degrade to their raw ids.
 */
export const getSupersededModels = (currentModels: ModelInfo[]): SupersededModelInfo[] =>
  buildSupersededIndex(_modelCache?.preFilterModels ?? currentModels, currentModels);

// Types and core utils:
export * from './adapterFamilyDispatch';
export * from './adapterPriceLiterals';
export * from './backend';
export * from './backendGate';
export * from './cacheInclusiveUsage';
export * from './degenerateStreamGuard';
export * from './dispatchModel';
export * from './dispatchResolver';
export * from './endUserId';
export * from './mergeCatalog';
export * from './providerAuth';
export * from './routeTwinNames';
export * from './wifTokenSource';

// Implementations:
export * from './anthropicBackend';
export * from './llmTimeoutErrors';
export * from './llmEmptyTurnErrors';
export * from './anthropicBatchService';
export * from './awsBackend';
export * from './bedrockBackend/base';
export * from './bedrockBackend/converse';
export * from './bedrockBackend/undifferentiated';
export * from './bflBackend';
export * from './geminiBackend';
export * from './deepseekBackend';
export * from './deepseekParams';
export * from './kimiBackend';
export * from './kimiParams';
export * from './localImageBackend';
export * from './ollamaBackend';
export * from './openaiBackend';
export * from './xaiBackend';

export {
  AnthropicBedrockBackend,
  DeepSeekBedrockBackend,
  JurassicTwoBedrockBackend,
  LlamaBedrockBackend,
  MoonshotBedrockBackend,
  TitanBedrockBackend,
};

export {
  SemaphoreBusyError,
  MAX_CONCURRENT_ANTHROPIC_CALLS,
  MAX_QUEUED_PER_TENANT,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
} from './_anthropicSemaphore';
export { isTerminalToolError, isTurnEndingTool } from './executeToolsBatch';
export * from './PipelineTimer';
export * from './realtimeVoicePricing';
export {
  TOOL_RESULT_TRUNCATION_NOTICE,
  MAX_FULL_TOOL_RESULT_CHARS,
  attachFullToolResult,
  getFullToolResult,
  type FullToolResult,
} from './recordToolResult';
export * from './reasoningEfforts';
export * from './resolveDeprecatedModel';
export * from './deprecationHorizon';
export * from './staleReferences';
export * from './modelSunsetMetrics';
export * from './thinkingParams';
export * from './toolPairingUtils';
export { convertOpenAIToolHistoryToCanonical } from './messageFormatConverter';

import { ApiKeyType, IAdminSettings, IAdminSettingsRepository, IApiKeyDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  getApiKey,
  GetApiKeyAdapters,
  GetApiKeyParamters,
  getMultipleApiKeys,
  GetMultipleApiKeysAdapters,
} from './get';

// Map providers to their demo key setting names
const DEMO_KEY_MAP: Partial<Record<ApiKeyType, IAdminSettings['settingName']>> = {
  [ApiKeyType.openai]: 'openaiDemoKey',
  [ApiKeyType.anthropic]: 'anthropicDemoKey',
  [ApiKeyType.gemini]: 'geminiDemoKey',
  [ApiKeyType.xai]: 'xaiApiKey',
  [ApiKeyType.bfl]: 'bflApiKey',
  [ApiKeyType.voyageai]: 'voyageApiKey',
};

// Base type - used by getEffectiveApiKey (~15 callers, unchanged contract)
export type GetEffectiveApiKeyAdapters = GetApiKeyAdapters &
  GetMultipleApiKeysAdapters & {
    db: {
      adminSettings: IAdminSettingsRepository;
    };
  };

// Extended type - used ONLY by getEffectiveLLMApiKeys (~40 callers)
export type GetEffectiveLLMApiKeysAdapters = GetEffectiveApiKeyAdapters & {
  getSettingsByNames: (
    names: Parameters<IAdminSettingsRepository['findBySettingNames']>[0],
    db: { adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'> },
    options?: { logger?: Logger; skipCache?: boolean }
  ) => Promise<Record<string, string | null>>;
};

// Self-host: fall back to a provider value from the environment (.env.selfhost)
// when no admin setting is stored. Trimmed so a whitespace-only value stays
// "unset" instead of enabling the feature. Only returns a value when
// B4M_SELF_HOST=true. Shared by getEffectiveLLMApiKeys and the search/scrape
// config getters below so the self-host fallback rule stays in one place.
export const envKey = (name: string): string | null =>
  (process.env.B4M_SELF_HOST === 'true' && process.env[name]?.trim()) || null;

export const getSerperKey = async (adapters: GetEffectiveApiKeyAdapters) => {
  const { db } = adapters;
  const settings = await db.adminSettings.findBySettingName('SerperKey');
  return settings?.settingValue;
};

// Base URL of an admin- or env-configured SearXNG instance for local web search,
// or null when unconfigured. Consumed by resolveWebSearchProvider (services).
export const getSearxngUrl = async (adapters: GetEffectiveApiKeyAdapters): Promise<string | null> => {
  const { db } = adapters;
  const settings = await db.adminSettings.findBySettingName('SearxngUrl');
  return settings?.settingValue?.trim() || envKey('SEARXNG_BASE_URL');
};

// Admin's chosen web-search provider ('auto' | 'serpapi' | 'searxng'), or null
// when unset (the resolver treats null as 'auto').
export const getWebSearchProviderSetting = async (adapters: GetEffectiveApiKeyAdapters): Promise<string | null> => {
  const { db } = adapters;
  const settings = await db.adminSettings.findBySettingName('WebSearchProvider');
  return settings?.settingValue?.trim() || null;
};

export interface FirecrawlConfig {
  apiKey?: string;
  apiUrl?: string;
}

// Resolve Firecrawl config: admin settings first, then the self-host env fallback. A custom apiUrl
// (self-hosted Firecrawl) is enough on its own - firecrawl-js runs keyless against a non-cloud URL.
export const getFirecrawlConfig = async (adapters: GetEffectiveApiKeyAdapters): Promise<FirecrawlConfig> => {
  const { db } = adapters;
  const [keySetting, urlSetting] = await Promise.all([
    db.adminSettings.findBySettingName('FirecrawlApiKey'),
    db.adminSettings.findBySettingName('FirecrawlApiUrl'),
  ]);
  return {
    apiKey: keySetting?.settingValue?.trim() || envKey('FIRECRAWL_API_KEY') || undefined,
    apiUrl: urlSetting?.settingValue?.trim() || envKey('FIRECRAWL_API_URL') || undefined,
  };
};

export const getOpenWeatherKey = async (adapters: GetEffectiveApiKeyAdapters) => {
  const { db } = adapters;
  const settings = await db.adminSettings.findBySettingName('OpenWeatherKey');
  return settings?.settingValue;
};

export const getWolframAlphaKey = async (adapters: GetEffectiveApiKeyAdapters) => {
  const { db } = adapters;
  const settings = await db.adminSettings.findBySettingName('WolframAlphaKey');
  return settings?.settingValue;
};

export const getFmpApiKey = async (adapters: GetEffectiveApiKeyAdapters) => {
  const { db } = adapters;
  const settings = await db.adminSettings.findBySettingName('FmpApiKey');
  return settings?.settingValue;
};

export const getEffectiveApiKey = async (
  userId: string,
  params: GetApiKeyParamters,
  adapters: GetEffectiveApiKeyAdapters
) => {
  const { db } = adapters;
  const apiKey = await getApiKey(userId, params, adapters);

  let key = apiKey?.apiKey;

  if (!key) {
    const demoKeyName = params.demoKeyName || DEMO_KEY_MAP[params.type as keyof typeof DEMO_KEY_MAP];
    if (demoKeyName) {
      const settings = await db.adminSettings.findBySettingName(demoKeyName as IAdminSettings['settingName']);
      key = settings?.settingValue;
    }
  }

  return key;
};

export const getEffectiveLLMApiKeys = async (
  userId: string | null,
  adapters: GetEffectiveLLMApiKeysAdapters,
  options?: {
    logger?: Logger;
  }
) => {
  const { db } = adapters;
  const logger = options?.logger;

  const apiKeyFetchStartTime = Date.now();

  // Fetch all admin settings names (needed for both paths)
  const adminSettingNames: IAdminSettings['settingName'][] = [
    'openaiDemoKey',
    'anthropicDemoKey',
    'geminiDemoKey',
    'bflApiKey',
    'xaiApiKey',
    'voyageApiKey',
    'ollamaBackend',
    'EnableOllama',
  ];

  // When userId is null, skip the user-level key lookup entirely and resolve
  // keys from admin settings only. Used by callers that don't have a per-user
  // context (e.g., the Voice v2 LLM proxy serving ElevenLabs preview tests).
  const [userApiKeys, adminSettings] = await Promise.all([
    userId
      ? getMultipleApiKeys(
          userId,
          [
            ApiKeyType.openai,
            ApiKeyType.anthropic,
            ApiKeyType.gemini,
            ApiKeyType.bfl,
            ApiKeyType.xai,
            ApiKeyType.voyageai,
          ],
          adapters
        )
      : Promise.resolve<IApiKeyDocument[]>([]),
    adapters.getSettingsByNames(adminSettingNames, { adminSettings: db.adminSettings }, { logger }),
  ]);

  const userKeyMap = new Map<ApiKeyType, IApiKeyDocument>();
  userApiKeys.forEach(key => userKeyMap.set(key.type, key));

  // Extract individual keys for backward compatibility
  const openaiUserKey = userKeyMap.get(ApiKeyType.openai) || null;
  const anthropicUserKey = userKeyMap.get(ApiKeyType.anthropic) || null;
  const geminiUserKey = userKeyMap.get(ApiKeyType.gemini) || null;
  const bflUserKey = userKeyMap.get(ApiKeyType.bfl) || null;
  const xaiUserKey = userKeyMap.get(ApiKeyType.xai) || null;
  const voyageaiUserKey = userKeyMap.get(ApiKeyType.voyageai) || null;

  // Extract individual settings for backward compatibility
  const openaiDemoKey = adminSettings['openaiDemoKey'];
  const anthropicDemoKey = adminSettings['anthropicDemoKey'];
  const geminiDemoKey = adminSettings['geminiDemoKey'];
  const bflDemoKey = adminSettings['bflApiKey'];
  const xaiDemoKey = adminSettings['xaiApiKey'];
  const voyageaiDemoKey = adminSettings['voyageApiKey'];
  const ollamaBackend = adminSettings['ollamaBackend'];
  const enableOllama = adminSettings['EnableOllama'];

  const totalTime = Date.now() - apiKeyFetchStartTime;

  if (logger) {
    logger.info(`📦 API key + admin settings parallel fetch completed in ${totalTime}ms`);
  }

  // Handle both string 'true' and boolean true (database can store either)
  const ollamaEnabled = enableOllama === 'true' || (enableOllama as unknown) === true;
  const keyOrExpired = (apiKey: IApiKeyDocument | null) => {
    if (!apiKey) return null;
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return 'expired';
    return apiKey.apiKey;
  };

  // Self-host provider-key fallback uses the shared module-scope envKey (above).
  return {
    openai: keyOrExpired(openaiUserKey) || openaiDemoKey || envKey('OPENAI_API_KEY'),
    anthropic: keyOrExpired(anthropicUserKey) || anthropicDemoKey || envKey('ANTHROPIC_API_KEY'),
    gemini: keyOrExpired(geminiUserKey) || geminiDemoKey || envKey('GEMINI_API_KEY'),
    bfl: keyOrExpired(bflUserKey) || bflDemoKey || null,
    xai: keyOrExpired(xaiUserKey) || xaiDemoKey || envKey('XAI_API_KEY'),
    voyageai: keyOrExpired(voyageaiUserKey) || voyageaiDemoKey || null,
    // Self-host: when OLLAMA_BASE_URL is set in the environment, enable Ollama
    // pointed at that endpoint without requiring the DB admin settings
    // (EnableOllama / ollamaBackend). This is what makes local models work
    // out of the box with no provider keys. An explicit admin config still
    // takes precedence. envKey() only returns a value when B4M_SELF_HOST=true.
    ollama: (ollamaEnabled ? ollamaBackend || null : null) || envKey('OLLAMA_BASE_URL'),
    // Self-host: base URL of a local Stable-Diffusion server (A1111-compatible
    // REST API). Gated on B4M_SELF_HOST like the other env fallbacks; mirrors
    // OLLAMA_BASE_URL for local image generation with no provider keys.
    imageGen: envKey('IMAGE_GEN_BASE_URL'),
  };
};

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

export const getSerperKey = async (adapters: GetEffectiveApiKeyAdapters) => {
  const { db } = adapters;
  const settings = await db.adminSettings.findBySettingName('SerperKey');
  return settings?.settingValue;
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

  return {
    openai: keyOrExpired(openaiUserKey) || openaiDemoKey || null,
    anthropic: keyOrExpired(anthropicUserKey) || anthropicDemoKey || null,
    gemini: keyOrExpired(geminiUserKey) || geminiDemoKey || null,
    bfl: keyOrExpired(bflUserKey) || bflDemoKey || null,
    xai: keyOrExpired(xaiUserKey) || xaiDemoKey || null,
    voyageai: keyOrExpired(voyageaiUserKey) || voyageaiDemoKey || null,
    ollama: ollamaEnabled ? ollamaBackend || null : null,
  };
};

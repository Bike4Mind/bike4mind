import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import { apiKeyService } from '@bike4mind/services';
import { apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { getSettingsByNames } from '@bike4mind/utils';
import type { B4MLLMTools } from '@bike4mind/common';
import { Resource } from 'sst';

/**
 * Presence-only availability for tools that need an external API key/config.
 * Booleans (never the key values) so the tools picker can disable a tool and
 * explain what's missing, instead of the tool silently returning empty results.
 * Keyed by the tool id (B4MLLMTools); a tool absent from the map is unconditional.
 */
export type ToolAvailability = Partial<Record<B4MLLMTools, boolean>>;

export type ServerConfig = {
  websocketUrl: string;
  wsCompletionUrl: string;
  /** Direct Lambda function URL for SSE completions. Empty when CliLlmHandler is not linked. */
  completionsUrl: string;
  appfileBucketName: string;
  fabfileBucketName: string;
  googleClientId: string;
  seedStageName: string;
  cdnUrl: string;
  /** Inbound-email recipient domain (e.g. "@app.<domain>"); empty when unconfigured. */
  platformEmailDomain: string;
  /** Per-request availability of key-gated tools, for the tools picker. */
  toolAvailability: ToolAvailability;
};

// Get Admin Settings - requires authentication
// Public pre-login fields (apiUrl, defaultTheme) are served by /api/settings/serverConfigPublic
const handler = baseApi({ auth: true }).get(
  asyncHandler(async (req, res) => {
    const toolAvailability = await computeToolAvailability(req.user?.id);

    const config: ServerConfig = {
      websocketUrl: Resource.websocket.url,
      wsCompletionUrl:
        'CliWsCompletionHandler' in Resource
          ? (Resource as unknown as Record<string, { url: string }>).CliWsCompletionHandler.url
          : '',
      completionsUrl:
        'CliLlmHandler' in Resource ? (Resource as unknown as Record<string, { url: string }>).CliLlmHandler.url : '',
      appfileBucketName: Resource.appFilesBucket.name,
      fabfileBucketName: Resource.fabFileBucket.name,
      // Sanitize placeholder values - don't expose 'not-configured' to frontend
      googleClientId: Config.GOOGLE_CLIENT_ID === 'not-configured' ? '' : Config.GOOGLE_CLIENT_ID,
      seedStageName: process.env.NEXT_PUBLIC_SEED_STAGE_NAME || '',
      cdnUrl: process.env.NEXT_PUBLIC_CDN_URL || '',
      // Inbound-email recipient domain, externalized for open-core; no brand fallback.
      platformEmailDomain: process.env.PLATFORM_EMAIL_DOMAIN || '',
      toolAvailability,
    };

    return res.json(config);
  })
);

/**
 * Resolves which key-gated tools are usable, mirroring the same key getters the
 * tools themselves use so the picker never disables a tool that would actually
 * work (and vice versa). Only booleans are returned - never the key values.
 * Failures degrade to "available" so a lookup error never hides a working tool.
 */
async function computeToolAvailability(userId: string | undefined): Promise<ToolAvailability> {
  const dbAdapters = {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  };

  try {
    const [serperKey, openWeatherKey, wolframKey, fmpKey, llmKeys] = await Promise.all([
      apiKeyService.getSerperKey(dbAdapters),
      apiKeyService.getOpenWeatherKey(dbAdapters),
      apiKeyService.getWolframAlphaKey(dbAdapters),
      apiKeyService.getFmpApiKey(dbAdapters),
      // Image/embedding keys resolve per user (user key -> admin demo -> self-host env).
      userId ? apiKeyService.getEffectiveLLMApiKeys(userId, dbAdapters) : Promise.resolve(null),
    ]);

    // getEffectiveLLMApiKeys returns the sentinel 'expired' (truthy) for an expired
    // user key, which the tool then rejects - treat it as absent so we don't report
    // a tool as available when it would actually fail.
    const usable = (key: string | null | undefined) => !!key && key !== 'expired';

    const hasSerper = !!serperKey;
    const hasImageKey =
      usable(llmKeys?.bfl) || usable(llmKeys?.openai) || usable(llmKeys?.gemini) || usable(llmKeys?.xai);
    // Knowledge Base semantic search needs an embeddings provider key (VoyageAI/OpenAI).
    const hasEmbeddingKey = usable(llmKeys?.openai) || usable(llmKeys?.voyageai);

    return {
      web_search: hasSerper,
      // Deep Research is built on web search, so it needs the same Serper key.
      deep_research: hasSerper,
      weather_info: !!openWeatherKey,
      wolfram_alpha: !!wolframKey,
      fmp_financial_data: !!fmpKey,
      image_generation: hasImageKey,
      search_knowledge_base: hasEmbeddingKey,
      retrieve_knowledge_content: hasEmbeddingKey,
    };
  } catch (err) {
    // Fail open: an availability lookup error should not disable working tools.
    console.warn('serverConfig: tool availability lookup failed, defaulting to available', err);
    return {};
  }
}

export const config = {
  api: {
    externalResolver: true,
  },
  bind: ['websocketApi'],
};

export default handler;

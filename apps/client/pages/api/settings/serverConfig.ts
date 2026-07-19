import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import { apiKeyService } from '@bike4mind/services';
import { apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { getSettingsByNames } from '@bike4mind/utils';
import { ApiKeyType } from '@bike4mind/common';
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
  /**
   * CLI HTTP->WS completions endpoint on the ChatCompletion service: the CLI POSTs the
   * request payload here and receives the stream over its WebSocket connection. A relative
   * path on hosted deploys (CloudFront routes it under the app domain); an absolute URL
   * built from CHAT_COMPLETION_PUBLIC_URL on self-host / local dev.
   */
  wsCompletionUrl: string;
  /**
   * Optional direct URL for SSE completions. Empty in hosted deploys, where completions are
   * served by the always-on ChatCompletion service under the app domain: the CLI falls back to
   * the CloudFront-fronted `/api/ai/v1/completions` path (HTTPS + WAF). Self-host has no CDN
   * routing that path to the service, so CHAT_COMPLETION_PUBLIC_URL (the service's published
   * origin, e.g. http://localhost:8788) advertises the direct endpoint instead.
   */
  sseCompletionsUrl: string;
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
      // CLI HTTP->WS completions, served by the ChatCompletion service (it replaced the
      // CliWsCompletionHandler Lambda). Resolution mirrors sseCompletionsUrl below, except a
      // relative path is advertised on hosted (the CLI resolves it against its API base URL):
      // CloudFront routes it to the service, and the route 202s immediately, so the origin
      // read timeout that forced the old Lambda onto a direct function URL doesn't apply.
      // Self-host / local dev advertise the service's published origin instead.
      wsCompletionUrl: process.env.CHAT_COMPLETION_PUBLIC_URL
        ? `${process.env.CHAT_COMPLETION_PUBLIC_URL.replace(/\/+$/, '')}/api/ai/v1/ws-completions`
        : '/api/ai/v1/ws-completions',
      // Hosted: served by the ChatCompletion service via CloudFront at /api/ai/v1/completions,
      // so there is no direct URL to advertise (empty -> the CLI uses that same-origin path).
      // Self-host: nothing routes that path on the app origin, so advertise the service's
      // published endpoint from CHAT_COMPLETION_PUBLIC_URL (see the ServerConfig type doc).
      sseCompletionsUrl: process.env.CHAT_COMPLETION_PUBLIC_URL
        ? `${process.env.CHAT_COMPLETION_PUBLIC_URL.replace(/\/+$/, '')}/api/ai/v1/completions`
        : '',
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
 * A self-hosted local image backend (IMAGE_GEN_BASE_URL) needs no provider API
 * key, so image generation is usable whenever it's configured. The env var is
 * honored ONLY under B4M_SELF_HOST - mirroring the tool's own dispatch gate and
 * the getAvailableModels enumeration gate - so a hosted deploy that happens to
 * set it never reports the tool as available on that basis. Exported for tests.
 */
export function isLocalImageBackendAvailable(): boolean {
  return process.env.B4M_SELF_HOST === 'true' && !!process.env.IMAGE_GEN_BASE_URL?.trim();
}

/**
 * Resolves which key-gated tools are usable, mirroring the same key getters the
 * tools themselves use so the picker never disables a tool that would actually
 * work (and vice versa). Only booleans are returned - never the key values.
 * Failures degrade to "available" so a lookup error never hides a working tool.
 *
 * LOCK-STEP: the tool ids returned here must have a matching entry in
 * `MISSING_KEY_TOOLTIPS` in `apps/client/app/components/Session/AISettings/ToolsSection.tsx`,
 * which supplies the user-facing "why it's disabled" text.
 *
 * Cost: this runs ~10 admin-setting / user-key lookups per request (4 single-key
 * getters + Firecrawl + the batched LLM keys + one per image provider). It's on
 * the /serverConfig path (which also serves the WebSocket URL), but the client
 * caches that response for ~5 min (see `useConfig`), so it touches the DB only on
 * a fresh page-load, not on every render.
 */
async function computeToolAvailability(userId: string | undefined): Promise<ToolAvailability> {
  const dbAdapters = {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  };

  try {
    // The image tool resolves its key via getEffectiveApiKey (user key -> admin demo
    // key, NO self-host env fallback), so image availability must use the same path -
    // getEffectiveLLMApiKeys would add an env fallback the tool never sees.
    const imageProviders = [ApiKeyType.bfl, ApiKeyType.openai, ApiKeyType.gemini, ApiKeyType.xai];

    const [serperKey, openWeatherKey, wolframKey, fmpKey, firecrawlSetting, llmKeys, imageKeys] = await Promise.all([
      apiKeyService.getSerperKey(dbAdapters),
      apiKeyService.getOpenWeatherKey(dbAdapters),
      apiKeyService.getWolframAlphaKey(dbAdapters),
      apiKeyService.getFmpApiKey(dbAdapters),
      // Deep Research uses Firecrawl (not Serper) - mirror the tool's own key read.
      adminSettingsRepository.findBySettingName('FirecrawlApiKey'),
      // Embedding keys (for Knowledge Base) resolve per user; KB uses this same getter,
      // so matching its self-host env fallback here is correct.
      userId ? apiKeyService.getEffectiveLLMApiKeys(userId, dbAdapters) : Promise.resolve(null),
      userId
        ? Promise.all(imageProviders.map(type => apiKeyService.getEffectiveApiKey(userId, { type }, dbAdapters)))
        : Promise.resolve<(string | undefined)[]>([]),
    ]);

    // getEffectiveLLMApiKeys returns the sentinel 'expired' (truthy) for an expired
    // user key, which the tool then rejects - treat it as absent so we don't report
    // a tool as available when it would actually fail.
    const usable = (key: string | null | undefined) => !!key && key !== 'expired';

    const hasSerper = !!serperKey;
    const hasFirecrawl = !!firecrawlSetting?.settingValue;
    const hasImageKey = imageKeys.some(usable);
    // Knowledge Base semantic search needs an embeddings provider key (VoyageAI/OpenAI).
    // Note: this checks "any embeddings key present", not the admin's `defaultEmbeddingModel`
    // provider specifically. If the admin selects a Voyage model but only an OpenAI key is set
    // (or vice versa), the tool still shows as available and the semantic path falls back to
    // keyword search - deliberately lenient, since we'd rather under-gate KB than hide a tool
    // that still returns keyword results.
    const hasEmbeddingKey = usable(llmKeys?.openai) || usable(llmKeys?.voyageai);

    return {
      web_search: hasSerper,
      // Deep Research uses the Firecrawl web-scraping service, not Serper.
      deep_research: hasFirecrawl,
      weather_info: !!openWeatherKey,
      wolfram_alpha: !!wolframKey,
      fmp_financial_data: !!fmpKey,
      // Available with a provider key OR a self-hosted local image backend (which needs none).
      image_generation: hasImageKey || isLocalImageBackendAvailable(),
      // Only search_knowledge_base needs an embeddings key; retrieve_knowledge_content
      // is a direct file/keyword lookup that needs no external key, so it isn't gated.
      search_knowledge_base: hasEmbeddingKey,
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

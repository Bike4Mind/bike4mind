/**
 * Server-side availability of key-gated LLM tools: which tools a user can actually use, based on
 * the same key/config resolvers each tool itself uses. Two consumers need different semantics from
 * the SAME underlying lookups, so this module is split into an honest resolver and a
 * schema-enforcement wrapper:
 *
 * - `resolveToolAvailability` returns the real signal (search_knowledge_base CAN be false when
 *   keyless) - the Tools picker UI depends on this to grey out a row and show the right tooltip.
 * - `isToolOfferable` is the ENFORCEMENT-only wrapper used when building the tool schema list sent
 *   to the model: it forces search_knowledge_base to stay offerable (it degrades to keyword search
 *   rather than failing, so hiding its schema would be strictly worse).
 *
 * Moved out of apps/client/pages/api/settings/serverConfig.ts (which keeps a thin wrapper of the
 * same name) so b4m-core/services can filter the model-facing tool list by availability, not just
 * the Tools-picker UI hint - see sharedToolBuilder.ts's use of `isToolOfferable`.
 */
import { ApiKeyType, isPlaceholderApiKey, type B4MLLMTools } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { getSettingsByNames } from '@bike4mind/utils';
import {
  getEffectiveApiKey,
  getEffectiveLLMApiKeys,
  getFirecrawlConfig,
  getFmpApiKey,
  getOpenWeatherKey,
  getWolframAlphaKey,
  type GetEffectiveLLMApiKeysAdapters,
} from '../apiKeyService';
import { resolveWebSearchProvider } from './tools/implementation/websearch';

/**
 * Presence-only availability for tools that need an external API key/config.
 * Booleans (never the key values) so a caller can disable a tool and explain
 * what's missing, instead of the tool silently returning empty results.
 * Keyed by the tool id (B4MLLMTools); a tool absent from the map is unconditional.
 */
export type ToolAvailability = Partial<Record<B4MLLMTools, boolean>>;

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
 * A self-hosted local Ollama embedder (OLLAMA_BASE_URL) needs no provider API key, so the
 * Knowledge Base tool is usable whenever one is configured under B4M_SELF_HOST - same shape as
 * isLocalImageBackendAvailable. Without this, KB stays disabled on a keyless self-host box even
 * though offline RAG embeds and retrieves locally, so the model never receives the tool's
 * instructions. Lenient by design (see the under-gate-KB note below): if an admin picks a cloud
 * embedder with no key, KB still shows and degrades to keyword search.
 */
export function isLocalEmbedderAvailable(): boolean {
  return process.env.B4M_SELF_HOST === 'true' && !!process.env.OLLAMA_BASE_URL?.trim();
}

export interface ResolveToolAvailabilityOptions {
  /**
   * What a FAILED sub-lookup (e.g. an admin-settings read throwing) means for the one tool it
   * feeds: 'available' never hides a tool because a lookup glitched (the Tools-picker UI's fail
   * open); 'unavailable' never offers a schema this function couldn't confirm works (the
   * enforcement filter's fail closed). Only the tool(s) fed by the failed lookup are affected -
   * every other tool resolves normally. Defaults to 'available'.
   */
  onLookupError?: 'available' | 'unavailable';
  logger?: Pick<Logger, 'warn'>;
}

type Taint = Partial<
  Record<
    | 'webSearchProvider'
    | 'openWeatherKey'
    | 'wolframKey'
    | 'fmpKey'
    | 'firecrawlConfig'
    | 'llmKeys'
    | 'imageKeys'
    | 'elevenLabsKey'
    | 'openAiKey',
    boolean
  >
>;

/**
 * Every tool id this module gates, for the outer-catch fallback below. Keep in sync with the
 * `return` in `resolveToolAvailability` - nothing enforces that automatically, so a tool added
 * there without a matching entry here silently keeps fail-open behavior on that one rare path.
 */
const GATED_TOOLS: readonly B4MLLMTools[] = [
  'web_search',
  'deep_research',
  'weather_info',
  'wolfram_alpha',
  'fmp_financial_data',
  'image_generation',
  'edit_image',
  'music_generation',
  'audio_generation',
  'search_knowledge_base',
];

/**
 * Resolves which key-gated tools are usable, mirroring the same key getters the tools themselves
 * use so a caller never disables a tool that would actually work (and vice versa). Only booleans
 * are returned - never the key values.
 *
 * Each of the 9 sub-lookups fails independently (Promise.allSettled): one throwing getter degrades
 * only the tool(s) it feeds, per `onLookupError` - unlike the single try/catch this replaced, where
 * any one lookup throwing defaulted EVERY tool to available. This function itself never rejects:
 * callers thread it through an existing Promise.all on a request's critical path.
 *
 * LOCK-STEP: every tool id here that also has its own Tools-picker row must have a matching
 * entry in `MISSING_KEY_TOOLTIPS` in `apps/client/app/components/Session/AISettings/ToolsSection.tsx`,
 * which supplies the user-facing "why it's disabled" text. `edit_image` is exempt - it is a
 * companion of `image_generation` (see `addPairedTool` in ChatCompletionProcess.ts) with no
 * picker row of its own, so nothing ever calls `isToolKeyMissing('edit_image', ...)`.
 */
export async function resolveToolAvailability(
  userId: string | undefined,
  adapters: { db: GetEffectiveLLMApiKeysAdapters['db'] },
  options: ResolveToolAvailabilityOptions = {}
): Promise<ToolAvailability> {
  const { onLookupError = 'available', logger } = options;

  try {
    const dbAdapters = { db: adapters.db, getSettingsByNames };
    const taint: Taint = {};

    const settled = <T>(result: PromiseSettledResult<T>, fallback: T, key: keyof Taint): T => {
      if (result.status === 'fulfilled') return result.value;
      taint[key] = true;
      logger?.warn(`resolveToolAvailability: ${key} lookup failed, degrading dependent tool(s)`, result.reason);
      return fallback;
    };

    // The image tool resolves its key via getEffectiveApiKey (user key -> admin demo
    // key, NO self-host env fallback), so image availability must use the same path -
    // getEffectiveLLMApiKeys would add an env fallback the tool never sees.
    const imageProviders = [ApiKeyType.bfl, ApiKeyType.openai, ApiKeyType.gemini, ApiKeyType.xai];

    const results = await Promise.allSettled([
      // web_search resolves to SerpAPI or a local SearXNG instance; mirror the tool's own resolver
      // so a caller never disables a working provider (and vice versa).
      resolveWebSearchProvider(dbAdapters),
      getOpenWeatherKey(dbAdapters),
      getWolframAlphaKey(dbAdapters),
      getFmpApiKey(dbAdapters),
      // Deep Research uses Firecrawl (key OR self-hosted URL) - mirror the tool's own resolver.
      getFirecrawlConfig(dbAdapters),
      // Embedding keys (for Knowledge Base) resolve per user; KB uses this same getter,
      // so matching its self-host env fallback here is correct.
      userId ? getEffectiveLLMApiKeys(userId, dbAdapters) : Promise.resolve(null),
      userId
        ? Promise.all(imageProviders.map(type => getEffectiveApiKey(userId, { type }, dbAdapters)))
        : Promise.resolve<(string | undefined)[]>([]),
      // music_generation resolves its ElevenLabs key via the same getEffectiveApiKey
      // path (user key -> admin demo key), so availability must mirror it.
      userId
        ? getEffectiveApiKey(userId, { type: ApiKeyType.elevenlabs }, dbAdapters)
        : Promise.resolve<string | undefined>(undefined),
      // audio_generation speech can use OpenAI TTS; resolve its key via the same
      // getEffectiveApiKey path the tool uses (user key -> admin demo key).
      userId
        ? getEffectiveApiKey(userId, { type: ApiKeyType.openai }, dbAdapters)
        : Promise.resolve<string | undefined>(undefined),
    ]);

    const webSearchProvider = settled(results[0], null, 'webSearchProvider');
    const openWeatherKey = settled(results[1], undefined, 'openWeatherKey');
    const wolframKey = settled(results[2], undefined, 'wolframKey');
    const fmpKey = settled(results[3], undefined, 'fmpKey');
    const firecrawlConfig = settled(results[4], { apiKey: undefined, apiUrl: undefined }, 'firecrawlConfig');
    const llmKeys = settled(results[5], null, 'llmKeys');
    const imageKeys = settled(results[6], [], 'imageKeys');
    const elevenLabsKey = settled(results[7], undefined, 'elevenLabsKey');
    const openAiKey = settled(results[8], undefined, 'openAiKey');

    // getEffectiveLLMApiKeys returns the sentinel 'expired' (truthy) for an expired
    // user key, which the tool then rejects - treat it as absent so we don't report
    // a tool as available when it would actually fail.
    const usable = (key: string | null | undefined) => !!key && key !== 'expired';

    const hasFirecrawl = !!(firecrawlConfig.apiKey || firecrawlConfig.apiUrl);
    const hasImageKey = imageKeys.some(usable);
    // edit_image supports fewer providers than image_generation (bfl/gemini/openai - no xAI, per
    // imageEdit/index.ts) and has no self-hosted local-backend path, so it needs its own check
    // rather than reusing image_generation's: a user with only an xAI key would otherwise read as
    // edit_image-available and hit a tool that has no branch for that provider at all.
    const hasEditImageKey = imageKeys.slice(0, 3).some(usable); // [bfl, openai, gemini] of imageProviders
    // Knowledge Base semantic search needs an embeddings provider key (VoyageAI/OpenAI).
    // Note: this checks "any embeddings key present", not the admin's `defaultEmbeddingModel`
    // provider specifically. If the admin selects a Voyage model but only an OpenAI key is set
    // (or vice versa), the tool still shows as available and the semantic path falls back to
    // keyword search - deliberately lenient, since we'd rather under-gate KB than hide a tool
    // that still returns keyword results.
    // A placeholder/dummy key is not a working key: reject it here so this stays in lock-step
    // with embedding.ts defaultEmbeddingModelForEnv (which treats a placeholder as no cloud key
    // and falls back to the local Ollama embedder) - otherwise KB would report a working cloud
    // embedder that the vectorizer can't actually use.
    const hasRealEmbeddingKey = (key: string | null | undefined) => usable(key) && !isPlaceholderApiKey(key);
    const hasEmbeddingKey = hasRealEmbeddingKey(llmKeys?.openai) || hasRealEmbeddingKey(llmKeys?.voyageai);

    // Under the 'available' policy, a tool computed false SOLELY because one of its own inputs
    // failed to resolve reports available instead - a lookup glitch never hides a working tool.
    // A tool with no tainted input, or already true, is returned as computed either way.
    const maybeFailOpen = (computed: boolean, tainted: boolean | undefined): boolean =>
      onLookupError === 'available' && tainted ? true : computed;

    return {
      web_search: maybeFailOpen(!!webSearchProvider, taint.webSearchProvider),
      // Deep Research works with Firecrawl (key or self-hosted URL) OR a web-search provider
      // (SerpAPI/SearXNG) - the latter drives search with plain-fetch extraction.
      deep_research: maybeFailOpen(
        hasFirecrawl || !!webSearchProvider,
        taint.firecrawlConfig || taint.webSearchProvider
      ),
      weather_info: maybeFailOpen(!!openWeatherKey, taint.openWeatherKey),
      wolfram_alpha: maybeFailOpen(!!wolframKey, taint.wolframKey),
      fmp_financial_data: maybeFailOpen(!!fmpKey, taint.fmpKey),
      // Available with a provider key OR a self-hosted local image backend (which needs none).
      image_generation: maybeFailOpen(hasImageKey || isLocalImageBackendAvailable(), taint.imageKeys),
      // No xAI, no local-backend path - see hasEditImageKey's comment above.
      edit_image: maybeFailOpen(hasEditImageKey, taint.imageKeys),
      // Background-music generation needs an ElevenLabs key (user or admin demo key).
      music_generation: maybeFailOpen(usable(elevenLabsKey), taint.elevenLabsKey),
      // audio_generation: speech works with OpenAI OR ElevenLabs; sound effects need
      // ElevenLabs. Available when either provider key resolves.
      audio_generation: maybeFailOpen(
        usable(openAiKey) || usable(elevenLabsKey),
        taint.openAiKey || taint.elevenLabsKey
      ),
      // Only search_knowledge_base needs an embeddings key; retrieve_knowledge_content
      // is a direct file/keyword lookup that needs no external key, so it isn't gated.
      // Available with a cloud embeddings key OR a self-hosted local Ollama embedder (keyless).
      search_knowledge_base: maybeFailOpen(hasEmbeddingKey || isLocalEmbedderAvailable(), taint.llmKeys),
    };
  } catch (err) {
    // Last-resort safety net for anything outside the per-lookup Promise.allSettled above (this
    // function must never reject - see the doc comment). Honors onLookupError like every
    // individual lookup does: fails open under the UI's default policy (an empty map reads as
    // "every tool unconditional" downstream), fails closed under the enforcement policy (every
    // known gated tool explicit false) rather than silently reverting a 'unavailable' caller to
    // fail-open on this one unexpected path.
    logger?.warn(`resolveToolAvailability: unexpected error, defaulting to ${onLookupError}`, err);
    if (onLookupError === 'unavailable') {
      return Object.fromEntries(GATED_TOOLS.map(tool => [tool, false])) as ToolAvailability;
    }
    return {};
  }
}

/** search_knowledge_base degrades to keyword search rather than failing, so it is always offered
 * regardless of `availability` - this is the ENFORCEMENT-only carve-out; the Tools-picker UI must
 * keep seeing the honest (possibly false) value from `resolveToolAvailability`. */
const ALWAYS_OFFERABLE = new Set<B4MLLMTools>(['search_knowledge_base']);

/**
 * Whether a tool's schema should be offered to the model, given the availability map from
 * `resolveToolAvailability`. A tool absent from the map is unconditional (matches
 * `ToolAvailability`'s own doc comment). Use this ONLY to decide what reaches the model - never to
 * decide what the Tools-picker UI shows (that reads `availability` directly).
 */
export function isToolOfferable(tool: string, availability: ToolAvailability | undefined): boolean {
  if (ALWAYS_OFFERABLE.has(tool as B4MLLMTools)) return true;
  if (!availability) return true;
  return availability[tool as B4MLLMTools] !== false;
}

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import {
  apiKeyService,
  resolveToolAvailability,
  isLocalImageBackendAvailable,
  isLocalEmbedderAvailable,
  type ToolAvailability,
} from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import { resolveEffectiveEmbeddingModel } from '@server/embeddings/effectiveEmbeddingModel';
import { apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { Resource } from 'sst';

export { isLocalImageBackendAvailable, isLocalEmbedderAvailable, type ToolAvailability };

type LLMApiKeyTable = Awaited<ReturnType<typeof apiKeyService.getEffectiveLLMApiKeys>>;

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
  /**
   * The embedding model this deployment will ACTUALLY embed with, which is not always the one
   * `defaultEmbeddingModel` advertises: a stage holding no credential for the configured model falls
   * back to the keyless Bedrock embedder and stamps its corpus with that instead.
   *
   * Served from here rather than from `/api/settings/fetch` on purpose. That route is the admin
   * settings surface and must keep returning the admin's OWN configured value - overwriting the
   * entry would show the substituted model as the configured one in the settings dropdown and write
   * it back on the next save. This is a resolved capability, like `toolAvailability` beside it.
   *
   * Empty string when it cannot be resolved (unreadable setting, unsupported value, no credential
   * and nothing to fall back to). Clients must treat that as "unknown" and not as a model name.
   */
  effectiveEmbeddingModel: string;
};

// Get Admin Settings - requires authentication
// Public pre-login fields (apiUrl, defaultTheme) are served by /api/settings/serverConfigPublic
const handler = baseApi({ auth: true }).get(
  asyncHandler(async (req, res) => {
    // One key-table lookup, shared. Both computations below need the caller's effective LLM keys,
    // and this route is hit on every page load - resolving it twice was a second
    // `findByUserIdAndTypes` per request for an identical answer.
    //
    // `undefined` on failure, NOT null, and that distinction is the whole point. An injected table
    // is read as an authoritative answer about this caller's credentials, so injecting the failure
    // hands both consumers a confident "this caller holds no keys": the embedding model would
    // resolve a keyless Bedrock SUBSTITUTION and report Titan on a fully keyed stage, and
    // `resolveToolAvailability` would hide every key-gated tool - an injected value cannot be
    // tainted, so its documented fail-OPEN silently becomes fail-closed. `undefined` means "not
    // injected", which is the only honest thing a failed lookup can say: each consumer then falls
    // back to its own lookup and degrades exactly as it does for every other caller. The retry
    // costs a query on a path that is already failing, which is the cheaper half of the trade.
    const llmKeys = await apiKeyService
      .getEffectiveLLMApiKeys(req.user?.id ?? null, {
        db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
        getSettingsByNames,
      })
      .catch(() => undefined);
    const [toolAvailability, effectiveEmbeddingModel] = await Promise.all([
      computeToolAvailability(req.user?.id, llmKeys),
      computeEffectiveEmbeddingModel(req.user?.id, llmKeys),
    ]);

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
      effectiveEmbeddingModel,
    };

    return res.json(config);
  })
);

/**
 * Resolves which key-gated tools are usable, for the Tools picker UI. Thin wrapper around
 * `resolveToolAvailability` (moved to b4m-core/services so the model-facing tool-schema filter in
 * `sharedToolBuilder.ts` can use the same resolver, not just this UI hint) - the default
 * fail-open policy (a lookup error never hides a working tool) is what this UI wrapper wants;
 * the enforcement filter opts into fail-closed instead.
 *
 * LOCK-STEP: the tool ids returned here must have a matching entry in
 * `MISSING_KEY_TOOLTIPS` in `apps/client/app/components/Session/AISettings/ToolsSection.tsx`,
 * which supplies the user-facing "why it's disabled" text.
 */
export async function computeToolAvailability(
  userId: string | undefined,
  /** Only a REAL table, never a failed lookup - see the note at the call site. */
  llmKeys?: LLMApiKeyTable
): Promise<ToolAvailability> {
  return resolveToolAvailability(
    userId,
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } },
    // `llmKeys` is the resolver's own injection point, added so a caller holding the table can
    // share it; omitted, it resolves its own. `== null` so a nullish value from an untyped caller
    // is omitted rather than injected as an empty table, which would turn the resolver's documented
    // fail-OPEN into fail-closed.
    llmKeys == null ? {} : { llmKeys }
  );
}

/**
 * The embedding model this deployment will really embed with - the configured `defaultEmbeddingModel`
 * put through the SAME credential-table seam the ingest and search paths resolve at
 * (`resolveEmbeddingWithKeylessFallback`), so the client compares a file's recorded label against the
 * space the corpus actually occupies.
 *
 * Resolving in the browser is not an option, and that is the whole reason this field exists: an SST
 * secret reaches a hosted stage as a linked Resource rather than a `process.env` value, the key that
 * settles it lives in Mongo, and `settingsMap` is bundled into the browser where every env read is
 * undefined. The client cannot see any of the three.
 *
 * Deliberately NOT served by overwriting the `defaultEmbeddingModel` entry on /api/settings/fetch:
 * that route backs the admin settings form, so a substituted value there would render as the
 * CONFIGURED one and be written back on the next save.
 *
 * '' is the wire form of "unknown" (see resolveEffectiveEmbeddingModel for the three situations it
 * covers). The client must read it as "suppress the comparison", never as a reason to fall back to
 * the advertised setting - that fallback is the bug this field exists to remove.
 */
export async function computeEffectiveEmbeddingModel(
  userId: string | undefined,
  /** Only a REAL table, never a failed lookup - see the note at the call site. */
  llmKeys?: LLMApiKeyTable
): Promise<string> {
  // `== null` for the same reason as computeToolAvailability above: a nullish table is a failed
  // lookup, and injecting it would be read as "this caller is keyless" and answer with a keyless
  // substitution instead of unknown.
  return (await resolveEffectiveEmbeddingModel(userId, llmKeys == null ? {} : { llmKeys })) ?? '';
}

export const config = {
  api: {
    externalResolver: true,
  },
  bind: ['websocketApi'],
};

export default handler;

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import {
  resolveToolAvailability,
  isLocalImageBackendAvailable,
  isLocalEmbedderAvailable,
  type ToolAvailability,
} from '@bike4mind/services';
import { apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { Resource } from 'sst';

export { isLocalImageBackendAvailable, isLocalEmbedderAvailable, type ToolAvailability };

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
export async function computeToolAvailability(userId: string | undefined): Promise<ToolAvailability> {
  return resolveToolAvailability(userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
  });
}

export const config = {
  api: {
    externalResolver: true,
  },
  bind: ['websocketApi'],
};

export default handler;

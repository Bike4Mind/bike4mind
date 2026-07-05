import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';

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
};

// Get Admin Settings - requires authentication
// Public pre-login fields (apiUrl, defaultTheme) are served by /api/settings/serverConfigPublic
const handler = baseApi({ auth: true }).get(
  asyncHandler(async (req, res) => {
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
    };

    return res.json(config);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
  bind: ['websocketApi'],
};

export default handler;

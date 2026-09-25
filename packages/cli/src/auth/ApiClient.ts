import { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { ConfigStore } from '../storage/ConfigStore';
import { OAuthClient } from './OAuthClient';
import { logger } from '../utils/Logger';
import packageJson from '../../package.json';

export { SessionRevokedError } from '@bike4mind/client-auth';

const USER_AGENT = `b4m-cli/${packageJson.version}`;

/**
 * Per-request timeout. Generous by design: a waited chat (POST /api/chat with wait:true)
 * runs a full server-side quest, so the bound only exists to stop a hung backend from
 * wedging a caller forever, not to cap a normal long quest. Override with B4M_API_TIMEOUT_MS
 * (0 disables the timeout entirely).
 */
export const DEFAULT_API_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function resolveTimeoutMs(): number {
  const raw = process.env.B4M_API_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_API_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_API_TIMEOUT_MS;
}

/**
 * The shared authenticated client, wired to the CLI's storage, logger and branding.
 */
export class ApiClient extends AuthenticatedApiClient {
  /**
   * @param apiKey - When set, requests authenticate with this instance API key via
   *   the `x-api-key` header and the OAuth-JWT path (Bearer injection + refresh-on-401)
   *   is bypassed entirely. Omit to keep the default stored-JWT behavior unchanged.
   */
  constructor(baseURL: string = 'http://localhost:3000', configStore?: ConfigStore, apiKey?: string) {
    super({
      baseUrl: baseURL,
      tokenStore: configStore || new ConfigStore(),
      oauthClient: new OAuthClient(baseURL),
      logger,
      apiKey,
      timeoutMs: resolveTimeoutMs(),
      headers: {
        'User-Agent': USER_AGENT,
        'X-B4M-Client': USER_AGENT,
      },
      reauthMessages: {
        refreshFailed: 'Authentication expired. Please run `b4m login` again.',
        stillUnauthorized: 'Authentication failed. Please run /login to authenticate.',
      },
    });
  }
}

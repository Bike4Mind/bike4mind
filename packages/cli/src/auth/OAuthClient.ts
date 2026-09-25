import { DeviceFlowClient } from '@bike4mind/client-auth';

export type { DeviceFlowResponse, TokenResponse, RefreshTokenResponse, TokenError } from '@bike4mind/client-auth';

/** The CLI's RFC 8628 `client_id`; the desktop app registers under its own. */
export const CLI_OAUTH_CLIENT_ID = 'b4m-cli';

/**
 * The shared device-flow client, pinned to the CLI's registration.
 */
export class OAuthClient extends DeviceFlowClient {
  constructor(baseURL: string = 'http://localhost:3000') {
    super({ baseUrl: baseURL, clientId: CLI_OAUTH_CLIENT_ID });
  }
}

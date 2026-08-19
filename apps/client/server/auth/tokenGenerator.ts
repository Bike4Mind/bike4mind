import { AuthTokenGeneratorService } from '@bike4mind/auth';
import { Config } from '@server/utils/config';

/**
 * Access-token lifetime, in seconds. Exported because OAuth token responses must advertise the
 * REAL value in `expires_in`: clients (notably the CLI) compute their own expiry from it and use
 * that to decide when to refresh proactively, so an inflated number means they sit on a dead token
 * until a request fails. MUST STAY IN SYNC with accessTokenExpiresIn below.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 60;

export const authTokenGenerator = new AuthTokenGeneratorService({
  accessTokenSecret: Config.JWT_SECRET,
  refreshTokenSecret: Config.JWT_SECRET,
  // The access token is now held in JS memory only and re-obtained by silent refresh, so it can
  // be short-lived: an hour-scale TTL bounds what an XSS-exfiltrated token is worth, and it is
  // also the WebSocket's only credential (query-param auth), so it must not be so short that
  // long-lived connections churn through reconnects. Session length is bounded by the refresh
  // cookie's 30d lifetime (authSessionService DEFAULT_REFRESH_TTL_MS), not by this.
  accessTokenExpiresIn: '30m',
  refreshTokenExpiresIn: '30d',
});

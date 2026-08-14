import { AuthTokenGeneratorService } from '@bike4mind/auth';
import { Config } from '@server/utils/config';

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

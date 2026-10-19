import { requireUser } from '@server/middlewares/requireUser';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { redactUserSecretsForSelf } from '@bike4mind/common';
import { ExtractJwt } from 'passport-jwt';
import { respond } from '@server/utils/respond';
import { selfSessionResponseSchema } from '@server/auth/selfSessionResponseSchema';

// Per-user cap (req.user is set here, so rateLimit keys by user id, not IP). No legitimate
// flow calls identify anywhere near 60/min - it fires on cold load, tab refocus and WS
// reconnect probes - so this only bites a client stuck re-hitting it, bounding the Mongo cost
// of that spam. NOTE: this runs AFTER baseApi's auth, so it does NOT throttle a pure 401 loop
// (an invalid token is rejected before the handler chain); that class of flood is bounded by
// refreshToken's own per-IP rate limit and, when enabled, the edge WAF.
const IDENTIFY_RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 } as const;

// Same extractor as the jwt strategy (server/auth/auth.ts), so the echoed token is exactly the one
// that authenticated the request, whatever whitespace the header carries.
const extractBearerToken = ExtractJwt.fromAuthHeaderAsBearerToken();

/**
 * Read-only whoami. It never issues a session: it is reachable before the second factor (the
 * mfaPending allowlist in server/auth/auth.ts) and by API keys, and minting here would upgrade
 * either into a full browser session. Sessions come only from the login, second-factor and
 * refresh routes.
 */
const handler = baseApi()
  .use(rateLimit(IDENTIFY_RATE_LIMIT))
  .use(requireUser)
  .get(async (req, res) => {
    // An API-key caller gets no token back: echoing a bearer it also sent would hand a scoped or
    // publicly shipped key's holder the owner's session token.
    const isApiKeyCaller = !!req.apiKeyInfo;
    const accessToken = isApiKeyCaller ? undefined : (extractBearerToken(req) ?? undefined);
    req.logger.log(
      `Successful auth for "${req.user?.username}" (${req.user?.email}) via ${isApiKeyCaller ? 'api key' : 'jwt'}`
    );

    return respond(res, selfSessionResponseSchema, {
      // Same self-view shape as refreshToken and the login endpoints, which feed the
      // client's currentUser from this identical sanitizer. Raw `req.user` is the
      // hydrated document, so returning it shipped OAuth tokens, encrypted integration
      // credentials, login IP history and security-question answers to any bearer.
      user: redactUserSecretsForSelf(req.user),
      accessToken,
      // impersonatedBy is stamped onto req.user by verifyJwtPayload for an admin-driven
      // session; surfaced as a plain boolean because the client's only durable impersonation
      // signal is now the server (the old localStorage returnToken is gone).
      impersonating: !!(req.user as { impersonatedBy?: string } | undefined)?.impersonatedBy,
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

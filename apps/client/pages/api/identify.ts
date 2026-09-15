import { requireUser } from '@server/middlewares/requireUser';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { issueBrowserSession } from '@server/auth/issueSession';
import { isRotatedSecretWithinGraceWindow } from '@server/auth/secretRotationGrace';

// Per-user cap (req.user is set here, so rateLimit keys by user id, not IP). No legitimate
// flow calls identify anywhere near 60/min - it fires on cold load, tab refocus and WS
// reconnect probes - so this only bites a client stuck re-hitting it, bounding the Mongo cost
// of that spam. NOTE: this runs AFTER baseApi's auth, so it does NOT throttle a pure 401 loop
// (an invalid token is rejected before the handler chain); that class of flood is bounded by
// refreshToken's own per-IP rate limit and, when enabled, the edge WAF.
const IDENTIFY_RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 } as const;

const handler = baseApi()
  .use(rateLimit(IDENTIFY_RATE_LIMIT))
  .use(requireUser)
  .get(async (req, res) => {
    let accessToken: string | undefined = req.headers?.authorization?.split(' ')[1];
    req.logger.log(
      `Successful auth for "${req.user?.username}" (${req.user?.email}), ${
        accessToken ? 'have' : 'creating'
      } access token`
    );

    if (!accessToken) {
      ({ accessToken } = await issueBrowserSession(req, res, req.user!.id, {
        createdVia: 'identify',
        tokenVersion: req.user!.tokenVersion ?? 0,
      }));
    } else {
      const secretRotation = await secretRotationRepository.findByKeyName('JWT_SECRET');
      let previousSecret = undefined;
      // Accept the previous key only within the shared rotation grace window.
      if (isRotatedSecretWithinGraceWindow(secretRotation?.rotatedAt)) {
        previousSecret = secretRotation?.previousKey;
      }
      const decoded = authTokenGenerator.verifyToken(accessToken, previousSecret);
      if (decoded.exp && decoded.exp < Date.now() / 1000) {
        ({ accessToken } = await issueBrowserSession(req, res, req.user!.id, {
          createdVia: 'identify',
          tokenVersion: req.user!.tokenVersion ?? 0,
        }));
      }
    }

    return res.status(200).json({
      user: req.user,
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

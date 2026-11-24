/**
 * POST /api/auth/desktop-web-session
 *
 * Called by B4M Desktop's main process with its own session's Bearer JWT. Returns a single-use,
 * 60-second code that Desktop's web conversations window redeems at ./redeem for a web session,
 * so that window opens signed in instead of running the web sign-in inside an embedded browser.
 * jwtOnly: an API key must never trade itself for a session (sessionGrantRoutesRejectApiKeys.test.ts).
 */
import type { Request, Response } from 'express';
import type { OAuthDeviceClientId } from '@bike4mind/common';
import { authSessionRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { admitsOptionalAuthSession } from '@server/middlewares/oauthRouteGate';
import { DESKTOP_WEB_SESSION_CODE_TTL_SECONDS, mintDesktopWebSessionCode } from '@server/auth/desktopWebSession';

const DESKTOP_OAUTH_CLIENT_ID: OAuthDeviceClientId = 'b4m-desktop';

const handler = baseApi({ auth: 'jwtOnly', allowedMethods: ['POST'] })
  .use(rateLimit({ limit: 10, windowMs: 60 * 1000, bucket: 'desktop-web-session' }))
  .post(
    asyncHandler(async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const user = req.user;
      // The minted session skips the web sign-in's second factor, so only a full, first-party
      // session may ask: not an impersonation, a pre-MFA token, an OAuth relying-party token, a
      // deletion-pending account, or one that still owes MFA enrollment. A sid-less legacy token
      // cannot be checked for revocation at redemption, so it is refused too.
      if (!user?.sid || !(await admitsOptionalAuthSession(user))) {
        return res.status(403).json({ error: 'This session cannot open a web session.' });
      }
      // Only the Desktop client's own session may trade itself for a web session; a web, iOS or CLI
      // session has no reason to. Rotation keeps the sid, so the stamped clientId survives refresh.
      const parent = await authSessionRepository.findBySid(user.sid);
      if (parent?.clientId !== DESKTOP_OAUTH_CLIENT_ID) {
        return res.status(403).json({ error: 'This session cannot open a web session.' });
      }
      const code = await mintDesktopWebSessionCode({ userId: user.id, parentSid: user.sid });
      return res.status(200).json({ code, expiresInSeconds: DESKTOP_WEB_SESSION_CODE_TTL_SECONDS });
    })
  );

export const config = {
  api: { externalResolver: true },
};

export default handler;

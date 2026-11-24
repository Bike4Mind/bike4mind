/**
 * POST /api/auth/desktop-web-session/redeem  {code}
 *
 * The first navigation of B4M Desktop's "Server conversations" window: Desktop loads this URL as a
 * POST carrying a code from ./index.ts, so the code never appears in a URL, history or access log.
 * A valid code sets the HttpOnly refresh cookie for a new web session; the SPA then boots signed in
 * from that cookie (sessionBootstrap). Every outcome redirects to the notebooks page, so a spent or
 * expired code degrades to the ordinary sign-in screen instead of a raw error in the window.
 * auth: false: the code is the only credential (sessionGrantRoutesRejectApiKeys.test.ts).
 */
import { z } from 'zod';
import type { Request, Response } from 'express';
import { authSessionRepository, userRepository } from '@bike4mind/database';
import { authSessionService } from '@bike4mind/services';
import { accountBlockReasons } from '@bike4mind/services/userService/accountState';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { readRefreshCookie } from '@bike4mind/server-utils/auth/refreshCookie';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { issueBrowserSession } from '@server/auth/issueSession';
import { redeemDesktopWebSessionCode } from '@server/auth/desktopWebSession';

const RedeemBodySchema = z.strictObject({ code: z.string().min(1).max(64) });
const DESKTOP_WEB_SESSION_LANDING_PATH = '/notebooks';

/** True when this browser already holds a live web session for `userId`, so no new one is needed. */
async function hasLiveSessionFor(req: Request, userId: string): Promise<boolean> {
  const presented = readRefreshCookie(req);
  const sid = presented ? authSessionService.parseRefreshToken(presented)?.sid : undefined;
  if (!sid) return false;
  const session = await authSessionRepository.findBySid(sid);
  return !!session && session.userId === userId && !session.revokedAt && session.expiresAt > new Date();
}

const handler = baseApi({ auth: false, allowedMethods: ['POST'] })
  .use(rateLimit({ limit: 10, windowMs: 60 * 1000, bucket: 'desktop-web-session-redeem' }))
  .post(
    asyncHandler(async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      // Desktop's own navigation reports `none`. A page on another site must not be able to sign this
      // browser in to an account of its choosing (login CSRF), so any cross-site POST is refused.
      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite !== undefined && fetchSite !== 'none' && fetchSite !== 'same-origin') {
        return res.status(403).json({ error: 'Cross-site sign-in is not allowed' });
      }
      const land = () => res.redirect(303, DESKTOP_WEB_SESSION_LANDING_PATH);

      const parsed = RedeemBodySchema.safeParse(req.body);
      if (!parsed.success) return land();
      const redeemed = await redeemDesktopWebSessionCode(parsed.data.code);
      if (!redeemed) {
        req.logger.warn('desktop-web-session: code rejected');
        return land();
      }
      // The window keeps its storage between opens, so reuse a still-live session for the same user
      // rather than piling up a new one on every open.
      if (await hasLiveSessionFor(req, redeemed.userId)) return land();

      const user = await userRepository.findById(redeemed.userId);
      if (!user || user.isSystem || accountBlockReasons(user).length > 0) {
        req.logger.warn('desktop-web-session: account cannot sign in', { userId: redeemed.userId });
        return land();
      }
      await issueBrowserSession(req, res, user.id, {
        createdVia: 'desktop-handoff',
        tokenVersion: user.tokenVersion ?? 0,
      });
      return land();
    })
  );

export const config = {
  api: { externalResolver: true },
};

export default handler;

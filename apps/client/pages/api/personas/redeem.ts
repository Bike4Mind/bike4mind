/**
 * Redeems a single-use persona login code from POST /api/v1/personas for a session.
 *   GET  ?code=  browser sign-in: sets the HttpOnly refresh cookie and redirects to the app.
 *   POST {code}  headless bots: returns an access and refresh token pair.
 * The code is the only credential, so the route is auth: false and refuses API keys by having no
 * auth at all. A code is 256 random bits, stored only as a hash, lives 5 minutes, and is consumed
 * atomically, so a replay or a race gets one session at most.
 */
import { z } from 'zod';
import type { Request, Response } from 'express';
import { authSessionService } from '@bike4mind/services';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { readAdminReturnCookie, readRefreshCookie } from '@bike4mind/server-utils/auth/refreshCookie';
import { PERSONA_ENDPOINT_OFF_CODE } from '@bike4mind/common';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { issueBrowserSession, issueSessionForRequest } from '@server/auth/issueSession';
import { ACCESS_TOKEN_TTL_SECONDS } from '@server/auth/tokenGenerator';
import { loadPersonaSettings, redeemPersonaLoginCode } from '@server/personas/personaAccounts';

const RedeemBodySchema = z.strictObject({ code: z.string().max(64) });
const INVALID_CODE = 'Login code is invalid, expired or already used';

const sessionParams = (persona: { tokenVersion?: number; personaExpiresAt?: Date | null }, now: Date) => ({
  createdVia: 'persona-mint' as const,
  tokenVersion: persona.tokenVersion ?? 0,
  refreshTtlMs: Math.min(
    authSessionService.PERSONA_SESSION_IDLE_TTL_MS,
    new Date(persona.personaExpiresAt ?? now).getTime() - now.getTime()
  ),
});

const loginClient = (req: Request) => ({
  userAgent: String(req.headers['user-agent'] || 'Unknown').slice(0, 512),
  ip: getClientIp(req),
});

const noStore = (res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
};

const handler = baseApi({ auth: false })
  .use(rateLimit({ limit: 10, windowMs: 60 * 1000, bucket: 'personas-redeem' }))
  .get(
    asyncHandler(async (req: Request, res: Response) => {
      noStore(res);
      if (!(await loadPersonaSettings(req.logger)).enabled) {
        return res.status(404).json({ error: 'Not found', errorCode: PERSONA_ENDPOINT_OFF_CODE });
      }
      // Checked before the code is spent: replacing a signed-in browser's session with a persona's
      // is how a forwarded link would swap someone into a test account, or drop an impersonation.
      if (readRefreshCookie(req) || readAdminReturnCookie(req)) {
        return res.status(409).json({ error: 'This browser is already signed in. Sign out or use a private window.' });
      }
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const now = new Date();
      const persona = await redeemPersonaLoginCode(code, now, loginClient(req));
      if (!persona) return res.status(400).json({ error: INVALID_CODE });
      await issueBrowserSession(req, res, persona.id, sessionParams(persona, now));
      return res.redirect(303, '/');
    })
  )
  .post(
    asyncHandler(async (req: Request, res: Response) => {
      noStore(res);
      if (!(await loadPersonaSettings(req.logger)).enabled) {
        return res.status(404).json({ error: 'Not found', errorCode: PERSONA_ENDPOINT_OFF_CODE });
      }
      const parsed = RedeemBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: INVALID_CODE });
      const now = new Date();
      const persona = await redeemPersonaLoginCode(parsed.data.code, now, loginClient(req));
      if (!persona) return res.status(400).json({ error: INVALID_CODE });
      const { accessToken, refreshToken } = await issueSessionForRequest(req, persona.id, sessionParams(persona, now));
      return res.status(200).json({
        user: { id: persona.id, username: persona.username, email: persona.email, isPersona: true },
        accessToken,
        accessTokenExpiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
        refreshToken,
      });
    })
  );

export const config = {
  api: { externalResolver: true },
};

export default handler;

/**
 * POST /api/oauth/end-session
 *
 * Server half of OIDC RP-Initiated Logout 1.0 (discovery's end_session_endpoint is the
 * /oauth/logout SPA page, which calls this). Validates the client (client_id, else the
 * id_token_hint's audience), the post_logout_redirect_uri and the id_token_hint, then either asks
 * for confirmation or signs this browser out, and returns the only redirect target the page may
 * follow.
 *
 * auth: false because a browser with no Bike4Mind session must still be sent back to the RP. The
 * page forwards its Bearer token when it has one; a missing or invalid token reads as "already
 * signed out", which changes nothing server-side. A cross-site caller cannot present the Bearer,
 * so it can never end a session here.
 */

import type { Request, Response } from 'express';
import passport from 'passport';
import { z } from 'zod';
import { oauthClientRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { baseApi } from '@server/middlewares/baseApi';
import { verifyIdTokenHint } from '@server/auth/oauthServer';
import { logOAuthError } from '@server/auth/oauthErrorLog';
import { signOutBrowserSession } from '@server/auth/signOutBrowserSession';

const RequestSchema = z.object({
  client_id: z.string().min(1).max(256).optional(),
  post_logout_redirect_uri: z.string().max(2048).optional(),
  state: z.string().max(2048).optional(),
  id_token_hint: z.string().max(8192).optional(),
  // The user clicked "Sign out" on the confirmation screen.
  confirm: z.boolean().optional(),
});

/** The browser's own session, or null. A relying-party OAuth token is never treated as one. */
async function resolveBrowserSession(req: Request, res: Response): Promise<Express.User | null> {
  if (!req.headers.authorization?.startsWith('Bearer ')) return null;
  const user = await new Promise<Express.User | false>(resolve => {
    passport.authenticate('jwt', { session: false }, (err: Error | null, verified: Express.User | false) => {
      if (err) req.logger?.warn(`[oauth/end-session] JWT verify error (treated as signed out): ${err.message}`);
      resolve(verified);
    })(req, res, () => resolve(false));
  });
  return user && !(user as { oauthGrant?: unknown }).oauthGrant ? user : null;
}

const handler = baseApi({ auth: false, allowedMethods: ['POST'] })
  .use(rateLimit({ limit: 30, windowMs: 60 * 1000, bucket: 'oauth-end-session' }))
  .post(async (req, res) => {
    const reject = (error: string, error_description: string) => {
      logOAuthError(req.logger, { route: 'oauth/end-session', clientId: req.body?.client_id, error, status: 400 });
      return res.status(400).json({ error, error_description });
    };

    const parsed = RequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reject('invalid_request', `${parsed.error.issues[0].path.join('.') || 'body'} is invalid`);
    }
    const { client_id, post_logout_redirect_uri, state, id_token_hint, confirm } = parsed.data;

    const hint = id_token_hint !== undefined ? await verifyIdTokenHint(id_token_hint, client_id) : undefined;
    if (hint === null) return reject('invalid_request', 'id_token_hint is invalid');
    const clientId = hint?.clientId ?? client_id;
    if (clientId === undefined) return reject('invalid_request', 'client_id or id_token_hint is required');

    const client = await oauthClientRepository.findByClientId(clientId);
    if (!client) return reject('invalid_client', 'Unknown client');

    if (post_logout_redirect_uri !== undefined && !client.postLogoutRedirectUris.includes(post_logout_redirect_uri)) {
      return reject('invalid_request', 'post_logout_redirect_uri is not registered for this client');
    }

    let redirectTo: string | null = null;
    if (post_logout_redirect_uri !== undefined) {
      const url = new URL(post_logout_redirect_uri);
      if (state !== undefined) url.searchParams.set('state', state);
      redirectTo = url.toString();
    }

    const user = await resolveBrowserSession(req, res);
    if (!user) return res.status(200).json({ status: 'signed_out', redirect_to: redirectTo });

    // Without a hint naming this user, a link from any site could sign them out silently.
    if (confirm !== true && hint?.sub !== user.id) {
      return res
        .status(200)
        .json({ status: 'confirmation_required', client_name: client.name, redirect_to: redirectTo });
    }

    req.user = user;
    await signOutBrowserSession(req, res, { clientId: client.clientId });
    return res.status(200).json({ status: 'signed_out', redirect_to: redirectTo });
  });

export const config = { api: { externalResolver: true } };
export default handler;

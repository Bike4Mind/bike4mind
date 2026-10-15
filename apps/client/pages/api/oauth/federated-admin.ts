/**
 * POST /api/oauth/federated-admin
 *
 * Tells a federated app's *server* whether its signed-in user is a B4M admin
 * (`User.isAdmin`), so the app can admit B4M admins to its own ops console
 * without keeping a separate admin list. Same client auth and ID-token trust as
 * /api/oauth/ai-token (see that file and server/auth/verifyFederatedIdToken.ts),
 * but nothing is minted and nothing is released beyond the boolean, so there is
 * no scope, grant or consent gate.
 *
 * Response: 200 { is_admin: boolean }. A subject that resolves to no B4M user,
 * or to a blocked (banned, suspended, disputed) account, is simply not an admin.
 */

import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { cacheRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { oauthClientRepository, userRepository } from '@bike4mind/database/auth';
import { verifyFederatedIdToken, FederatedIdTokenError } from '@server/auth/verifyFederatedIdToken';

/** Per-`client_id` budget. A federated app caches the answer per user for minutes. */
const PER_CLIENT_RATE_LIMIT = 300;
const RATE_WINDOW_MS = 60_000;

const FederatedAdminRequestSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  /** The federated app's ID token for its logged-in user (Cognito- or B4M-issued). */
  id_token: z.string().min(1),
});

const handler = baseApi({ auth: false })
  // Coarse per-IP flood backstop; bounds the bcrypt work in verifyClientSecret.
  .use(rateLimit({ limit: PER_CLIENT_RATE_LIMIT, windowMs: RATE_WINDOW_MS, bucket: 'oauth-federated-admin' }))
  .post(async (req, res) => {
    const parsed = FederatedAdminRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', error_description: parsed.error.message });
    }

    const { client_id, client_secret, id_token } = parsed.data;

    // 1. Client auth.
    const client = await oauthClientRepository.verifyClientSecret(client_id, client_secret);
    if (!client) {
      return res
        .status(401)
        .json({ error: 'invalid_client', error_description: 'Unknown client or invalid client_secret' });
    }

    // 2. Federation gate - only clients with a federated trust config can present ID tokens.
    const federatedIdp = client.federatedIdp;
    if (!federatedIdp) {
      return res.status(403).json({
        error: 'access_denied',
        error_description: 'Client is not configured for federated identity',
      });
    }

    // 3. Per-client_id rate limit, after client auth so failed-secret probes can't burn it.
    const rl = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      `rate-limit:oauth-federated-admin:${client_id}`,
      PER_CLIENT_RATE_LIMIT,
      RATE_WINDOW_MS
    );
    if (!rl.success) {
      const retryAfter = Math.max(1, Math.ceil((rl.expiresAt.getTime() - Date.now()) / 1000));
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: 'temporarily_unavailable',
        error_description: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
      });
    }

    // 4. Verify the ID token against the client's configured JWKS and resolve the B4M user id.
    let b4mUserId: string;
    try {
      ({ b4mUserId } = await verifyFederatedIdToken(id_token, federatedIdp));
    } catch (err) {
      if (err instanceof FederatedIdTokenError) {
        req.logger.warn(`[OAUTH_FEDERATED_ADMIN] ID token rejected for client ${client_id}: ${err.message}`);
        return res.status(401).json({ error: 'invalid_grant', error_description: 'Invalid ID token' });
      }
      throw err;
    }
    if (federatedIdp.subjectSource !== 'sub') {
      req.logger.warn(
        `[OAUTH_FEDERATED_ADMIN] client ${client_id} resolves the user from the self-asserted 'identities' claim`
      );
    }

    // 5. A subject that resolves to no B4M user, or to a blocked account, is not an admin.
    const user = await userRepository.findById(b4mUserId);
    const isAdmin = user?.isAdmin === true && userService.accountBlockReasons(user).length === 0;
    if (isAdmin) {
      req.logger.info(`[OAUTH_FEDERATED_ADMIN] user ${b4mUserId} confirmed admin for client ${client_id}`);
    }
    return res.status(200).json({ is_admin: isAdmin });
  });

export const config = { api: { externalResolver: true } };
export default handler;

/**
 * POST /api/oauth/ai-token
 *
 * Federated AI-token exchange for Pattern-A ("user-pays") apps. A federated
 * app's Cognito pool federates B4M as its upstream IdP; the app's *server*
 * calls this endpoint with its OAuth `client_secret` and the logged-in user's
 * Cognito ID token, and receives a short-lived, revocable `ai:generate` key
 * scoped to that user. The app then sends the key as `X-API-Key` to
 * `/api/ai/v1/completions`, so completions bill the resolved user's B4M credits
 * with no manual API-key paste.
 *
 * This is the only surface that mints an API key *outside* the consent-gated
 * REST path, so it enforces the consent gate itself (step 5) - see the
 * invariant note in server/cli/auth.ts. Omitting that check would let a
 * non-consented federated user drive provider spend.
 */

import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { cacheRepository, organizationRepository } from '@bike4mind/database';
import {
  oauthClientRepository,
  userApiKeyRepository,
  userRepository,
  UserApiKeyAuditLog,
} from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
import { ApiKeyScope, ApiKeyStatus } from '@bike4mind/common';
import { hasAcceptedPolicy } from '@server/auth/consentGate';
import { verifyCognitoIdToken, CognitoIdTokenError } from '@server/auth/verifyCognitoIdToken';

/** Minted key lifetime. The app caches the key per-user and re-exchanges only when it expires. */
const AI_TOKEN_TTL_SECONDS = 15 * 60; // 900s

/** Per-`client_id` mint budget. A federated app calls ~once per user per TTL window. */
const PER_CLIENT_RATE_LIMIT = 300;
const RATE_WINDOW_MS = 60_000;

const AiTokenRequestSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  /** The federated app's Cognito ID token for its logged-in user. */
  id_token: z.string().min(1),
});

/**
 * Take the last hop from the X-Forwarded-For chain - the one CloudFront appends
 * and the client can't spoof, unlike earlier entries. `req.ip` on an unauth
 * endpoint behind a proxy is attacker-controllable and would poison audit logs.
 * (Same rationale as cc-bridge/redeem.)
 */
function trustedClientIp(req: {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const parts = xff
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress;
}

const handler = baseApi({ auth: false })
  // Coarse per-IP flood backstop for this unauth endpoint. A federated app calls
  // from one server IP, so this is a generous ceiling that also bounds how much
  // bcrypt (verifyClientSecret) a single source can drive. The precise per-client
  // control is the in-handler check below.
  .use(rateLimit({ limit: PER_CLIENT_RATE_LIMIT, windowMs: RATE_WINDOW_MS, bucket: 'oauth-ai-token' }))
  .post(async (req, res) => {
    const parsed = AiTokenRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', error_description: parsed.error.message });
    }

    const { client_id, client_secret, id_token } = parsed.data;

    // 1. Client auth - verify the secret directly. Unlike the code exchange we send
    //    no redirect_uri, so we skip validateClientSecret (which also demands one).
    const client = await oauthClientRepository.verifyClientSecret(client_id, client_secret);
    if (!client) {
      return res
        .status(401)
        .json({ error: 'invalid_client', error_description: 'Unknown client or invalid client_secret' });
    }

    // 2. Federation gate - only clients with a populated federated trust config may mint AI keys.
    const federatedIdp = client.federatedIdp;
    if (!federatedIdp) {
      return res.status(403).json({
        error: 'access_denied',
        error_description: 'Client is not configured for federated AI-token exchange',
      });
    }

    // 3. Per-client_id rate limit. Runs after client auth so failed-secret probes
    //    can't burn a legitimate client's budget.
    const rl = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      `rate-limit:oauth-ai-token:${client_id}`,
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

    // 4. Verify the Cognito ID token against the *client's* pool JWKS and resolve the B4M user id.
    let b4mUserId: string;
    try {
      ({ b4mUserId } = await verifyCognitoIdToken(id_token, federatedIdp));
    } catch (err) {
      if (err instanceof CognitoIdTokenError) {
        req.logger.warn(`[OAUTH_AI_TOKEN] Cognito token rejected for client ${client_id}: ${err.message}`);
        return res.status(401).json({ error: 'invalid_grant', error_description: 'Invalid Cognito ID token' });
      }
      throw err;
    }

    // 5. Load the user; a sub that resolves to no B4M user is an invalid grant.
    const user = await userRepository.findById(b4mUserId);
    if (!user) {
      return res
        .status(401)
        .json({ error: 'invalid_grant', error_description: 'Token subject does not resolve to a B4M user' });
    }

    // 6. Consent gate (SECURITY-CRITICAL). This endpoint mints outside the gated REST
    //    surface, so it must enforce the AUP/ToS acceptance invariant itself.
    if (!hasAcceptedPolicy(user)) {
      return res.status(403).json({ error: 'access_denied', error_description: 'Policy acceptance required' });
    }

    const clientIp = trustedClientIp(req);
    const userAgent = req.headers['user-agent'];

    // 7. Reuse-or-replace: keep at most one active exchange key per (user, client). The raw
    //    key can't be re-read (only its hash is stored), so we revoke any prior one and mint
    //    fresh. Tagged via metadata.oauthClientId - NOT productId, which carries a global
    //    per-product active-key cap that would reject mints past 20 concurrent users.
    const existingKeys = await userApiKeyRepository.findByUserId(b4mUserId);
    const priorExchangeKeys = existingKeys.filter(
      k =>
        (k.status === ApiKeyStatus.ACTIVE || k.status === ApiKeyStatus.RATE_LIMITED) &&
        k.metadata?.createdFrom === 'oauth-exchange' &&
        k.metadata?.oauthClientId === client_id
    );
    for (const prior of priorExchangeKeys) {
      await userApiKeyService.revokeUserApiKey(
        b4mUserId,
        { keyId: prior.id, reason: 'Superseded by a new federated AI-token exchange' },
        { db: { userApiKeys: userApiKeyRepository, organizations: organizationRepository } }
      );
    }

    const minted = await userApiKeyService.createUserApiKey(
      b4mUserId,
      {
        name: `AI (federated: ${client.name})`,
        scopes: [ApiKeyScope.AI_GENERATE],
        expiresAt: new Date(Date.now() + AI_TOKEN_TTL_SECONDS * 1000),
        metadata: {
          clientIP: clientIp,
          userAgent,
          createdFrom: 'oauth-exchange',
          oauthClientId: client_id,
        },
      },
      { db: { userApiKeys: userApiKeyRepository } }
    );

    // 8. Audit - a single `mint` entry (createUserApiKey does not emit one).
    await UserApiKeyAuditLog.create({
      action: 'mint',
      keyId: minted.id,
      actorUserId: b4mUserId,
      actorIp: clientIp,
      actorUserAgent: userAgent,
      details: { clientId: client_id, flow: 'oauth-ai-token-exchange' },
    });

    req.logger.info(
      `[OAUTH_AI_TOKEN] Minted ai:generate key ${minted.id} for user ${b4mUserId} via client ${client_id}`
    );

    // 9. Respond with the raw key exactly once.
    return res.status(200).json({
      api_key: minted.key,
      token_type: 'ApiKey',
      expires_in: AI_TOKEN_TTL_SECONDS,
      scope: ApiKeyScope.AI_GENERATE,
    });
  });

export const config = { api: { externalResolver: true } };
export default handler;

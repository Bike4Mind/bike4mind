/**
 * POST /api/oauth/ai-token
 *
 * Federated AI-token exchange for Pattern-A ("user-pays") apps. The app's
 * *server* calls this endpoint with its OAuth `client_secret` and an ID token for
 * its logged-in user, and receives a short-lived, revocable `ai:generate` key
 * scoped to that user. The ID token is either one the app's own Cognito pool
 * issued (with B4M federated upstream) or one B4M issued directly, per the
 * client's registered `federatedIdp.subjectSource` (see
 * server/auth/verifyFederatedIdToken.ts). The app then sends the key
 * as `X-API-Key` to `/api/ai/v1/completions`, so completions bill the resolved
 * user's B4M credits with no manual API-key paste.
 *
 * This is the only surface that mints an API key *outside* the consent-gated
 * REST path, so it enforces the consent gate itself (step 5) - see the
 * invariant note in server/cli/auth.ts. Omitting that check would let a
 * non-consented federated user drive provider spend.
 */

import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import {
  agentRepository,
  cacheRepository,
  organizationRepository,
  realtimeConnectionRepository,
} from '@bike4mind/database';
import {
  oauthClientRepository,
  userApiKeyRepository,
  userRepository,
  UserApiKeyAuditLog,
} from '@bike4mind/database/auth';
import { userApiKeyService, API_KEY_USER_CAP_ERROR_CODE } from '@bike4mind/services';
import { ApiKeyScope, ApiKeyStatus, BadRequestError } from '@bike4mind/common';
import { hasAcceptedPolicy } from '@bike4mind/server-utils/auth/consentGate';
import { checkFederatedGrant } from '@server/auth/federatedGrantGate';
import { verifyFederatedIdToken, FederatedIdTokenError } from '@server/auth/verifyFederatedIdToken';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { logOAuthError } from '@server/auth/oauthErrorLog';
import {
  API_KEY_ACCESS_DENIED_MESSAGE,
  SUBSCRIPTION_REQUIRED_ERROR,
  isApiKeyAccessAllowed,
} from '@server/utils/apiKeyAccessGate';

/** Minted key lifetime. The app caches the key per-user and re-exchanges only when it expires. */
const AI_TOKEN_TTL_SECONDS = userApiKeyService.MAX_EXCHANGE_KEY_TTL_MS / 1000;

/** Per-`client_id` mint budget. A federated app calls ~once per user per TTL window. */
const PER_CLIENT_RATE_LIMIT = 300;
const RATE_WINDOW_MS = 60_000;

const AiTokenRequestSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  /** The federated app's ID token for its logged-in user (Cognito- or B4M-issued). */
  id_token: z.string().min(1),
  /**
   * Space-separated scopes to mint. Defaults to `ai:generate` when omitted (backward-compatible).
   * Every requested scope must appear in the client's registered `allowedScopes`. Scopes that
   * authorize spend (ai:generate) additionally require a durable OAuthGrant in enforce mode.
   */
  scope: z.string().trim().min(1).optional(),
});

// Keep this exchange limited to scopes whose mint and consent requirements it implements.
const AiTokenScopesSchema = z.array(z.enum([ApiKeyScope.AI_GENERATE, ApiKeyScope.ME_READ])).min(1);

const handler = baseApi({ auth: false })
  // Coarse per-IP flood backstop for this unauth endpoint. A federated app calls
  // from one server IP, so this is a generous ceiling that also bounds how much
  // bcrypt (verifyClientSecret) a single source can drive. The precise per-client
  // control is the in-handler check below.
  .use(rateLimit({ limit: PER_CLIENT_RATE_LIMIT, windowMs: RATE_WINDOW_MS, bucket: 'oauth-ai-token' }))
  .post(async (req, res) => {
    const logError = (error: string, status: number) =>
      logOAuthError(req.logger, { route: 'oauth/ai-token', clientId: req.body?.client_id, error, status });

    const parsed = AiTokenRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      logError('invalid_request', 400);
      return res.status(400).json({ error: 'invalid_request', error_description: parsed.error.message });
    }

    const { client_id, client_secret, id_token, scope } = parsed.data;

    // 1. Client auth - verify the secret directly. Unlike the code exchange we send
    //    no redirect_uri, so we skip validateClientSecret (which also demands one).
    const client = await oauthClientRepository.verifyClientSecret(client_id, client_secret);
    if (!client) {
      logError('invalid_client', 401);
      return res
        .status(401)
        .json({ error: 'invalid_client', error_description: 'Unknown client or invalid client_secret' });
    }

    // 2. Federation gate - only clients with a populated federated trust config may mint AI keys.
    const federatedIdp = client.federatedIdp;
    if (!federatedIdp) {
      logError('access_denied', 403);
      return res.status(403).json({
        error: 'access_denied',
        error_description: 'Client is not configured for federated AI-token exchange',
      });
    }

    const parsedScopes = AiTokenScopesSchema.safeParse([
      ...new Set((scope ?? ApiKeyScope.AI_GENERATE).split(' ').filter(Boolean)),
    ]);
    if (!parsedScopes.success) {
      logError('invalid_scope', 403);
      return res.status(403).json({
        error: 'invalid_scope',
        error_description: 'This exchange supports only ai:generate and me:read scopes',
      });
    }
    const requestedScopes = parsedScopes.data;

    // 2.5. Scope gate - every requested scope must appear in the client's registered allowedScopes.
    //      Mirrors code.ts (RFC 6749 4.1.2.1): a clear 403 is better than silently narrowing the
    //      grant to what the client may have. A client mis-registered without ai:generate in
    //      allowedScopes cannot escalate to a spend-authorizing key here.
    //
    //      Pre-deploy invariant: all production federated clients seeded before this gate was added
    //      include ai:generate in their allowedScopes (seed-oauth-client.ts has always done so for
    //      federated clients). Any client that does not will 403 on its next call. Verify with a
    //      one-time query before deploying to production if in doubt:
    //        db.oauthclients.find({ 'federatedIdp': { $exists: true }, allowedScopes: { $nin: ['ai:generate'] } })
    const disallowedScopes = requestedScopes.filter(s => !(client.allowedScopes ?? []).includes(s));
    if (disallowedScopes.length > 0) {
      logError('invalid_scope', 403);
      return res.status(403).json({
        error: 'invalid_scope',
        error_description: `Scopes not registered for this client: ${disallowedScopes.join(' ')}`,
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
      logError('temporarily_unavailable', 429);
      return res.status(429).json({
        error: 'temporarily_unavailable',
        error_description: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
      });
    }

    // 4. Verify the ID token against the *client's* configured JWKS and resolve the B4M
    //    user id. The verifier handles both trust shapes (external Cognito pool, or a
    //    token B4M issued itself); every gate above and below is identical either way.
    let b4mUserId: string;
    try {
      ({ b4mUserId } = await verifyFederatedIdToken(id_token, federatedIdp));
    } catch (err) {
      if (err instanceof FederatedIdTokenError) {
        req.logger.warn(`[OAUTH_AI_TOKEN] ID token rejected for client ${client_id}: ${err.message}`);
        logError('invalid_grant', 401);
        return res.status(401).json({ error: 'invalid_grant', error_description: 'Invalid ID token' });
      }
      throw err;
    }
    if (federatedIdp.subjectSource !== 'sub') {
      req.logger.warn(
        `[OAUTH_AI_TOKEN] would-reject: client ${client_id} uses the self-asserted ` +
          "'identities' subject source; set OAUTH_AI_TOKEN_REQUIRE_SUB=true to enforce subjectSource='sub'"
      );
    }

    // 5. Load the user; a sub that resolves to no B4M user is an invalid grant.
    const user = await userRepository.findById(b4mUserId);
    if (!user) {
      logError('invalid_grant', 401);
      return res
        .status(401)
        .json({ error: 'invalid_grant', error_description: 'Token subject does not resolve to a B4M user' });
    }

    // 5.5. Grant gate (SECURITY) - relying-party clients only; see federatedGrantGate.ts.
    const grantRejection = await checkFederatedGrant({
      client,
      clientId: client_id,
      userId: b4mUserId,
      scopes: requestedScopes,
      logger: req.logger,
      logTag: 'OAUTH_AI_TOKEN',
    });
    if (grantRejection) {
      const { status, ...body } = grantRejection;
      logError(body.error, status);
      return res.status(status).json(body);
    }

    // 6. Consent gate (SECURITY-CRITICAL). This endpoint mints outside the gated REST
    //    surface, so it must enforce the AUP/ToS acceptance invariant itself.
    if (!hasAcceptedPolicy(user)) {
      logError('access_denied', 403);
      return res.status(403).json({ error: 'access_denied', error_description: 'Policy acceptance required' });
    }

    // 6.5. The admin paid-only switch; the same gate re-runs on every use of the key.
    if (!(await isApiKeyAccessAllowed(user, undefined, req))) {
      logError(SUBSCRIPTION_REQUIRED_ERROR, 403);
      return res
        .status(403)
        .json({ error: SUBSCRIPTION_REQUIRED_ERROR, error_description: API_KEY_ACCESS_DENIED_MESSAGE });
    }

    const clientIp = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    // 7. Reuse-or-replace: keep at most one active exchange key per (user, client). The raw
    //    key can't be re-read (only its hash is stored), so we revoke any prior one and mint
    //    fresh. Tagged via metadata.oauthClientId - NOT productId, which carries a global
    //    per-product active-key cap that would reject mints past 20 concurrent users.
    //    createExchangeUserApiKey stamps createdFrom 'oauth-exchange', putting the key in its own
    //    per-user cap pool (ApiKeyCapPool), so live authorizations across many clients never
    //    consume the user's standard key slots.
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
        {
          db: {
            userApiKeys: userApiKeyRepository,
            organizations: organizationRepository,
            realtimeConnections: realtimeConnectionRepository,
          },
        }
      );
    }

    let minted: Awaited<ReturnType<typeof userApiKeyService.createExchangeUserApiKey>>;
    try {
      minted = await userApiKeyService.createExchangeUserApiKey(
        b4mUserId,
        {
          name: `AI (federated: ${client.name})`,
          scopes: requestedScopes,
          expiresAt: new Date(Date.now() + AI_TOKEN_TTL_SECONDS * 1000),
          metadata: {
            clientIP: clientIp,
            userAgent,
            oauthClientId: client_id,
          },
        },
        { db: { userApiKeys: userApiKeyRepository, agents: agentRepository } }
      );
    } catch (err) {
      // The per-user active-key cap is a client-visible refusal: answer it in OAuth
      // shape like every other gate above rather than letting baseApi render a bare
      // 400. Any other error is not ours to relabel - rethrow for the generic handler.
      if (err instanceof BadRequestError && err.additionalInfo?.errorCode === API_KEY_USER_CAP_ERROR_CODE) {
        req.logger.warn(
          `[OAUTH_AI_TOKEN] per-user active API key cap reached for user ${b4mUserId} via client ${client_id}`
        );
        logError('invalid_request', 400);
        return res.status(400).json({ error: 'invalid_request', error_description: err.message });
      }
      throw err;
    }

    // 8. Audit - a single `mint` entry (createExchangeUserApiKey does not emit one).
    await UserApiKeyAuditLog.create({
      action: 'mint',
      keyId: minted.id,
      actorUserId: b4mUserId,
      actorIp: clientIp,
      actorUserAgent: userAgent,
      details: { clientId: client_id, flow: 'oauth-ai-token-exchange' },
    });

    req.logger.info(
      `[OAUTH_AI_TOKEN] Minted key ${minted.id} for user ${b4mUserId} via client ${client_id} (scopes: ${requestedScopes.join(' ')})`
    );

    // 9. Respond with the raw key exactly once.
    return res.status(200).json({
      api_key: minted.key,
      token_type: 'ApiKey',
      expires_in: AI_TOKEN_TTL_SECONDS,
      scope: requestedScopes.join(' '),
    });
  });

export const config = { api: { externalResolver: true } };
export default handler;

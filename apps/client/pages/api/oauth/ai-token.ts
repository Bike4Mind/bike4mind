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
import { rateLimit } from '@server/middlewares/rateLimit';
import { agentRepository, cacheRepository, organizationRepository } from '@bike4mind/database';
import {
  oauthClientRepository,
  oauthGrantRepository,
  userApiKeyRepository,
  userRepository,
  UserApiKeyAuditLog,
} from '@bike4mind/database/auth';
import { userApiKeyService, API_KEY_USER_CAP_ERROR_CODE } from '@bike4mind/services';
import { ApiKeyScope, ApiKeyStatus, BadRequestError } from '@bike4mind/common';
import { hasAcceptedPolicy } from '@server/auth/consentGate';
import { verifyFederatedIdToken, FederatedIdTokenError } from '@server/auth/verifyFederatedIdToken';

/** Minted key lifetime. The app caches the key per-user and re-exchanges only when it expires. */
const AI_TOKEN_TTL_SECONDS = 15 * 60; // 900s

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

    const { client_id, client_secret, id_token, scope } = parsed.data;

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

    const parsedScopes = AiTokenScopesSchema.safeParse([
      ...new Set((scope ?? ApiKeyScope.AI_GENERATE).split(' ').filter(Boolean)),
    ]);
    if (!parsedScopes.success) {
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
      return res
        .status(401)
        .json({ error: 'invalid_grant', error_description: 'Token subject does not resolve to a B4M user' });
    }

    // 5.5. Grant gate (SECURITY) - relying-party clients only. Require the durable (user, client)
    //      authorization grant recorded by the authorize flow (code.ts), AND that the grant covers
    //      the billable scope. Closes two holes:
    //        (a) a pool-signed token - including a forged identities[] entry from a compromised pool
    //            - for a user who never authorized this client. The pool cannot forge a B4M grant.
    //        (b) a grant that covers only identity scopes (openid/email/profile) being treated as
    //            authorization for any minted scope. The grant must cover every scope this exchange
    //            mints - the user must have explicitly approved each one for this client.
    //      Reads the SAME OAuthGrant that token.ts enforces, per that model's contract.
    //
    //      Scoped to relying-party clients: a first-party / pre-existing federated client is trusted
    //      (B4M controls the pool) and never went through code.ts's consent flow, so it has no grant
    //      row and never will. Enforcing one on it would 403 every such integration the moment the
    //      lever flips - the gate exists to constrain UNTRUSTED relying-party pools, so first-party
    //      clients are exempt.
    //
    //      Defaults to GRACE (log-only): unlike the interactive token.ts flow (where the user
    //      consents moments earlier in the same round-trip), this server-to-server exchange may
    //      present a token minted before grants existed, so grace mode logs a would-reject instead of
    //      blocking while operators re-mint/re-authorize. It does NOT auto-heal - a grant is recorded
    //      only when the user actually authorizes this client. Flip enforcement per stage with
    //      OAUTH_AI_TOKEN_ENFORCE_GRANT=true; the lever is plumbed through infra (deploy-contract.json
    //      + infra/web.ts), per the API_KEY_SCOPE_STAGING precedent.
    if (client.clientType === 'relying-party') {
      const enforce = process.env.OAUTH_AI_TOKEN_ENFORCE_GRANT === 'true';
      let grant: Awaited<ReturnType<typeof oauthGrantRepository.findGrant>> | undefined;
      let lookupFailed = false;
      try {
        grant = await oauthGrantRepository.findGrant(b4mUserId, client_id);
      } catch (err) {
        lookupFailed = true;
        req.logger.warn(
          `[OAUTH_AI_TOKEN] grant lookup failed for user ${b4mUserId} via client ${client_id}: ${String(err)}`
        );
      }

      if (enforce) {
        // Fail closed: an unreadable grant is UNKNOWN, not absent. Minting anyway would defeat the
        // gate on exactly the transient error an attacker could induce. 503 so the caller retries.
        if (lookupFailed) {
          return res.status(503).json({
            error: 'temporarily_unavailable',
            error_description: 'Grant lookup failed; cannot verify authorization',
          });
        }
        if (!grant) {
          return res
            .status(403)
            .json({ error: 'access_denied', error_description: 'User has not authorized this client' });
        }
        // Every requested scope must be covered by the grant -- not just billable ones. Any scope
        // this exchange mints should be one the user explicitly consented to for this client.
        const uncovered = requestedScopes.filter(s => !(grant.scopes ?? []).includes(s));
        if (uncovered.length > 0) {
          return res.status(403).json({
            error: 'access_denied',
            error_description: `User has not authorized the following scope(s) for this client: ${uncovered.join(' ')}`,
          });
        }
      } else if (!lookupFailed) {
        // Grace: surface would-rejects so operators see what enforcement would block. (A lookup
        // failure is already logged above.)
        if (!grant) {
          req.logger.warn(
            `[OAUTH_AI_TOKEN] would-reject: no grant for user ${b4mUserId} via client ${client_id} ` +
              `(grace mode; set OAUTH_AI_TOKEN_ENFORCE_GRANT=true to enforce)`
          );
        } else {
          const uncovered = requestedScopes.filter(s => !(grant.scopes ?? []).includes(s));
          if (uncovered.length > 0) {
            req.logger.warn(
              `[OAUTH_AI_TOKEN] would-reject: grant for user ${b4mUserId} via client ${client_id} lacks ` +
                `scope(s): ${uncovered.join(' ')} (grace mode; set OAUTH_AI_TOKEN_ENFORCE_GRANT=true to enforce)`
            );
          }
        }
      }
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

    let minted: Awaited<ReturnType<typeof userApiKeyService.createUserApiKey>>;
    try {
      minted = await userApiKeyService.createUserApiKey(
        b4mUserId,
        {
          name: `AI (federated: ${client.name})`,
          scopes: requestedScopes,
          expiresAt: new Date(Date.now() + AI_TOKEN_TTL_SECONDS * 1000),
          metadata: {
            clientIP: clientIp,
            userAgent,
            createdFrom: 'oauth-exchange',
            oauthClientId: client_id,
          },
        },
        { db: { userApiKeys: userApiKeyRepository, agents: agentRepository } }
      );
    } catch (err) {
      // The per-user active-key cap is a client-visible refusal: answer it in OAuth
      // shape like every other gate above rather than letting baseApi render a bare
      // 400. Any other error is not ours to relabel - rethrow for the generic handler.
      if (err instanceof BadRequestError && err.additionalInfo?.code === API_KEY_USER_CAP_ERROR_CODE) {
        req.logger.warn(
          `[OAUTH_AI_TOKEN] per-user active API key cap reached for user ${b4mUserId} via client ${client_id}`
        );
        return res.status(400).json({ error: 'invalid_request', error_description: err.message });
      }
      throw err;
    }

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
